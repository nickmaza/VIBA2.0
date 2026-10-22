"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, IPriceLine, ISeriesApi, SeriesType, Time, MouseEventParams, UTCTimestamp } from "lightweight-charts";
import { analyze, isAnalysis, money, type Analysis, type Bars } from "@/lib/ta";
import {
  INDICATOR_BY_ID,
  DEFAULT_INDICATORS,
  MA_COLORS,
  type ActiveIndicator,
  type IndicatorDef,
  type IndicatorResult,
  type OHLCV,
  type OutLine,
} from "@/lib/indicators";
import { useLiveQuote, extLabel, fmtPrice, fmtSigned, type LiveQuote } from "@/lib/live";
import type { IntradayResult } from "@/lib/market";
import Panel, { Chip } from "@/components/Panel";
import SetupBlock, { NoSetup, StatusChip } from "@/components/SetupBlock";
import IndicatorMenu from "@/components/IndicatorMenu";
import NewsFeed from "@/components/NewsFeed";

interface Loaded {
  symbol: string;
  name: string | null;
  bars: Bars;
  source: "supabase";
  asOf: string;
  refreshed?: boolean; // fetch-bars pulled fresh bars from the market for this request
}
interface Hit {
  symbol: string;
  name: string;
  type: string;
}

const C = {
  panel: "#141414",
  grid: "#222222",
  border: "#3a3a3a",
  text: "#e6e6e6",
  dim: "#9c9c9c",
  green: "#3fbf4a",
  red: "#e5453c",
  cyan: "#4fb3e8",
  amber: "#f5c542",
  yellow: "#f5d033",
};

// Range chips map to an interval the way Yahoo's chart does (1D -> 1 min,
// 5D -> 5 min, 1M -> 30 min, longer -> daily); the interval menu overrides.
type ViewKey = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y" | "All";
const VIEWS: { key: ViewKey; interval: string; range?: string; bars?: number }[] = [
  { key: "1D", interval: "1m", range: "1d" },
  { key: "5D", interval: "5m", range: "5d" },
  { key: "1M", interval: "30m", range: "1mo" },
  { key: "3M", interval: "1d", bars: 63 },
  { key: "6M", interval: "1d", bars: 126 },
  { key: "1Y", interval: "1d", bars: 252 },
  { key: "All", interval: "1d", bars: 0 },
];
const INTERVALS = [
  { id: "1m", label: "1 min", sec: 60, range: "1d" },
  { id: "2m", label: "2 min", sec: 120, range: "1d" },
  { id: "5m", label: "5 min", sec: 300, range: "5d" },
  { id: "15m", label: "15 min", sec: 900, range: "5d" },
  { id: "30m", label: "30 min", sec: 1800, range: "1mo" },
  { id: "60m", label: "1 hour", sec: 3600, range: "3mo" },
  { id: "1d", label: "1 day", sec: 86400, range: "" },
] as const;
const SYM_RE = /^#chart\/([A-Za-z0-9.\-^]+)/;
const IND_KEY = "viba-indicators-v1";
// overlays allowed to widen the price autoscale (bands and stops); the rest follow price
const AUTOSCALE_OVERLAYS = new Set(["bb", "keltner", "donchian", "maenv", "psar", "supertrend"]);
const MAX_SUBS = 4;

function pct(v: number, d = 1) {
  return (v >= 0 ? "+" : "") + v.toFixed(d) + "%";
}
function rgba(hex: string, a: number) {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
function fmtVol(v: number) {
  return v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(0) + "K" : String(Math.round(v));
}
function fmtVal(v: number | null | undefined) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  return a >= 1e6 ? fmtVol(v) : a >= 1000 ? v.toFixed(0) : a >= 1 ? v.toFixed(2) : v.toFixed(4);
}
const nyDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));

// ---------------------------------------------------------------- chart data
interface ChartBars extends OHLCV {
  time: Time[];
  intraday: boolean;
}

function fromDaily(b: Bars): ChartBars {
  return { time: b.t as Time[], day: b.t.slice(), o: b.o.slice(), h: b.h.slice(), l: b.l.slice(), c: b.c.slice(), v: b.v.slice(), intraday: false };
}
function fromIntraday(r: IntradayResult): ChartBars {
  // shift UTC by the exchange offset so the axis reads New York time, as Yahoo's does
  const shifted = r.t.map((t) => t + r.gmtoffset);
  return {
    time: shifted as UTCTimestamp[],
    day: shifted.map((t) => new Date(t * 1000).toISOString().slice(0, 10)),
    o: r.o.slice(),
    h: r.h.slice(),
    l: r.l.slice(),
    c: r.c.slice(),
    v: r.v.slice(),
    intraday: true,
  };
}

/** Fold the latest live quote into the last bar (or open a new one), like Yahoo's streamed candle. */
function applyTick(cb: ChartBars, q: LiveQuote | undefined, stepSec: number, intra: IntradayResult | null): ChartBars {
  if (!q || !cb.c.length) return cb;
  const n = cb.c.length - 1;
  const out: ChartBars = { ...cb, time: cb.time.slice(), day: cb.day.slice(), o: cb.o.slice(), h: cb.h.slice(), l: cb.l.slice(), c: cb.c.slice(), v: cb.v.slice() };
  if (!cb.intraday) {
    if (!q.quote_time) return cb;
    const qd = nyDate(q.quote_time);
    const ld = cb.day[n];
    const hi = Math.max(q.day_high ?? q.price, q.price);
    const lo = Math.min(q.day_low ?? q.price, q.price);
    if (qd === ld) {
      out.c[n] = q.price;
      out.h[n] = Math.max(out.h[n], hi);
      out.l[n] = Math.min(out.l[n], lo);
      if (q.volume) out.v[n] = Math.max(out.v[n], q.volume);
      return out;
    }
    if (qd > ld) {
      const o = q.prev_close ?? q.price;
      out.time.push(qd as Time);
      out.day.push(qd);
      out.o.push(o);
      out.h.push(Math.max(hi, o));
      out.l.push(Math.min(lo, o));
      out.c.push(q.price);
      out.v.push(q.volume ?? 0);
      return out;
    }
    return cb;
  }
  if (!intra) return cb;
  const useExt = q.market_state !== "REGULAR" && q.ext_price !== null && q.ext_time;
  const price = useExt ? (q.ext_price as number) : q.price;
  const when = useExt ? q.ext_time : q.quote_time;
  if (!when) return cb;
  const ts = Math.floor(Date.parse(when) / 1000);
  const anchor = intra.regular?.start ?? 0;
  const bucket = anchor + Math.floor((ts - anchor) / stepSec) * stepSec + intra.gmtoffset;
  const last = Number(cb.time[n]);
  if (bucket === last) {
    out.c[n] = price;
    out.h[n] = Math.max(out.h[n], price);
    out.l[n] = Math.min(out.l[n], price);
    return out;
  }
  if (bucket > last && bucket - last < 3 * 86400) {
    out.time.push(bucket as UTCTimestamp);
    out.day.push(new Date(bucket * 1000).toISOString().slice(0, 10));
    out.o.push(price);
    out.h.push(price);
    out.l.push(price);
    out.c.push(price);
    out.v.push(0);
    return out;
  }
  return cb;
}

function lineColor(a: ActiveIndicator, all: ActiveIndicator[], line: OutLine, li: number): string {
  if (a.id === "ma" && li === 0) {
    const k = all.filter((x) => x.id === "ma").findIndex((x) => x.uid === a.uid);
    return MA_COLORS[k % MA_COLORS.length];
  }
  return line.color;
}

interface BuiltInd {
  uid: string;
  def: IndicatorDef;
  series: ISeriesApi<"Line" | "Histogram">[];
  sub: number; // -1 = price pane
}
interface Built {
  chart: IChartApi;
  main: ISeriesApi<SeriesType>;
  vol: ISeriesApi<"Histogram">;
  inds: BuiltInd[];
}

/**
 * Search any US stock or ETF and chart it like Yahoo Finance's interactive
 * chart: 1D/5D/1M intraday (1 min - 1 hour, with pre/post-market) or daily,
 * the newest candle moving with the live quote stream, every indicator from
 * the indicator menu (computed in the browser), plus the setup engine's
 * levels and trade plan (lib/ta.ts) and the symbol's live news.
 */
export default function ChartSearch({ defaultSymbol, quick }: { defaultSymbol: string; quick: string[] }) {
  // ---------- search ----------
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState(0);

  // ---------- loaded symbol ----------
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);

  // ---------- chart options ----------
  const [view, setView] = useState<ViewKey | null>("6M");
  const [interval, setIntervalId] = useState<string>("1d");
  const [range, setRange] = useState<string>("");
  const [dailyBars, setDailyBars] = useState(126);
  const [style, setStyle] = useState<"candle" | "bar">("candle");
  const [showLv, setShowLv] = useState(true);
  const [showPlan, setShowPlan] = useState(true);
  const [indicators, setIndicators] = useState<ActiveIndicator[]>(DEFAULT_INDICATORS);
  const [intra, setIntra] = useState<{ key: string; res: IntradayResult } | null>(null);
  const [intraErr, setIntraErr] = useState<string | null>(null);
  const [intraLoading, setIntraLoading] = useState(false);

  // remembered indicators
  useEffect(() => {
    try {
      const raw = localStorage.getItem(IND_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as ActiveIndicator[];
        if (Array.isArray(arr)) setIndicators(arr.filter((a) => a && INDICATOR_BY_ID.has(a.id)));
      }
    } catch {}
  }, []);
  const changeIndicators = (next: ActiveIndicator[]) => {
    // keep at most MAX_SUBS lower panes
    let subs = 0;
    const kept = next.filter((a) => INDICATOR_BY_ID.get(a.id)?.pane !== "sub" || ++subs <= MAX_SUBS);
    setIndicators(kept);
    try {
      localStorage.setItem(IND_KEY, JSON.stringify(kept));
    } catch {}
  };

  const result = useMemo(() => (data ? analyze(data.bars) : null), [data]);
  const A: Analysis | null = result && isAnalysis(result) ? result : null;
  const setup = A ? A.setups[sel] ?? null : null;

  const loadSeq = useRef(0);
  const load = useCallback(async (raw: string, setHash = true) => {
    const sym = raw.trim().toUpperCase();
    if (!sym) return;
    const my = ++loadSeq.current;
    setLoading(sym);
    setError(null);
    setOpen(false);
    setQ(sym);
    // Only user-initiated loads rewrite the URL; the initial default load must
    // not, or it would pull the whole workspace onto the Chart tab.
    if (setHash) {
      try {
        history.replaceState(null, "", `#chart/${sym}`);
      } catch {}
    }
    try {
      const res = await fetch(`/api/bars?symbol=${encodeURIComponent(sym)}`);
      const j = await res.json();
      if (my !== loadSeq.current) return;
      if (!res.ok) throw new Error(j?.error || `Couldn't load ${sym}.`);
      setData(j as Loaded);
      setSel(0);
    } catch (e) {
      if (my !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : `Couldn't load ${sym}.`);
    } finally {
      if (my === loadSeq.current) setLoading(null);
    }
  }, []);

  // hash deep links (#chart/NVDA) from play cards and news, and the initial symbol
  useEffect(() => {
    const onHash = () => {
      const m = window.location.hash.match(SYM_RE);
      if (m) load(m[1], false);
    };
    const m = window.location.hash.match(SYM_RE);
    load(m ? m[1] : defaultSymbol, false);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [load, defaultSymbol]);

  // debounced symbol search
  useEffect(() => {
    const query = q.trim();
    if (!query || query === data?.symbol) {
      setHits([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: ctl.signal });
        const j = await res.json();
        setHits((j?.results ?? []) as Hit[]);
        setAct(0);
      } catch {
        /* aborted or offline: keep the typed ticker as the fallback */
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, data?.symbol]);

  const submit = () => {
    if (open && hits[act]) return load(hits[act].symbol);
    load(q.replace(/[^A-Za-z0-9.\-^]/g, ""));
  };

  // ---------- view / interval ----------
  const pickView = (v: (typeof VIEWS)[number]) => {
    setView(v.key);
    setIntervalId(v.interval);
    if (v.range) setRange(v.range);
    if (v.bars !== undefined) setDailyBars(v.bars);
  };
  const pickInterval = (id: string) => {
    const spec = INTERVALS.find((x) => x.id === id);
    if (!spec) return;
    setIntervalId(id);
    if (id === "1d") {
      setView("6M");
      setDailyBars(126);
    } else {
      setRange(spec.range);
      setView(VIEWS.find((v) => v.interval === id && v.range === spec.range)?.key ?? null);
    }
  };
  const isIntraday = interval !== "1d";
  const stepSec = INTERVALS.find((x) => x.id === interval)?.sec ?? 86400;

  // intraday bars: fetched on demand and refreshed every 2 minutes while shown
  const intraKey = data && isIntraday ? `${data.symbol}|${interval}|${range}` : "";
  useEffect(() => {
    if (!intraKey) return;
    let live = true;
    const [sym, iv, rg] = intraKey.split("|");
    const get = async (first: boolean) => {
      if (first) setIntraLoading(true);
      try {
        const res = await fetch(`/api/intraday?symbol=${encodeURIComponent(sym)}&interval=${iv}&range=${rg}`);
        const j = await res.json();
        if (!live) return;
        if (!res.ok) throw new Error(j?.error || `Couldn't load ${iv} bars for ${sym}.`);
        setIntra({ key: intraKey, res: j as IntradayResult });
        setIntraErr(null);
      } catch (e) {
        if (live && first) setIntraErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (live && first) setIntraLoading(false);
      }
    };
    get(true);
    const t = setInterval(() => {
      if (!document.hidden) get(false);
    }, 120_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [intraKey]);

  // ---------- live quote ----------
  const quote = useLiveQuote(data?.symbol);
  const intraRes = intra && intra.key === intraKey ? intra.res : null;
  const baseBars = useMemo<ChartBars | null>(() => {
    if (!data) return null;
    if (isIntraday) return intraRes ? fromIntraday(intraRes) : null;
    return fromDaily(data.bars);
  }, [data, isIntraday, intraRes]);
  const cb = useMemo(() => (baseBars ? applyTick(baseBars, quote, stepSec, intraRes) : null), [baseBars, quote, stepSec, intraRes]);

  // ---------- chart ----------
  const boxRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const subLegendRefs = useRef<(HTMLDivElement | null)[]>([]);
  const builtRef = useRef<Built | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const planRef = useRef<{ lo: number; hi: number } | null>(null);
  const cbRef = useRef<ChartBars | null>(null);
  const resultsRef = useRef<Map<string, IndicatorResult>>(new Map());
  const [chartErr, setChartErr] = useState<string | null>(null);
  const [chartTick, setChartTick] = useState(0);
  const [mainH, setMainH] = useState(440);
  cbRef.current = cb;
  const indRef = useRef(indicators);
  indRef.current = indicators;

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const f = () => setMainH(mq.matches ? 330 : 440);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);

  const subs = indicators.filter((a) => INDICATOR_BY_ID.get(a.id)?.pane === "sub");
  const SUB_H = mainH < 400 ? 100 : 120;
  const totalH = mainH + subs.length * SUB_H;

  const compute = useCallback((bars: ChartBars) => {
    const m = new Map<string, IndicatorResult>();
    for (const a of indRef.current) {
      const def = INDICATOR_BY_ID.get(a.id);
      if (!def) continue;
      try {
        m.set(a.uid, def.compute(bars, a.params));
      } catch {
        m.set(a.uid, { lines: [] });
      }
    }
    return m;
  }, []);

  const writeLegend = useCallback((i: number) => {
    const b = cbRef.current;
    const el = legendRef.current;
    if (!b || !el) return;
    if (i < 0 || i >= b.c.length) i = b.c.length - 1;
    const pc = i > 0 ? b.c[i - 1] : b.o[i];
    const ch = (b.c[i] / pc - 1) * 100;
    const t = b.time[i];
    const label = b.intraday
      ? new Date(Number(t) * 1000).toISOString().slice(5, 16).replace("T", " ")
      : String(t);
    const overlays: string[] = [];
    for (const a of indRef.current) {
      const def = INDICATOR_BY_ID.get(a.id);
      const r = resultsRef.current.get(a.uid);
      if (!def || !r || def.pane !== "price") continue;
      const vals = r.lines.slice(0, 3).map((ln, li) => `<span style="color:${lineColor(a, indRef.current, ln, li)}">${fmtVal(ln.values[i])}</span>`);
      overlays.push(`${def.short(a.params)} ${vals.join(" ")}`);
    }
    el.innerHTML =
      `${label}&nbsp;&nbsp;O ${b.o[i].toFixed(2)}&nbsp;&nbsp;H ${b.h[i].toFixed(2)}&nbsp;&nbsp;L ${b.l[i].toFixed(2)}&nbsp;&nbsp;C ${b.c[i].toFixed(2)}` +
      `&nbsp;&nbsp;<span style="color:${ch >= 0 ? C.green : C.red}">${pct(ch, 2)}</span>&nbsp;&nbsp;Vol ${fmtVol(b.v[i])}` +
      (overlays.length ? `<br/>${overlays.join("&nbsp;&nbsp;·&nbsp;&nbsp;")}` : "");
    let k = 0;
    for (const a of indRef.current) {
      const def = INDICATOR_BY_ID.get(a.id);
      if (!def || def.pane !== "sub") continue;
      const r = resultsRef.current.get(a.uid);
      const sl = subLegendRefs.current[k++];
      if (!sl || !r) continue;
      sl.innerHTML =
        `<b style="color:${C.text}">${def.short(a.params)}</b>&nbsp;&nbsp;` +
        r.lines.map((ln, li) => `<span style="color:${lineColor(a, indRef.current, ln, li)}">${ln.label} ${fmtVal(ln.values[i])}</span>`).join("&nbsp;&nbsp;");
    }
  }, []);

  // push bars + recomputed indicators into the existing series (no rebuild, zoom kept)
  const pushData = useCallback(() => {
    const built = builtRef.current;
    const b = cbRef.current;
    if (!built || !b) return;
    const results = compute(b);
    resultsRef.current = results;
    built.main.setData(b.time.map((time, i) => ({ time, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i] })));
    built.vol.setData(b.time.map((time, i) => ({ time, value: b.v[i], color: rgba(b.c[i] >= b.o[i] ? C.green : C.red, 0.35) })));
    for (const bi of built.inds) {
      const r = results.get(bi.uid);
      bi.series.forEach((s, li) => {
        const ln = r?.lines[li];
        if (!ln) return s.setData([]);
        s.setData(
          b.time.map((time, i) => {
            const v = ln.values[i];
            if (v === null || v === undefined || !Number.isFinite(v)) return { time };
            return ln.colors && ln.colors[i] ? { time, value: v, color: ln.colors[i] as string } : { time, value: v };
          })
        );
      });
    }
    writeLegend(-1);
  }, [compute, writeLegend]);

  const dataKey = !cb ? "" : cb.intraday ? `i|${intraKey}` : `d|${data?.symbol}|${data?.asOf}`;
  const indKey = JSON.stringify(indicators.map((a) => [a.uid, a.id, a.params]));

  // build / rebuild the chart when the dataset, bar style or indicator set changes
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !dataKey) return;
    let disposed = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      let lc: typeof import("lightweight-charts");
      try {
        lc = await import("lightweight-charts");
      } catch {
        setChartErr("The chart library failed to load. The setup and levels below are still complete.");
        return;
      }
      if (disposed || !cbRef.current) return;
      setChartErr(null);
      const intraday = cbRef.current.intraday;
      const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-plex-mono").trim() || "monospace";
      const H = el.clientHeight || totalH;
      const subList = indRef.current.filter((a) => INDICATOR_BY_ID.get(a.id)?.pane === "sub");
      const subPx = subList.length * SUB_H;
      const chart = lc.createChart(el, {
        autoSize: true,
        localization: { locale: "en-US" },
        layout: { background: { type: lc.ColorType.Solid, color: C.panel }, textColor: C.dim, fontFamily: `${mono}, monospace`, fontSize: 11 },
        grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
        rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.05 * (mainH / H), bottom: (subPx + mainH * 0.2) / H } },
        timeScale: { borderColor: C.border, rightOffset: 8, barSpacing: intraday ? 4 : 6, timeVisible: intraday, secondsVisible: false },
        crosshair: {
          mode: lc.CrosshairMode.Normal,
          vertLine: { color: C.dim, labelBackgroundColor: "#2b2b2b" },
          horzLine: { color: C.dim, labelBackgroundColor: "#2b2b2b" },
        },
      });
      const autoscale = (orig: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const r = orig();
        const p = planRef.current;
        if (r && p) {
          r.priceRange.minValue = Math.min(r.priceRange.minValue, p.lo);
          r.priceRange.maxValue = Math.max(r.priceRange.maxValue, p.hi);
        }
        return r;
      };
      const main =
        style === "candle"
          ? chart.addCandlestickSeries({
              upColor: C.green,
              downColor: C.red,
              wickUpColor: C.green,
              wickDownColor: C.red,
              borderVisible: false,
              priceLineVisible: true,
              priceLineColor: C.cyan,
              autoscaleInfoProvider: autoscale,
            })
          : chart.addBarSeries({ upColor: C.green, downColor: C.red, thinBars: false, priceLineVisible: true, priceLineColor: C.cyan, autoscaleInfoProvider: autoscale });

      const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: (mainH * 0.84) / H, bottom: subPx / H } });

      // indicators: overlays on the price scale, oscillators each in their own lower pane
      const results = compute(cbRef.current);
      const inds: BuiltInd[] = [];
      let subIdx = 0;
      for (const a of indRef.current) {
        const def = INDICATOR_BY_ID.get(a.id);
        const r = results.get(a.uid);
        if (!def || !r) continue;
        const sub = def.pane === "sub" ? subIdx++ : -1;
        const scaleId = sub >= 0 ? `sub${sub}` : "right";
        const series = r.lines.map((ln, li) => {
          const color = lineColor(a, indRef.current, ln, li);
          const common = {
            priceScaleId: scaleId,
            priceLineVisible: false,
            lastValueVisible: false,
            ...(sub < 0 && !AUTOSCALE_OVERLAYS.has(a.id) ? { autoscaleInfoProvider: () => null } : {}),
          };
          if (ln.style === "histogram") return chart.addHistogramSeries({ ...common, color }) as ISeriesApi<"Line" | "Histogram">;
          return chart.addLineSeries({
            ...common,
            color,
            lineWidth: ln.width ?? 1,
            lineStyle: ln.style === "dashed" ? 2 : 0,
            lineVisible: ln.style !== "dots",
            pointMarkersVisible: ln.style === "dots",
            pointMarkersRadius: 1.6,
            crosshairMarkerVisible: sub >= 0,
          }) as ISeriesApi<"Line" | "Histogram">;
        });
        if (sub >= 0) {
          chart.priceScale(scaleId).applyOptions({
            scaleMargins: { top: (mainH + sub * SUB_H + 18) / H, bottom: Math.max(0, H - (mainH + (sub + 1) * SUB_H) + 6) / H },
          });
          const anchor = series.find((s) => s.seriesType() === "Line") ?? series[0];
          for (const lvl of r.levels ?? []) anchor?.createPriceLine({ price: lvl, color: "#4a4a4a", lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: "" });
        }
        inds.push({ uid: a.uid, def, series, sub });
      }
      builtRef.current = { chart, main: main as ISeriesApi<SeriesType>, vol, inds };
      pushData();

      chart.subscribeCrosshairMove((p: MouseEventParams) => {
        const b = cbRef.current;
        if (!b) return;
        const idx = p.time === undefined ? -1 : b.time.findIndex((t) => String(t) === String(p.time));
        writeLegend(idx);
      });

      // apply the visible range once the (possibly hidden) tab has a real width
      ro = new ResizeObserver(() => {
        if (el.clientWidth > 0) setChartTick((n) => n + 1);
      });
      ro.observe(el);
      setChartTick((n) => n + 1);
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      builtRef.current?.chart.remove();
      builtRef.current = null;
      linesRef.current = [];
    };
    // rebuild only when the dataset, style, indicator set or layout height changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, style, indKey, totalH]);

  // live ticks and refreshed intraday bars: update in place
  useEffect(() => {
    pushData();
  }, [cb, pushData]);

  // visible range
  const rangeKey = `${dataKey}|${dailyBars}`;
  const appliedRange = useRef("");
  useEffect(() => {
    const built = builtRef.current;
    const b = cbRef.current;
    if (!built || !b || !boxRef.current?.clientWidth) return;
    if (appliedRange.current === rangeKey) return;
    appliedRange.current = rangeKey;
    const n = b.c.length;
    if (b.intraday || !dailyBars || dailyBars >= n) built.chart.timeScale().fitContent();
    else built.chart.timeScale().setVisibleLogicalRange({ from: n - dailyBars, to: n + 6 });
  }, [rangeKey, chartTick]);
  useEffect(() => {
    appliedRange.current = ""; // a rebuilt chart needs its range again
  }, [dataKey, style, indKey, totalH]);

  // levels + trade plan price lines
  useEffect(() => {
    const main = builtRef.current?.main;
    if (!main || !A) return;
    linesRef.current.forEach((l) => {
      try {
        main.removePriceLine(l);
      } catch {}
    });
    linesRef.current = [];
    const add = (price: number, color: string, title: string, lineStyle: number, lineWidth: 1 | 2) =>
      linesRef.current.push(main.createPriceLine({ price, color, title, lineStyle, lineWidth, axisLabelVisible: true }));
    if (showLv) {
      A.levels.resistance.forEach((x, i) => add(x.price, rgba(C.red, 0.7), x.is52 ? "52W HIGH" : `R${i + 1} ${x.touches}×`, 2, 1));
      A.levels.support.forEach((x, i) => add(x.price, rgba(C.green, 0.7), `S${i + 1} ${x.touches}×`, 2, 1));
    }
    if (showPlan && setup) {
      add(setup.entry, C.cyan, "ENTRY", 0, 2);
      add(setup.stop, C.red, "STOP", 0, 2);
      add(setup.tp1, C.green, "TP1", 0, 2);
      add(setup.tp2, C.green, "TP2", 1, 2);
      const vals = [setup.entry, setup.stop, setup.tp1, setup.tp2];
      planRef.current = isIntraday ? null : { lo: Math.min(...vals), hi: Math.max(...vals) };
    } else planRef.current = null;
    main.applyOptions({});
  }, [A, setup, showLv, showPlan, chartTick, isIntraday]);

  // ---------- derived UI ----------
  const b = data?.bars;
  const lastClose = b ? b.c[b.c.length - 1] : 0;
  const prevClose = b && b.c.length > 1 ? b.c[b.c.length - 2] : lastClose;
  const last = quote?.price ?? lastClose;
  const chgAbs = quote?.change ?? last - prevClose;
  const chg = quote?.change_pct ?? (prevClose ? (last / prevClose - 1) * 100 : 0);
  const ext = extLabel(quote);
  const sourceLabel = isIntraday
    ? `Supabase · fetch-intraday${intraRes?.cached ? " (cached)" : ""}`
    : data
    ? `Supabase · raw_prices${data.refreshed ? " · refreshed now" : ""}`
    : "";
  const stateLabel =
    quote?.market_state === "REGULAR"
      ? "Market open"
      : quote?.quote_time
      ? `At close: ${new Date(quote.quote_time).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`
      : `Last bar ${b?.t[b.t.length - 1] ?? ""}`;

  const levelRows: { k: string; t: string; p: number; kind: "r" | "s" | "c" | "m" }[] = [];
  if (A) {
    const rs = [...A.levels.resistance].reverse();
    rs.forEach((x, i) => levelRows.push({ k: `R${rs.length - i}`, t: x.is52 ? "52-week high" : `Resistance · ${x.touches}×`, p: x.price, kind: "r" }));
    levelRows.push({ k: "Close", t: "Last price", p: last, kind: "c" });
    A.levels.support.forEach((x, i) => levelRows.push({ k: `S${i + 1}`, t: `Support · ${x.touches}×`, p: x.price, kind: "s" }));
    (
      [
        ["21-day EMA", A.ind.ema21],
        ["50-day", A.ind.sma50],
        ["200-day", A.ind.sma200],
      ] as const
    ).forEach(([k, p]) => {
      if (p !== null) levelRows.push({ k, t: "Moving average", p, kind: "m" });
    });
  }

  const btn = (on: boolean) =>
    `border px-2 py-0.5 text-[11px] ${on ? "border-term-borderStrong bg-term-panel2 text-term-text" : "border-term-border text-term-dim hover:text-term-text"}`;
  const colorOf = (a: ActiveIndicator) => {
    const def = INDICATOR_BY_ID.get(a.id);
    const r = resultsRef.current.get(a.uid);
    const ln = r?.lines[0];
    if (a.id === "ma") return lineColor(a, indicators, { key: "", label: "", values: [], color: C.amber }, 0);
    return ln?.color ?? (def?.pane === "sub" ? C.cyan : C.amber);
  };

  return (
    <div className="flex flex-col gap-[3px]">
      <Panel title="Search" controls={<Chip>any US stock or ETF</Chip>} bodyClassName="p-2">
        <form
          className="relative"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex items-center gap-2 border border-term-borderStrong bg-term-bg px-2 focus-within:border-term-brand">
            <span className="text-term-dim" aria-hidden>
              ⌕
            </span>
            <input
              id="viba-search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              onKeyDown={(e) => {
                if (!open || !hits.length) return;
                if (e.key === "ArrowDown") {
                  setAct((i) => Math.min(hits.length - 1, i + 1));
                  e.preventDefault();
                } else if (e.key === "ArrowUp") {
                  setAct((i) => Math.max(0, i - 1));
                  e.preventDefault();
                } else if (e.key === "Escape") setOpen(false);
              }}
              placeholder="Ticker or company name, e.g. NVDA or Costco"
              spellCheck={false}
              aria-label="Search a stock or ETF"
              className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[13px] text-term-text outline-none placeholder:text-term-dim"
            />
            {searching && <span className="text-[10px] text-term-dim">searching…</span>}
            <button type="submit" className="border border-term-brand bg-term-brand/15 px-3 py-0.5 text-[11px] font-semibold text-term-brand hover:bg-term-brand/25">
              Analyze
            </button>
          </div>
          {open && hits.length > 0 && (
            <ul role="listbox" className="absolute left-0 right-0 top-[calc(100%+2px)] z-30 m-0 max-h-72 list-none overflow-auto border border-term-borderStrong bg-term-panel p-0 shadow-lg">
              {hits.map((h, i) => (
                <li
                  key={h.symbol}
                  role="option"
                  aria-selected={i === act}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    load(h.symbol);
                  }}
                  onMouseEnter={() => setAct(i)}
                  className={`flex cursor-pointer items-baseline gap-3 px-2 py-1 text-[11.5px] ${i === act ? "bg-term-panel2" : ""}`}
                >
                  <span className="w-16 shrink-0 font-mono font-bold text-term-text">{h.symbol}</span>
                  <span className="truncate text-term-dim">{h.name}</span>
                  <span className="ml-auto text-[10px] uppercase text-term-dim">{h.type}</span>
                </li>
              ))}
            </ul>
          )}
        </form>
        {quick.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1 text-[10.5px] text-term-dim">
            <span className="mr-1">Plays:</span>
            {quick.map((s) => (
              <button key={s} type="button" onClick={() => load(s)} className="border border-term-border px-1.5 font-mono text-term-text hover:border-term-cyan hover:text-term-cyan">
                {s}
              </button>
            ))}
          </div>
        )}
      </Panel>

      {error && <div className="border border-term-red/50 bg-term-red/10 px-2 py-1.5 text-[11.5px] text-term-text">{error}</div>}

      {data && (
        <>
          <Panel
            title={`${data.symbol}${data.name ? " · " + data.name : ""}`}
            controls={
              <>
                {(loading || intraLoading) && <Chip active>loading {loading ?? interval}…</Chip>}
                <Chip>{sourceLabel}</Chip>
                <Chip>{INTERVALS.find((x) => x.id === interval)?.label}</Chip>
              </>
            }
          >
            <div className="flex flex-wrap items-end justify-between gap-2 border-b border-term-border px-2 py-1.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-[22px] font-bold tabular-nums text-term-text">{quote ? fmtPrice(last) : money(last)}</span>
                  <span className={`font-mono text-[12px] tabular-nums ${chg >= 0 ? "text-term-green" : "text-term-red"}`}>
                    {fmtSigned(chgAbs)} ({pct(chg, 2)})
                  </span>
                </span>
                {ext && quote && quote.ext_price !== null && (
                  <span className="flex items-baseline gap-1.5 font-mono text-[12px] tabular-nums">
                    <span className="font-sans text-[10px] uppercase text-term-dim">{ext}</span>
                    <span className="text-term-text">{fmtPrice(quote.ext_price)}</span>
                    <span className={(quote.ext_change ?? 0) >= 0 ? "text-term-green" : "text-term-red"}>
                      {fmtSigned(quote.ext_change)} ({fmtSigned(quote.ext_change_pct, 2, "%")})
                    </span>
                  </span>
                )}
                {A && (
                  <span
                    className={`border px-1 text-[10px] font-semibold uppercase ${
                      A.trend === "Uptrend" ? "border-term-green/50 text-term-green" : A.trend === "Downtrend" ? "border-term-red/50 text-term-red" : "border-term-yellow/50 text-term-yellow"
                    }`}
                  >
                    {A.trend}
                  </span>
                )}
              </div>
              <span className="flex items-center gap-1.5 text-[10px] text-term-dim">
                {quote?.market_state === "REGULAR" && <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-term-green" />}
                {stateLabel}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-term-border px-2 py-1">
              <span className="flex gap-px" role="group" aria-label="Range">
                {VIEWS.map((v) => (
                  <button key={v.key} type="button" className={btn(view === v.key)} onClick={() => pickView(v)}>
                    {v.key}
                  </button>
                ))}
              </span>
              <label className="flex items-center gap-1 text-[11px] text-term-dim">
                Interval
                <select
                  value={interval}
                  onChange={(e) => pickInterval(e.target.value)}
                  className="border border-term-border bg-term-bg px-1 py-0.5 text-[11px] text-term-text outline-none focus:border-term-brand"
                >
                  {INTERVALS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="flex gap-px">
                <button type="button" className={btn(style === "candle")} onClick={() => setStyle("candle")}>
                  Candles
                </button>
                <button type="button" className={btn(style === "bar")} onClick={() => setStyle("bar")}>
                  Bars
                </button>
              </span>
              <span className="ml-auto flex flex-wrap gap-3 text-[11px] text-term-dim">
                <label className="flex cursor-pointer items-center gap-1">
                  <input type="checkbox" checked={showLv} onChange={(e) => setShowLv(e.target.checked)} className="accent-[#6cb33f]" />
                  Levels
                </label>
                <label className="flex cursor-pointer items-center gap-1">
                  <input type="checkbox" checked={showPlan} onChange={(e) => setShowPlan(e.target.checked)} className="accent-[#6cb33f]" />
                  Trade plan
                </label>
              </span>
            </div>
            <div className="border-b border-term-border px-2 py-1">
              <IndicatorMenu active={indicators} onChange={changeIndicators} colorOf={colorOf} />
            </div>
            <div ref={legendRef} className="min-h-[16px] px-2 pt-1 font-mono text-[10.5px] leading-[15px] text-term-dim">
              &nbsp;
            </div>
            {chartErr ? (
              <div className="p-3 text-[11.5px] text-term-amber">{chartErr}</div>
            ) : isIntraday && !intraRes ? (
              <div className="flex items-center justify-center text-[11.5px] text-term-dim" style={{ height: mainH }}>
                {intraErr ?? `Loading ${INTERVALS.find((x) => x.id === interval)?.label} bars for ${data.symbol}…`}
              </div>
            ) : (
              <div className="relative w-full" style={{ height: totalH }}>
                <div ref={boxRef} className="absolute inset-0" />
                {subs.map((a, k) => (
                  <div key={a.uid} className="pointer-events-none absolute left-0 right-[60px] border-t border-term-borderStrong" style={{ top: mainH + k * SUB_H }}>
                    <div
                      ref={(el) => {
                        subLegendRefs.current[k] = el;
                      }}
                      className="truncate bg-term-panel/80 px-2 font-mono text-[10px] leading-[16px] text-term-dim"
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-3 border-t border-term-border px-2 py-1 text-[10px] text-term-dim">
              <span>
                <span className="mr-1 inline-block w-3 border-t-2 border-dashed border-term-red align-middle" />
                Resistance
              </span>
              <span>
                <span className="mr-1 inline-block w-3 border-t-2 border-dashed border-term-green align-middle" />
                Support
              </span>
              <span>
                <span className="mr-1 inline-block h-[2px] w-3 bg-term-cyan align-middle" />
                Entry
              </span>
              <span>
                <span className="mr-1 inline-block h-[2px] w-3 bg-term-red align-middle" />
                Stop
              </span>
              <span>
                <span className="mr-1 inline-block h-[2px] w-3 bg-term-green align-middle" />
                Targets
              </span>
              <span className="ml-auto">
                {isIntraday ? "times in New York · pre/post-market included · last bar follows the live quote" : "daily bars · last bar follows the live quote"}
              </span>
            </div>
          </Panel>

          {result && !A && <div className="border border-term-amber/50 px-2 py-1.5 text-[11.5px] text-term-amber">{"error" in result ? result.error : ""}</div>}

          {A && (
            <div className="grid grid-cols-1 gap-[3px] lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-[3px]">
                <Panel title={sel === 0 ? "Primary setup" : "Selected setup"} controls={<Chip>{A.setups.length} found · daily</Chip>} bodyClassName="p-2">
                  {setup ? <SetupBlock s={setup} /> : <NoSetup a={A} />}
                </Panel>
                {A.setups.length > 1 && (
                  <Panel title="All setups on this chart" bodyClassName="p-2 flex flex-col gap-1">
                    {A.setups.map((x, i) => (
                      <button
                        key={x.key}
                        type="button"
                        onClick={() => setSel(i)}
                        aria-pressed={i === sel}
                        className={`flex items-center justify-between gap-2 border px-2 py-1.5 text-left text-[11px] ${
                          i === sel ? "border-term-cyan bg-term-cyan/10" : "border-term-border hover:border-term-borderStrong"
                        }`}
                      >
                        <span>
                          <span className="block font-semibold text-term-text">{x.name}</span>
                          <span className="font-mono text-[10.5px] text-term-dim">
                            Entry {money(x.entry)} · Stop {money(x.stop)} · TP1 {money(x.tp1)} · TP2 {money(x.tp2)}
                          </span>
                        </span>
                        <StatusChip status={x.status} />
                      </button>
                    ))}
                  </Panel>
                )}
                <NewsFeed key={data.symbol} title={`Recent news · ${data.symbol}`} symbols={[data.symbol]} pageSize={10} chip="news_items" />
              </div>
              <div className="flex min-w-0 flex-col gap-[3px]">
                <Panel title="Technical read" bodyClassName="p-2">
                  {A.narrative.map((t, i) => (
                    <p key={i} className="mb-1.5 mt-0 text-[11.5px] leading-relaxed text-term-text last:mb-0">
                      {t}
                    </p>
                  ))}
                </Panel>
                <Panel title="Key levels" controls={<Chip>auto-detected</Chip>} scrollX>
                  <table className="w-full border-collapse text-[11px]">
                    <thead>
                      <tr className="text-left text-[10px] uppercase text-term-dim">
                        <th className="px-2 py-1 font-normal">Level</th>
                        <th className="px-2 py-1 font-normal">Type</th>
                        <th className="px-2 py-1 text-right font-normal">Price</th>
                        <th className="px-2 py-1 text-right font-normal">Distance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {levelRows.map((r) => {
                        const d = (r.p / last - 1) * 100;
                        return (
                          <tr key={r.k} className="row-hover border-t border-term-border/60">
                            <td className={`px-2 py-1 font-mono font-bold ${r.kind === "r" ? "text-term-red" : r.kind === "s" ? "text-term-green" : "text-term-text"}`}>{r.k}</td>
                            <td className="px-2 py-1 text-term-dim">{r.t}</td>
                            <td className="px-2 py-1 text-right font-mono tabular-nums">{money(r.p)}</td>
                            <td className={`px-2 py-1 text-right font-mono tabular-nums ${r.kind === "c" ? "text-term-dim" : d >= 0 ? "text-term-green" : "text-term-red"}`}>
                              {r.kind === "c" ? "—" : pct(d)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Panel>
              </div>
            </div>
          )}
        </>
      )}

      {!data && !error && (
        <div className="border border-term-border bg-term-panel px-2 py-3 text-[11.5px] text-term-dim">
          {loading ? `Loading two years of daily bars for ${loading}…` : "Search a ticker to chart it."}
        </div>
      )}
    </div>
  );
}
