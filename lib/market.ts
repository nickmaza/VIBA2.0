// Server-side daily price history for any ticker, used by the Plays board and
// the Chart & Search tab (through /api/bars and /api/search).
//
// Source order for bars:
//   1. Supabase raw_prices  -- the pipeline's own OHLCV, when the symbol is tracked
//   2. Yahoo Finance chart  -- public, keyless; covers any US stock or ETF
//   3. Stooq daily CSV      -- keyless fallback if Yahoo refuses the request
//   4. Bundled snapshot     -- lib/snapshot-bars.json (the plays + watchlist)
// Every response says which source it came from so the UI can label it.
import { supabase, hasSupabase } from "./supabase";
import snapshot from "./snapshot-bars.json";
import { PLAY_NAMES } from "./plays";
import { INSTRUMENTS } from "./instruments";
import type { Bars } from "./ta";

export type BarSource = "supabase" | "yahoo" | "stooq" | "snapshot";

export interface BarsResult {
  symbol: string;
  name: string | null;
  bars: Bars;
  source: BarSource;
}

export interface SymbolHit {
  symbol: string;
  name: string;
  type: string; // "Stock" | "ETF"
}

const SNAP = snapshot as Record<string, Bars>;
export const SNAPSHOT_SYMBOLS = Object.keys(SNAP);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const LOOKBACK_DAYS = 760; // ~2 years: enough for a 200-day average across the whole visible year
const CACHE_SECONDS = 900;

const KNOWN_NAMES: Record<string, string> = {
  ...Object.fromEntries(INSTRUMENTS.map((i) => [i.symbol, i.name])),
  ...PLAY_NAMES,
};

export function cleanSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9.\-^]/g, "").slice(0, 12);
}

function emptyBars(): Bars {
  return { t: [], o: [], h: [], l: [], c: [], v: [] };
}

function pushBar(b: Bars, t: string, o: number, h: number, l: number, c: number, v: number) {
  if (b.t.length && b.t[b.t.length - 1] === t) {
    // same session twice (can happen with provider gap-fill): keep the later one
    b.o.pop(); b.h.pop(); b.l.pop(); b.c.pop(); b.v.pop(); b.t.pop();
  }
  b.t.push(t);
  b.o.push(o);
  b.h.push(Math.max(h, o, c));
  b.l.push(Math.min(l, o, c));
  b.c.push(c);
  b.v.push(Number.isFinite(v) ? v : 0);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fromSupabase(symbol: string): Promise<Bars | null> {
  if (!hasSupabase || !supabase) return null;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("raw_prices")
    .select("date,open,high,low,close,volume")
    .eq("symbol", symbol)
    .gte("date", since)
    .order("date")
    .limit(1000);
  if (error || !data || data.length < 120) return null;
  const rows = data as Record<string, unknown>[];
  // Levels and ATR need real highs/lows; the old close-only history can't drive them.
  const withHL = rows.filter((r) => num(r.high) !== null && num(r.low) !== null).length;
  if (withHL < rows.length * 0.8) return null;
  const b = emptyBars();
  for (const r of rows) {
    const c = num(r.close);
    if (c === null) continue;
    const o = num(r.open) ?? c;
    pushBar(b, String(r.date).slice(0, 10), o, num(r.high) ?? Math.max(o, c), num(r.low) ?? Math.min(o, c), c, num(r.volume) ?? 0);
  }
  return b.c.length >= 120 ? b : null;
}

async function fromYahoo(symbol: string): Promise<{ bars: Bars; name: string | null } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&includePrePost=false`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    next: { revalidate: CACHE_SECONDS },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  const ts: number[] | undefined = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!ts || !q) return null;
  const off = num(r.meta?.gmtoffset) ?? -14400;
  const b = emptyBars();
  for (let i = 0; i < ts.length; i++) {
    const o = num(q.open?.[i]), h = num(q.high?.[i]), l = num(q.low?.[i]), c = num(q.close?.[i]);
    if (o === null || h === null || l === null || c === null) continue;
    const d = new Date((ts[i] + off) * 1000).toISOString().slice(0, 10);
    pushBar(b, d, o, h, l, c, num(q.volume?.[i]) ?? 0);
  }
  if (b.c.length < 60) return null;
  const name = (r.meta?.longName as string) || (r.meta?.shortName as string) || null;
  return { bars: b, name };
}

async function fromStooq(symbol: string): Promise<Bars | null> {
  const s = symbol.toLowerCase().replace(/\./g, "-");
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}.us&i=d`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, next: { revalidate: CACHE_SECONDS }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (!/^date,open,high,low,close/i.test(lines[0] ?? "")) return null;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
  const b = emptyBars();
  for (const line of lines.slice(1)) {
    const [d, o, h, l, c, v] = line.split(",");
    if (!d || d < since) continue;
    const on = num(o), hn = num(h), ln = num(l), cn = num(c);
    if (on === null || hn === null || ln === null || cn === null) continue;
    pushBar(b, d, on, hn, ln, cn, num(v) ?? 0);
  }
  return b.c.length >= 60 ? b : null;
}

async function safe<T>(p: () => Promise<T | null>): Promise<T | null> {
  try {
    return await p();
  } catch {
    return null;
  }
}

/** Two years of daily OHLCV for one symbol, from the best source that answers. */
export async function getBars(rawSymbol: string, opts: { allowNetwork?: boolean } = {}): Promise<BarsResult | null> {
  const symbol = cleanSymbol(rawSymbol);
  if (!symbol) return null;
  const allowNetwork = opts.allowNetwork ?? true;

  const sb = await safe(() => fromSupabase(symbol));
  if (sb) return { symbol, name: KNOWN_NAMES[symbol] ?? null, bars: sb, source: "supabase" };

  if (allowNetwork) {
    const y = await safe(() => fromYahoo(symbol));
    if (y) return { symbol, name: KNOWN_NAMES[symbol] ?? y.name, bars: y.bars, source: "yahoo" };
    const st = await safe(() => fromStooq(symbol));
    if (st) return { symbol, name: KNOWN_NAMES[symbol] ?? null, bars: st, source: "stooq" };
  }

  const snap = SNAP[symbol];
  if (snap) return { symbol, name: KNOWN_NAMES[symbol] ?? null, bars: snap, source: "snapshot" };
  return null;
}

/** Ticker / company-name search. Local names first, then Yahoo's symbol search. */
export async function searchSymbols(q: string): Promise<SymbolHit[]> {
  const query = q.trim();
  if (!query) return [];
  const up = query.toUpperCase();
  const local: SymbolHit[] = Object.entries(KNOWN_NAMES)
    .filter(([s, n]) => s.startsWith(up) || n.toUpperCase().includes(up))
    .slice(0, 6)
    .map(([s, n]) => ({ symbol: s, name: n, type: /ETF|SPDR|Direxion|ProShares|iShares|Invesco/i.test(n) ? "ETF" : "Stock" }));

  const remote = await safe(async () => {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const quotes = (j?.quotes ?? []) as Record<string, unknown>[];
    return quotes
      .filter((x) => (x.quoteType === "EQUITY" || x.quoteType === "ETF") && typeof x.symbol === "string" && !String(x.symbol).includes("."))
      .map((x) => ({
        symbol: String(x.symbol),
        name: String(x.longname ?? x.shortname ?? x.symbol),
        type: x.quoteType === "ETF" ? "ETF" : "Stock",
      }));
  });

  const seen = new Set<string>();
  const out: SymbolHit[] = [];
  for (const h of [...local, ...(remote ?? [])]) {
    if (seen.has(h.symbol)) continue;
    seen.add(h.symbol);
    out.push(h);
  }
  return out.slice(0, 10);
}
