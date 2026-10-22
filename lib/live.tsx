"use client";

// Live quotes in the browser, modeled on Yahoo Finance's <fin-streamer>:
//
//   * Any component shows a live value with <LivePrice symbol field />, or
//     reads a whole quote with useLiveQuote(symbol).
//   * Only symbols that are on screen are wanted (each LivePrice watches
//     itself with an IntersectionObserver, like Yahoo's streamer), and
//     nothing is wanted while the browser tab is hidden.
//   * The wanted set is sent to Supabase (watch_symbols) at most once a second
//     when it changes and every minute as a heartbeat, so sync-quotes keeps
//     those symbols fresh (~30 s). Changed rows of live_quotes arrive over
//     Supabase Realtime; if the Realtime socket is down, the provider polls
//     live_quotes every 30 s instead.
//   * A changed value flashes green or red, as on Yahoo.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";

export interface LiveQuote {
  symbol: string;
  name: string | null;
  price: number;
  prev_close: number | null;
  change: number | null;
  change_pct: number | null;
  day_high: number | null;
  day_low: number | null;
  volume: number | null;
  market_state: "PRE" | "REGULAR" | "POST" | "CLOSED";
  ext_price: number | null;
  ext_change: number | null;
  ext_change_pct: number | null;
  ext_time: string | null;
  quote_time: string | null;
  updated_at: string;
}

type Listener = () => void;

interface Store {
  get: (s: string) => LiveQuote | undefined;
  want: (s: string) => () => void;
  /** listen to one symbol's quote ("" = status changes) */
  subscribe: (symbol: string, fn: Listener) => () => void;
  status: () => LiveStatus;
}
export type LiveStatus = "connecting" | "live" | "polling" | "paused";

const Ctx = createContext<Store | null>(null);

const COLS =
  "symbol,name,price,prev_close,change,change_pct,day_high,day_low,volume,market_state,ext_price,ext_change,ext_change_pct,ext_time,quote_time,updated_at";
const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function toQuote(r: Record<string, unknown>): LiveQuote {
  const n = (x: unknown) => (x === null || x === undefined ? null : Number(x));
  return {
    symbol: String(r.symbol),
    name: (r.name as string) ?? null,
    price: Number(r.price),
    prev_close: n(r.prev_close),
    change: n(r.change),
    change_pct: n(r.change_pct),
    day_high: n(r.day_high),
    day_low: n(r.day_low),
    volume: n(r.volume),
    market_state: (r.market_state as LiveQuote["market_state"]) ?? "CLOSED",
    ext_price: n(r.ext_price),
    ext_change: n(r.ext_change),
    ext_change_pct: n(r.ext_change_pct),
    ext_time: (r.ext_time as string) ?? null,
    quote_time: (r.quote_time as string) ?? null,
    updated_at: String(r.updated_at ?? ""),
  };
}

export function LiveQuotesProvider({ children }: { children: ReactNode }) {
  const quotes = useRef(new Map<string, LiveQuote>());
  const wanted = useRef(new Map<string, number>()); // symbol -> mounted, visible watchers
  const listeners = useRef(new Map<string, Set<Listener>>()); // symbol ("" = status) -> listeners
  const statusRef = useRef<LiveStatus>("connecting");
  const sentAt = useRef(new Map<string, number>()); // symbol -> when watch_symbols last registered it
  const linger = useRef(new Map<string, ReturnType<typeof setTimeout>>()); // pending releases
  const loaded = useRef(new Set<string>()); // symbols whose current row we've read
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const emit = useCallback((key: string) => listeners.current.get(key)?.forEach((l) => l()), []);
  const setStatus = useCallback(
    (s: LiveStatus) => {
      if (statusRef.current !== s) {
        statusRef.current = s;
        emit("");
      }
    },
    [emit]
  );

  const merge = useCallback(
    (rows: Record<string, unknown>[]) => {
      for (const r of rows) {
        if (!r?.symbol) continue;
        const q = toQuote(r);
        const prev = quotes.current.get(q.symbol);
        if (!prev || prev.updated_at !== q.updated_at || prev.price !== q.price || prev.ext_price !== q.ext_price) {
          quotes.current.set(q.symbol, q);
          emit(q.symbol);
        }
      }
    },
    [emit]
  );

  const read = useCallback(
    async (symbols: string[]) => {
      if (!symbols.length) return;
      for (let i = 0; i < symbols.length; i += 100) {
        const part = symbols.slice(i, i + 100);
        const { data } = await supabase.from("live_quotes").select(COLS).in("symbol", part);
        if (data) merge(data as Record<string, unknown>[]);
        part.forEach((s) => loaded.current.add(s));
      }
    },
    [merge]
  );

  // Register the wanted set (debounced to 1 s, like Yahoo's batched subscribe).
  const flush = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(async () => {
      timer.current = null;
      if (typeof document !== "undefined" && document.hidden) return;
      const syms = Array.from(wanted.current.keys()).filter((s) => SYM_RE.test(s)).sort();
      const fresh = syms.filter((s) => !loaded.current.has(s));
      if (fresh.length) read(fresh).catch(() => {});
      // register only symbols not registered in the last minute (the heartbeat renews the rest)
      const now = Date.now();
      const due = syms.filter((s) => now - (sentAt.current.get(s) ?? 0) > 60_000);
      due.forEach((s) => sentAt.current.set(s, now));
      for (let i = 0; i < due.length; i += 60) {
        await supabase.rpc("watch_symbols", { p_symbols: due.slice(i, i + 60) });
      }
    }, 1000);
  }, [read]);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const startPoll = () => {
      if (poll) return;
      setStatus("polling");
      poll = setInterval(() => read(Array.from(wanted.current.keys())).catch(() => {}), 30_000);
    };
    const stopPoll = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    const connect = () => {
      if (channel) return;
      setStatus("connecting");
      channel = supabase
        .channel("live-quotes")
        .on("postgres_changes", { event: "*", schema: "public", table: "live_quotes" }, (payload) => {
          // keep every row (a few hundred at most); only watchers of that symbol re-render
          const row = payload.new as Record<string, unknown> | undefined;
          if (row?.symbol) merge([row]);
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            stopPoll();
            setStatus("live");
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            startPoll();
          }
        });
    };
    const disconnect = () => {
      if (channel) supabase.removeChannel(channel);
      channel = null;
      stopPoll();
    };

    // Yahoo pauses its stream when the page loses focus; do the same when the tab is hidden.
    const onVis = () => {
      if (document.hidden) {
        disconnect();
        setStatus("paused");
      } else {
        connect();
        sentAt.current.clear();
        loaded.current.clear();
        flush();
      }
    };
    connect();
    document.addEventListener("visibilitychange", onVis);
    const heartbeat = setInterval(() => flush(), 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(heartbeat);
      disconnect();
    };
  }, [flush, merge, read, setStatus]);

  const store = useMemo<Store>(
    () => ({
      get: (s) => quotes.current.get(s),
      want: (s) => {
        const pendingRelease = linger.current.get(s);
        if (pendingRelease) {
          // it scrolled back into view before its release: just cancel the release
          clearTimeout(pendingRelease);
          linger.current.delete(s);
        } else {
          wanted.current.set(s, (wanted.current.get(s) ?? 0) + 1);
          flush();
        }
        return () => {
          // keep a symbol wanted for two minutes after it leaves the screen, so a
          // scrolling ticker or a quick tab switch doesn't churn subscriptions
          const prevTimer = linger.current.get(s);
          if (prevTimer) {
            clearTimeout(prevTimer);
            const n = (wanted.current.get(s) ?? 1) - 1;
            if (n <= 0) wanted.current.delete(s);
            else wanted.current.set(s, n);
          }
          linger.current.set(
            s,
            setTimeout(() => {
              linger.current.delete(s);
              const n = (wanted.current.get(s) ?? 1) - 1;
              if (n <= 0) wanted.current.delete(s);
              else wanted.current.set(s, n);
            }, 120_000)
          );
        };
      },
      subscribe: (symbol, fn) => {
        let set = listeners.current.get(symbol);
        if (!set) listeners.current.set(symbol, (set = new Set()));
        set.add(fn);
        return () => {
          set!.delete(fn);
        };
      },
      status: () => statusRef.current,
    }),
    [flush]
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

const noop = () => () => {};

/**
 * The live quote for one symbol, or undefined until the first row arrives.
 * `enabled` lets a caller stop watching (e.g. while scrolled out of view).
 */
export function useLiveQuote(symbol: string | null | undefined, enabled = true): LiveQuote | undefined {
  const store = useContext(Ctx);
  const s = symbol ? symbol.toUpperCase() : "";
  useEffect(() => {
    if (!store || !s || !enabled) return;
    return store.want(s);
  }, [store, s, enabled]);
  const sub = useCallback((fn: Listener) => (store && s ? store.subscribe(s, fn) : () => {}), [store, s]);
  return useSyncExternalStore(
    store && s ? sub : noop,
    () => (store && s ? store.get(s) : undefined),
    () => undefined
  );
}

export function useLiveStatus(): LiveStatus | null {
  const store = useContext(Ctx);
  const sub = useCallback((fn: Listener) => (store ? store.subscribe("", fn) : () => {}), [store]);
  return useSyncExternalStore(store ? sub : noop, () => (store ? store.status() : null), () => null);
}

/** True while the element is on screen (always true where IntersectionObserver is missing). */
export function useOnScreen<T extends Element>(): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver((es) => setOn(es.some((e) => e.isIntersecting)), { rootMargin: "100px" });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return [setEl, on];
}

// ---------------------------------------------------------------- formatting
export type LiveField = "price" | "change" | "change_pct" | "change_both" | "ext_price" | "ext_change_pct";

export function fmtPrice(v: number | null | undefined, hint = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const d = Math.abs(v) < 1 ? 4 : hint;
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtSigned(v: number | null | undefined, d = 2, suffix = "") {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(d) + suffix;
}

/**
 * One live number, like Yahoo's <fin-streamer data-field="...">. Shows the
 * server-rendered `fallback` until a live value arrives, only subscribes
 * while on screen, and flashes when the value changes.
 */
export function LivePrice({
  symbol,
  field = "price",
  fallback,
  fallbackChange,
  className = "",
  colorize,
  arrow = false,
}: {
  symbol: string;
  field?: LiveField;
  /** value to show before the first live quote (server-rendered close) */
  fallback?: number | null;
  /** sign to colour by before the first live quote */
  fallbackChange?: number | null;
  className?: string;
  /** colour green/red by the day's change (default: on for change fields) */
  colorize?: boolean;
  arrow?: boolean;
}) {
  const [ref, onScreen] = useOnScreen<HTMLSpanElement>();
  const q = useLiveQuote(symbol, onScreen);
  const ext = field === "ext_price" || field === "ext_change_pct";

  let text = "—";
  let sign = q ? (ext ? q.ext_change ?? 0 : q.change ?? 0) : fallbackChange ?? 0;
  let value: number | null = null;
  if (q) {
    switch (field) {
      case "price":
        value = q.price;
        text = fmtPrice(q.price);
        break;
      case "change":
        value = q.change;
        text = fmtSigned(q.change);
        break;
      case "change_pct":
        value = q.change_pct;
        text = fmtSigned(q.change_pct, 2, "%");
        break;
      case "change_both":
        value = q.change_pct;
        text = `${fmtSigned(q.change)} (${fmtSigned(q.change_pct, 2, "%")})`;
        break;
      case "ext_price":
        value = q.ext_price;
        text = fmtPrice(q.ext_price);
        break;
      case "ext_change_pct":
        value = q.ext_change_pct;
        text = q.ext_change_pct === null ? "" : `${fmtSigned(q.ext_change)} (${fmtSigned(q.ext_change_pct, 2, "%")})`;
        break;
    }
  } else if (fallback !== undefined && fallback !== null) {
    value = fallback;
    text = field === "price" || field === "ext_price" ? fmtPrice(fallback) : field === "change" ? fmtSigned(fallback) : fmtSigned(fallback, 2, "%");
    sign = fallbackChange ?? fallback;
  }

  // flash on change
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<"" | "up" | "down">("");
  useEffect(() => {
    if (value === null || value === undefined) return;
    if (prev.current !== null && value !== prev.current) {
      setFlash(value > prev.current ? "up" : "down");
      const t = setTimeout(() => setFlash(""), 900);
      prev.current = value;
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);

  const color = (colorize ?? field !== "price") ? (sign > 0 ? "text-term-green" : sign < 0 ? "text-term-red" : "text-term-dim") : "";
  return (
    <span
      ref={ref}
      data-symbol={symbol}
      data-field={field}
      className={`tabular-nums transition-colors ${color} ${flash === "up" ? "live-flash-up" : flash === "down" ? "live-flash-down" : ""} ${className}`}
    >
      {arrow && text !== "—" && text !== "" ? (sign >= 0 ? "▲ " : "▼ ") : ""}
      {text}
    </span>
  );
}

/** "Pre-market", "After hours" or "" for a quote, as Yahoo labels the second price line. */
export function extLabel(q: LiveQuote | undefined): string {
  if (!q || q.ext_price === null) return "";
  if (q.market_state === "PRE") return "Pre-market";
  return "After hours";
}

/** Yahoo's second price line: "After hours 348.45 +0.23 (+0.07%)" when there's an extended-hours print. */
export function LiveExtLine({ symbol, className = "" }: { symbol: string; className?: string }) {
  const [ref, onScreen] = useOnScreen<HTMLSpanElement>();
  const q = useLiveQuote(symbol, onScreen);
  const label = extLabel(q);
  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {q && label && q.ext_price !== null ? (
        <>
          <span className="uppercase text-term-dim">{label}</span> <span className="text-term-text">{fmtPrice(q.ext_price)}</span>{" "}
          <span className={(q.ext_change ?? 0) >= 0 ? "text-term-green" : "text-term-red"}>{fmtSigned(q.ext_change_pct, 2, "%")}</span>
        </>
      ) : q?.market_state === "REGULAR" ? (
        <span className="text-term-green">● market open</span>
      ) : null}
    </span>
  );
}
