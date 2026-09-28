"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, IPriceLine, ISeriesApi, SeriesType, Time, MouseEventParams } from "lightweight-charts";
import { analyze, isAnalysis, money, type Analysis, type Bars } from "@/lib/ta";
import Panel, { Chip } from "@/components/Panel";
import SetupBlock, { NoSetup, StatusChip } from "@/components/SetupBlock";

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
  ema21: "#4fb3e8",
  sma50: "#f5c542",
  sma200: "#e07b39",
};
const RANGES = [
  { label: "3M", bars: 63 },
  { label: "6M", bars: 126 },
  { label: "1Y", bars: 252 },
  { label: "All", bars: 0 },
];
const SYM_RE = /^#chart\/([A-Za-z0-9.\-^]+)/;

function pct(v: number, d = 1) {
  return (v >= 0 ? "+" : "") + v.toFixed(d) + "%";
}
function rgba(hex: string, a: number) {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
function fmtVol(v: number) {
  return v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(0) + "K" : String(v);
}

/**
 * Search any US stock or ETF, draw an interactive daily candlestick / bar
 * chart, and let the setup engine (lib/ta.ts) mark support and resistance,
 * the 21/50/200-day averages, and the trade plan (entry, stop, TP1, TP2) for
 * every setup it detects.
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
  const [range, setRange] = useState(126);
  const [style, setStyle] = useState<"candle" | "bar">("candle");
  const [showMa, setShowMa] = useState(true);
  const [showLv, setShowLv] = useState(true);
  const [showPlan, setShowPlan] = useState(true);

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

  // hash deep links (#chart/NVDA) from play cards, and the initial symbol
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

  // ---------- chart ----------
  const boxRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const maRefs = useRef<ISeriesApi<"Line">[]>([]);
  const linesRef = useRef<IPriceLine[]>([]);
  const planRef = useRef<{ lo: number; hi: number } | null>(null);
  const [chartErr, setChartErr] = useState<string | null>(null);
  // bumps once the async chart build finishes so the overlay effects re-run
  const [chartTick, setChartTick] = useState(0);

  const applyRange = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || !data) return;
    const n = data.bars.t.length;
    if (!range || range >= n) chart.timeScale().fitContent();
    else chart.timeScale().setVisibleLogicalRange({ from: n - range, to: n + 6 });
  }, [data, range]);

  const writeLegend = useCallback(
    (i: number) => {
      const el = legendRef.current;
      if (!el || !data) return;
      const b = data.bars;
      if (i < 0 || i >= b.t.length) i = b.t.length - 1;
      const pc = i > 0 ? b.c[i - 1] : b.o[i];
      const ch = (b.c[i] / pc - 1) * 100;
      el.innerHTML = `${b.t[i]}&nbsp;&nbsp;O ${b.o[i].toFixed(2)}&nbsp;&nbsp;H ${b.h[i].toFixed(2)}&nbsp;&nbsp;L ${b.l[i].toFixed(
        2
      )}&nbsp;&nbsp;C ${b.c[i].toFixed(2)}&nbsp;&nbsp;<span style="color:${ch >= 0 ? C.green : C.red}">${pct(ch, 2)}</span>&nbsp;&nbsp;Vol ${fmtVol(
        b.v[i]
      )}`;
    },
    [data]
  );

  // build / rebuild the chart when the data or bar style changes
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !data || !A) return;
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
      if (disposed) return;
      setChartErr(null);
      const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-plex-mono").trim() || "monospace";
      const chart = lc.createChart(el, {
        autoSize: true,
        localization: { locale: "en-US" },
        layout: { background: { type: lc.ColorType.Solid, color: C.panel }, textColor: C.dim, fontFamily: `${mono}, monospace`, fontSize: 11 },
        grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
        rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.06, bottom: 0.2 } },
        timeScale: { borderColor: C.border, rightOffset: 8, barSpacing: 6 },
        crosshair: {
          mode: lc.CrosshairMode.Normal,
          vertLine: { color: C.dim, labelBackgroundColor: "#2b2b2b" },
          horzLine: { color: C.dim, labelBackgroundColor: "#2b2b2b" },
        },
      });
      chartRef.current = chart;
      const b = data.bars;
      const ohlc = b.t.map((t, i) => ({ time: t as Time, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i] }));
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
              priceLineVisible: false,
              autoscaleInfoProvider: autoscale,
            })
          : chart.addBarSeries({ upColor: C.green, downColor: C.red, thinBars: false, priceLineVisible: false, autoscaleInfoProvider: autoscale });
      main.setData(ohlc);
      mainRef.current = main as ISeriesApi<SeriesType>;

      const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      vol.setData(b.t.map((t, i) => ({ time: t as Time, value: b.v[i], color: rgba(b.c[i] >= b.o[i] ? C.green : C.red, 0.35) })));

      maRefs.current = (
        [
          [A.series.ema21, C.ema21],
          [A.series.sma50, C.sma50],
          [A.series.sma200, C.sma200],
        ] as const
      ).map(([arr, color]) => {
        const s = chart.addLineSeries({
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          autoscaleInfoProvider: () => null,
        });
        s.setData(b.t.map((t, i) => (arr[i] === null ? { time: t as Time } : { time: t as Time, value: arr[i] as number })));
        return s;
      });

      chart.subscribeCrosshairMove((p: MouseEventParams) => {
        const idx = p.time ? b.t.indexOf(String(p.time)) : -1;
        writeLegend(idx);
      });
      writeLegend(-1);

      // apply the visible range once the (possibly hidden) tab has a real width
      ro = new ResizeObserver(() => {
        if (el.clientWidth > 0) applyRange();
      });
      ro.observe(el);
      setChartTick((n) => n + 1);
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      mainRef.current = null;
      maRefs.current = [];
      linesRef.current = [];
    };
    // A is derived from data; rebuild only on data/style changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, style]);

  useEffect(() => {
    applyRange();
  }, [applyRange, chartTick]);

  useEffect(() => {
    maRefs.current.forEach((s) => s.applyOptions({ visible: showMa }));
  }, [showMa, chartTick]);

  // levels + trade plan price lines
  useEffect(() => {
    const main = mainRef.current;
    if (!main || !A) return;
    linesRef.current.forEach((l) => main.removePriceLine(l));
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
      planRef.current = { lo: Math.min(...vals), hi: Math.max(...vals) };
    } else planRef.current = null;
    main.applyOptions({});
  }, [A, setup, showLv, showPlan, chartTick]);

  // ---------- derived UI ----------
  const b = data?.bars;
  const last = b ? b.c[b.c.length - 1] : 0;
  const prev = b && b.c.length > 1 ? b.c[b.c.length - 2] : last;
  const chg = prev ? (last / prev - 1) * 100 : 0;
  const sourceLabel = data ? `Supabase · raw_prices${data.refreshed ? " · refreshed now" : ""}` : "";

  const levelRows: { k: string; t: string; p: number; kind: "r" | "s" | "c" | "m" }[] = [];
  if (A) {
    const rs = [...A.levels.resistance].reverse();
    rs.forEach((x, i) => levelRows.push({ k: `R${rs.length - i}`, t: x.is52 ? "52-week high" : `Resistance · ${x.touches}×`, p: x.price, kind: "r" }));
    levelRows.push({ k: "Close", t: "Last price", p: A.ind.close, kind: "c" });
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

      {error && (
        <div className="border border-term-red/50 bg-term-red/10 px-2 py-1.5 text-[11.5px] text-term-text">{error}</div>
      )}

      {data && (
        <>
          <Panel
            title={`${data.symbol}${data.name ? " · " + data.name : ""}`}
            controls={
              <>
                {loading && <Chip active>loading {loading}…</Chip>}
                <Chip>{sourceLabel}</Chip>
                <Chip>daily</Chip>
              </>
            }
          >
            <div className="flex flex-wrap items-end justify-between gap-2 border-b border-term-border px-2 py-1.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[22px] font-bold tabular-nums text-term-text">{money(last)}</span>
                <span className={`font-mono text-[12px] tabular-nums ${chg >= 0 ? "text-term-green" : "text-term-red"}`}>
                  {(last - prev >= 0 ? "+" : "") + (last - prev).toFixed(2)} ({pct(chg, 2)})
                </span>
                {A && (
                  <span
                    className={`border px-1 text-[10px] font-semibold uppercase ${
                      A.trend === "Uptrend"
                        ? "border-term-green/50 text-term-green"
                        : A.trend === "Downtrend"
                        ? "border-term-red/50 text-term-red"
                        : "border-term-yellow/50 text-term-yellow"
                    }`}
                  >
                    {A.trend}
                  </span>
                )}
              </div>
              <span className="text-[10px] text-term-dim">Last bar {b?.t[b.t.length - 1]}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-term-border px-2 py-1">
              <span className="flex gap-px">
                {RANGES.map((r) => (
                  <button key={r.label} type="button" className={btn(range === r.bars)} onClick={() => setRange(r.bars)}>
                    {r.label}
                  </button>
                ))}
              </span>
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
                  <input type="checkbox" checked={showMa} onChange={(e) => setShowMa(e.target.checked)} className="accent-[#6cb33f]" />
                  Averages
                </label>
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
            <div ref={legendRef} className="truncate px-2 pt-1 font-mono text-[10.5px] text-term-dim">
              &nbsp;
            </div>
            {chartErr ? (
              <div className="p-3 text-[11.5px] text-term-amber">{chartErr}</div>
            ) : (
              <div ref={boxRef} className="h-[360px] w-full md:h-[480px]" />
            )}
            <div className="flex flex-wrap gap-3 border-t border-term-border px-2 py-1 text-[10px] text-term-dim">
              <span><span className="mr-1 inline-block h-[2px] w-3 align-middle" style={{ background: C.ema21 }} />21-day EMA</span>
              <span><span className="mr-1 inline-block h-[2px] w-3 align-middle" style={{ background: C.sma50 }} />50-day</span>
              <span><span className="mr-1 inline-block h-[2px] w-3 align-middle" style={{ background: C.sma200 }} />200-day</span>
              <span><span className="mr-1 inline-block w-3 border-t-2 border-dashed border-term-red align-middle" />Resistance</span>
              <span><span className="mr-1 inline-block w-3 border-t-2 border-dashed border-term-green align-middle" />Support</span>
              <span><span className="mr-1 inline-block h-[2px] w-3 bg-term-cyan align-middle" />Entry</span>
              <span><span className="mr-1 inline-block h-[2px] w-3 bg-term-red align-middle" />Stop</span>
              <span><span className="mr-1 inline-block h-[2px] w-3 bg-term-green align-middle" />Targets</span>
            </div>
          </Panel>

          {result && !A && <div className="border border-term-amber/50 px-2 py-1.5 text-[11.5px] text-term-amber">{"error" in result ? result.error : ""}</div>}

          {A && (
            <div className="grid grid-cols-1 gap-[3px] lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-[3px]">
                <Panel title={sel === 0 ? "Primary setup" : "Selected setup"} controls={<Chip>{A.setups.length} found</Chip>} bodyClassName="p-2">
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
                            <td
                              className={`px-2 py-1 font-mono font-bold ${
                                r.kind === "r" ? "text-term-red" : r.kind === "s" ? "text-term-green" : "text-term-text"
                              }`}
                            >
                              {r.k}
                            </td>
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
