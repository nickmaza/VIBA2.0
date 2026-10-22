// Technical indicators for the Chart & Search tab, computed in the browser
// from the loaded bars -- the same split Yahoo Finance uses (its chart
// fetches OHLCV once and every study is calculated client-side).
//
// Each indicator is a pure function of the bars and its parameters, so the
// chart can recompute everything on every live tick. Outputs are arrays
// aligned with the bars, with null where the indicator has no value yet.
//
// Moving-average types (all available wherever an indicator takes a "type"):
//   SMA, EMA, WMA, Wilder (SMMA/RMA), DEMA, TEMA, Triangular, Hull, VWMA,
//   ZLEMA, KAMA (Kaufman adaptive), VIDYA (variable index dynamic), Time
//   series (least-squares end point), ALMA (Arnaud Legoux), T3 (Tillson).

export interface OHLCV {
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  /** Exchange-local day key of each bar (YYYY-MM-DD); used by session VWAP. */
  day: string[];
}

export type Line = (number | null)[];

// ---------------------------------------------------------------- helpers
const nz = (x: number | null | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);

function firstValid(a: Line): number {
  for (let i = 0; i < a.length; i++) if (nz(a[i])) return i;
  return a.length;
}

/** Run a numeric-array function on the valid tail of a series that starts with nulls. */
function onValid(a: Line, f: (x: number[]) => Line): Line {
  const s = firstValid(a);
  const out: Line = new Array(a.length).fill(null);
  if (s >= a.length) return out;
  const tail = a.slice(s).map((x) => (nz(x) ? x : NaN));
  const r = f(tail as number[]);
  for (let i = 0; i < r.length; i++) out[s + i] = nz(r[i]) ? (r[i] as number) : null;
  return out;
}

export function source(b: OHLCV, src: string): number[] {
  switch (src) {
    case "open":
      return b.o;
    case "high":
      return b.h;
    case "low":
      return b.l;
    case "hl2":
      return b.h.map((h, i) => (h + b.l[i]) / 2);
    case "hlc3":
      return b.h.map((h, i) => (h + b.l[i] + b.c[i]) / 3);
    case "ohlc4":
      return b.h.map((h, i) => (b.o[i] + h + b.l[i] + b.c[i]) / 4);
    default:
      return b.c;
  }
}

// ---------------------------------------------------------------- moving averages
export function sma(a: number[], n: number): Line {
  const out: Line = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n values. alpha defaults to 2/(n+1). */
export function ema(a: number[], n: number, alpha = 2 / (n + 1)): Line {
  const out: Line = new Array(a.length).fill(null);
  if (a.length < n) return out;
  let e = 0;
  for (let i = 0; i < n; i++) e += a[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < a.length; i++) {
    e = a[i] * alpha + e * (1 - alpha);
    out[i] = e;
  }
  return out;
}

export const wilder = (a: number[], n: number): Line => ema(a, n, 1 / n);

export function wma(a: number[], n: number): Line {
  const out: Line = new Array(a.length).fill(null);
  const den = (n * (n + 1)) / 2;
  for (let i = n - 1; i < a.length; i++) {
    let s = 0;
    for (let k = 0; k < n; k++) s += a[i - k] * (n - k);
    out[i] = s / den;
  }
  return out;
}

function dema(a: number[], n: number): Line {
  const e1 = ema(a, n);
  const e2 = onValid(e1, (x) => ema(x, n));
  return e1.map((v, i) => (nz(v) && nz(e2[i]) ? 2 * v - (e2[i] as number) : null));
}

function tema(a: number[], n: number): Line {
  const e1 = ema(a, n);
  const e2 = onValid(e1, (x) => ema(x, n));
  const e3 = onValid(e2, (x) => ema(x, n));
  return e1.map((v, i) => (nz(v) && nz(e2[i]) && nz(e3[i]) ? 3 * v - 3 * (e2[i] as number) + (e3[i] as number) : null));
}

function trima(a: number[], n: number): Line {
  const n1 = Math.ceil((n + 1) / 2);
  const n2 = Math.floor((n + 1) / 2);
  return onValid(sma(a, n1), (x) => sma(x, n2));
}

function hma(a: number[], n: number): Line {
  const half = wma(a, Math.max(1, Math.floor(n / 2)));
  const full = wma(a, n);
  const diff = half.map((v, i) => (nz(v) && nz(full[i]) ? 2 * v - (full[i] as number) : null));
  return onValid(diff, (x) => wma(x, Math.max(1, Math.round(Math.sqrt(n)))));
}

function vwma(a: number[], v: number[], n: number): Line {
  const out: Line = new Array(a.length).fill(null);
  let pv = 0,
    vv = 0;
  for (let i = 0; i < a.length; i++) {
    pv += a[i] * v[i];
    vv += v[i];
    if (i >= n) {
      pv -= a[i - n] * v[i - n];
      vv -= v[i - n];
    }
    if (i >= n - 1) out[i] = vv > 0 ? pv / vv : sma(a.slice(i - n + 1, i + 1), n)[n - 1];
  }
  return out;
}

function zlema(a: number[], n: number): Line {
  const lag = Math.floor((n - 1) / 2);
  const adj = a.map((x, i) => (i >= lag ? 2 * x - a[i - lag] : x));
  return ema(adj, n);
}

/** Kaufman adaptive MA: efficiency ratio over n, fast 2 / slow 30. */
function kama(a: number[], n: number, fast = 2, slow = 30): Line {
  const out: Line = new Array(a.length).fill(null);
  if (a.length <= n) return out;
  const fsc = 2 / (fast + 1),
    ssc = 2 / (slow + 1);
  let k = a[n - 1];
  out[n - 1] = k;
  for (let i = n; i < a.length; i++) {
    const change = Math.abs(a[i] - a[i - n]);
    let vol = 0;
    for (let j = i - n + 1; j <= i; j++) vol += Math.abs(a[j] - a[j - 1]);
    const er = vol > 0 ? change / vol : 0;
    const sc = (er * (fsc - ssc) + ssc) ** 2;
    k = k + sc * (a[i] - k);
    out[i] = k;
  }
  return out;
}

/** VIDYA: EMA whose speed scales with the Chande momentum oscillator (9). */
function vidya(a: number[], n: number, cmoLen = 9): Line {
  const out: Line = new Array(a.length).fill(null);
  const alpha = 2 / (n + 1);
  let v: number | null = null;
  for (let i = cmoLen; i < a.length; i++) {
    let up = 0,
      dn = 0;
    for (let j = i - cmoLen + 1; j <= i; j++) {
      const d = a[j] - a[j - 1];
      if (d > 0) up += d;
      else dn -= d;
    }
    const cmo = up + dn > 0 ? Math.abs((up - dn) / (up + dn)) : 0;
    v = v === null ? a[i] : alpha * cmo * a[i] + (1 - alpha * cmo) * v;
    if (i >= n - 1) out[i] = v;
  }
  return out;
}

/** Least-squares line over n bars, evaluated at the last bar (+ offset bars ahead). */
function linreg(a: number[], n: number, ahead = 0): Line {
  const out: Line = new Array(a.length).fill(null);
  const sx = (n * (n - 1)) / 2;
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
  const den = n * sxx - sx * sx;
  for (let i = n - 1; i < a.length; i++) {
    let sy = 0,
      sxy = 0;
    for (let k = 0; k < n; k++) {
      const y = a[i - n + 1 + k];
      sy += y;
      sxy += k * y;
    }
    const slope = den ? (n * sxy - sx * sy) / den : 0;
    const icpt = (sy - slope * sx) / n;
    out[i] = icpt + slope * (n - 1 + ahead);
  }
  return out;
}

function alma(a: number[], n: number, offset = 0.85, sigma = 6): Line {
  const out: Line = new Array(a.length).fill(null);
  const m = offset * (n - 1);
  const s = n / sigma;
  const w = Array.from({ length: n }, (_, k) => Math.exp(-((k - m) ** 2) / (2 * s * s)));
  const ws = w.reduce((x, y) => x + y, 0);
  for (let i = n - 1; i < a.length; i++) {
    let acc = 0;
    for (let k = 0; k < n; k++) acc += a[i - n + 1 + k] * w[k];
    out[i] = acc / ws;
  }
  return out;
}

/** Tillson T3 with volume factor 0.7. */
function t3(a: number[], n: number, vf = 0.7): Line {
  let e: Line = ema(a, n);
  const es: Line[] = [e];
  for (let k = 0; k < 5; k++) {
    e = onValid(e, (x) => ema(x, n));
    es.push(e);
  }
  const c1 = -(vf ** 3),
    c2 = 3 * vf ** 2 + 3 * vf ** 3,
    c3 = -6 * vf ** 2 - 3 * vf - 3 * vf ** 3,
    c4 = 1 + 3 * vf + vf ** 3 + 3 * vf ** 2;
  const [, , e3, e4, e5, e6] = es;
  return a.map((_, i) =>
    nz(e3[i]) && nz(e4[i]) && nz(e5[i]) && nz(e6[i])
      ? c1 * (e6[i] as number) + c2 * (e5[i] as number) + c3 * (e4[i] as number) + c4 * (e3[i] as number)
      : null
  );
}

export const MA_TYPES = [
  { id: "sma", label: "Simple (SMA)" },
  { id: "ema", label: "Exponential (EMA)" },
  { id: "wma", label: "Weighted (WMA)" },
  { id: "wilder", label: "Welles Wilder (SMMA)" },
  { id: "dema", label: "Double exponential (DEMA)" },
  { id: "tema", label: "Triple exponential (TEMA)" },
  { id: "trima", label: "Triangular" },
  { id: "hma", label: "Hull (HMA)" },
  { id: "vwma", label: "Volume weighted (VWMA)" },
  { id: "zlema", label: "Zero lag (ZLEMA)" },
  { id: "kama", label: "Kaufman adaptive (KAMA)" },
  { id: "vidya", label: "Variable (VIDYA)" },
  { id: "tsf", label: "Time series (LSMA)" },
  { id: "alma", label: "Arnaud Legoux (ALMA)" },
  { id: "t3", label: "Tillson T3" },
] as const;
export type MaType = (typeof MA_TYPES)[number]["id"];

export function movingAverage(type: string, a: number[], n: number, vol?: number[]): Line {
  n = Math.max(1, Math.round(n));
  switch (type) {
    case "ema":
      return ema(a, n);
    case "wma":
      return wma(a, n);
    case "wilder":
      return wilder(a, n);
    case "dema":
      return dema(a, n);
    case "tema":
      return tema(a, n);
    case "trima":
      return trima(a, n);
    case "hma":
      return hma(a, n);
    case "vwma":
      return vol ? vwma(a, vol, n) : sma(a, n);
    case "zlema":
      return zlema(a, n);
    case "kama":
      return kama(a, n);
    case "vidya":
      return vidya(a, n);
    case "tsf":
      return linreg(a, n);
    case "alma":
      return alma(a, n);
    case "t3":
      return t3(a, n);
    default:
      return sma(a, n);
  }
}

function shift(a: Line, k: number): Line {
  if (!k) return a;
  const out: Line = new Array(a.length).fill(null);
  for (let i = 0; i < a.length; i++) {
    const j = i + k;
    if (j >= 0 && j < a.length) out[j] = a[i];
  }
  return out;
}

function stdev(a: number[], n: number): Line {
  const out: Line = new Array(a.length).fill(null);
  for (let i = n - 1; i < a.length; i++) {
    let s = 0,
      ss = 0;
    for (let k = i - n + 1; k <= i; k++) {
      s += a[k];
      ss += a[k] * a[k];
    }
    const m = s / n;
    out[i] = Math.sqrt(Math.max(0, ss / n - m * m));
  }
  return out;
}

function highest(a: number[], n: number): Line {
  const out: Line = new Array(a.length).fill(null);
  for (let i = n - 1; i < a.length; i++) {
    let m = -Infinity;
    for (let k = i - n + 1; k <= i; k++) m = Math.max(m, a[k]);
    out[i] = m;
  }
  return out;
}
function lowest(a: number[], n: number): Line {
  const out: Line = new Array(a.length).fill(null);
  for (let i = n - 1; i < a.length; i++) {
    let m = Infinity;
    for (let k = i - n + 1; k <= i; k++) m = Math.min(m, a[k]);
    out[i] = m;
  }
  return out;
}

export function trueRange(b: OHLCV): number[] {
  return b.c.map((_, i) => (i === 0 ? b.h[i] - b.l[i] : Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]))));
}
export const atr = (b: OHLCV, n: number): Line => wilder(trueRange(b), n);

// ---------------------------------------------------------------- indicator catalog
export type Pane = "price" | "sub";
export type Style = "line" | "dashed" | "dots" | "histogram" | "area";

export interface ParamSpec {
  key: string;
  label: string;
  def: number | string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly { id: string; label: string }[];
}

export interface OutLine {
  key: string;
  label: string;
  values: Line;
  color: string;
  style?: Style;
  width?: 1 | 2 | 3;
  /** per-bar colors (histograms) */
  colors?: (string | null)[];
}

export interface IndicatorResult {
  lines: OutLine[];
  /** horizontal guide lines in a sub pane (RSI 30/70 ...) */
  levels?: number[];
}

export interface IndicatorDef {
  id: string;
  name: string;
  group: "Moving averages" | "Trend & bands" | "Momentum" | "Volatility" | "Volume";
  pane: Pane;
  popular?: boolean;
  params: ParamSpec[];
  /** short label for chips and the pane legend */
  short: (p: Params) => string;
  compute: (b: OHLCV, p: Params) => IndicatorResult;
}

export type Params = Record<string, number | string>;

const PAL = {
  blue: "#4fb3e8",
  amber: "#f5c542",
  orange: "#e07b39",
  violet: "#b48ef0",
  pink: "#ef6fae",
  teal: "#3cc9b5",
  green: "#3fbf4a",
  red: "#e5453c",
  gray: "#9c9c9c",
  white: "#e6e6e6",
};

const maTypeParam = (def: MaType = "sma"): ParamSpec => ({ key: "type", label: "Type", def, options: MA_TYPES });
const srcParam: ParamSpec = {
  key: "src",
  label: "Field",
  def: "close",
  options: [
    { id: "close", label: "Close" },
    { id: "open", label: "Open" },
    { id: "high", label: "High" },
    { id: "low", label: "Low" },
    { id: "hl2", label: "(H+L)/2" },
    { id: "hlc3", label: "(H+L+C)/3" },
    { id: "ohlc4", label: "(O+H+L+C)/4" },
  ],
};
const num = (p: Params, k: string) => Number(p[k]);
const str = (p: Params, k: string) => String(p[k]);
const maShort = (t: string) => (MA_TYPES.find((m) => m.id === t)?.label.match(/\(([^)]+)\)/)?.[1] ?? MA_TYPES.find((m) => m.id === t)?.label ?? t).toUpperCase();

export const INDICATORS: IndicatorDef[] = [
  // ------------------------------------------------ moving averages
  {
    id: "ma",
    name: "Moving average",
    group: "Moving averages",
    pane: "price",
    popular: true,
    params: [maTypeParam("sma"), { key: "period", label: "Period", def: 50, min: 1, max: 500 }, srcParam, { key: "offset", label: "Offset", def: 0, min: -50, max: 50 }],
    short: (p) => `${maShort(str(p, "type"))} ${p.period}`,
    compute: (b, p) => ({
      lines: [{ key: "ma", label: `${maShort(str(p, "type"))} ${p.period}`, color: PAL.amber, values: shift(movingAverage(str(p, "type"), source(b, str(p, "src")), num(p, "period"), b.v), num(p, "offset")) }],
    }),
  },
  {
    id: "macross",
    name: "Moving average cross",
    group: "Moving averages",
    pane: "price",
    params: [
      { key: "fastType", label: "Fast type", def: "ema", options: MA_TYPES },
      { key: "fast", label: "Fast period", def: 20, min: 1, max: 400 },
      { key: "slowType", label: "Slow type", def: "sma", options: MA_TYPES },
      { key: "slow", label: "Slow period", def: 50, min: 2, max: 500 },
    ],
    short: (p) => `MA cross ${p.fast}/${p.slow}`,
    compute: (b, p) => ({
      lines: [
        { key: "fast", label: `${maShort(str(p, "fastType"))} ${p.fast}`, color: PAL.blue, values: movingAverage(str(p, "fastType"), b.c, num(p, "fast"), b.v) },
        { key: "slow", label: `${maShort(str(p, "slowType"))} ${p.slow}`, color: PAL.orange, values: movingAverage(str(p, "slowType"), b.c, num(p, "slow"), b.v) },
      ],
    }),
  },
  {
    id: "maenv",
    name: "Moving average envelope",
    group: "Moving averages",
    pane: "price",
    popular: true,
    params: [maTypeParam("sma"), { key: "period", label: "Period", def: 20, min: 1, max: 400 }, { key: "pct", label: "Shift %", def: 5, min: 0.1, max: 50, step: 0.1 }],
    short: (p) => `Envelope ${p.period} ±${p.pct}%`,
    compute: (b, p) => {
      const m = movingAverage(str(p, "type"), b.c, num(p, "period"), b.v);
      const k = num(p, "pct") / 100;
      return {
        lines: [
          { key: "up", label: "Upper", color: PAL.teal, values: m.map((x) => (nz(x) ? x * (1 + k) : null)) },
          { key: "mid", label: "Mid", color: PAL.gray, style: "dashed", values: m },
          { key: "lo", label: "Lower", color: PAL.teal, values: m.map((x) => (nz(x) ? x * (1 - k) : null)) },
        ],
      };
    },
  },
  {
    id: "madev",
    name: "Moving average deviation",
    group: "Moving averages",
    pane: "sub",
    popular: true,
    params: [maTypeParam("sma"), { key: "period", label: "Period", def: 20, min: 1, max: 400 }, { key: "mode", label: "Units", def: "pct", options: [{ id: "pct", label: "Percent" }, { id: "pts", label: "Points" }] }],
    short: (p) => `MA dev ${p.period}${str(p, "mode") === "pct" ? " %" : ""}`,
    compute: (b, p) => {
      const m = movingAverage(str(p, "type"), b.c, num(p, "period"), b.v);
      const pct = str(p, "mode") === "pct";
      const d = b.c.map((c, i) => (nz(m[i]) ? (pct ? (c / (m[i] as number) - 1) * 100 : c - (m[i] as number)) : null));
      return {
        lines: [{ key: "dev", label: "Deviation", color: PAL.blue, style: "histogram", values: d, colors: d.map((x) => (nz(x) ? (x >= 0 ? "rgba(63,191,74,0.7)" : "rgba(229,69,60,0.7)") : null)) }],
        levels: [0],
      };
    },
  },
  {
    id: "guppy",
    name: "Guppy multiple moving average",
    group: "Moving averages",
    pane: "price",
    params: [maTypeParam("ema")],
    short: () => "Guppy MMA",
    compute: (b, p) => ({
      lines: [3, 5, 8, 10, 12, 15, 30, 35, 40, 45, 50, 60].map((n, i) => ({
        key: `g${n}`,
        label: String(n),
        color: i < 6 ? "rgba(79,179,232,0.85)" : "rgba(229,69,60,0.85)",
        values: movingAverage(str(p, "type"), b.c, n, b.v),
      })),
    }),
  },
  {
    id: "rainbow",
    name: "Rainbow moving average",
    group: "Moving averages",
    pane: "price",
    params: [maTypeParam("sma"), { key: "period", label: "Period", def: 2, min: 1, max: 50 }],
    short: (p) => `Rainbow ${p.period}`,
    compute: (b, p) => {
      const cols = ["#ff4d4d", "#ff8c1a", "#ffd11a", "#b3e600", "#33cc33", "#1ad1a3", "#1ab2ff", "#4d79ff", "#8c66ff", "#d966ff"];
      let cur: Line = b.c;
      return {
        lines: cols.map((color, i) => {
          cur = onValid(cur, (x) => movingAverage(str(p, "type"), x, num(p, "period")));
          return { key: `r${i}`, label: String(i + 1), color, values: cur };
        }),
      };
    },
  },
  {
    id: "vwap",
    name: "VWAP",
    group: "Moving averages",
    pane: "price",
    params: [{ key: "reset", label: "Reset", def: "session", options: [{ id: "session", label: "Each session" }, { id: "week", label: "Weekly" }, { id: "month", label: "Monthly" }] }, { key: "bands", label: "Std-dev bands", def: 0, min: 0, max: 3, step: 0.5 }],
    short: (p) => `VWAP ${str(p, "reset")}`,
    compute: (b, p) => {
      const reset = str(p, "reset");
      const key = (d: string) => {
        if (reset === "month") return d.slice(0, 7);
        if (reset === "week") {
          const t = Date.parse(`${d}T12:00:00Z`);
          const dow = (new Date(t).getUTCDay() + 6) % 7;
          return new Date(t - dow * 864e5).toISOString().slice(0, 10);
        }
        return d;
      };
      const tp = source(b, "hlc3");
      const out: Line = [],
        up: Line = [],
        lo: Line = [];
      const k = num(p, "bands");
      let pv = 0,
        vv = 0,
        pv2 = 0,
        cur = "";
      for (let i = 0; i < tp.length; i++) {
        const g = key(b.day[i] ?? "");
        if (g !== cur) {
          cur = g;
          pv = vv = pv2 = 0;
        }
        const v = b.v[i] > 0 ? b.v[i] : 1e-9;
        pv += tp[i] * v;
        vv += v;
        pv2 += tp[i] * tp[i] * v;
        const m = pv / vv;
        out.push(m);
        const sd = Math.sqrt(Math.max(0, pv2 / vv - m * m));
        up.push(k ? m + k * sd : null);
        lo.push(k ? m - k * sd : null);
      }
      const lines: OutLine[] = [{ key: "vwap", label: "VWAP", color: PAL.pink, width: 2, values: out }];
      if (k) lines.push({ key: "up", label: `+${k}σ`, color: "rgba(239,111,174,0.55)", style: "dashed", values: up }, { key: "lo", label: `−${k}σ`, color: "rgba(239,111,174,0.55)", style: "dashed", values: lo });
      return { lines };
    },
  },
  {
    id: "avwap",
    name: "Anchored VWAP",
    group: "Moving averages",
    pane: "price",
    params: [{ key: "back", label: "Anchor (bars ago)", def: 60, min: 1, max: 5000 }],
    short: (p) => `AVWAP −${p.back}`,
    compute: (b, p) => {
      const start = Math.max(0, b.c.length - num(p, "back"));
      const tp = source(b, "hlc3");
      const out: Line = new Array(b.c.length).fill(null);
      let pv = 0,
        vv = 0;
      for (let i = start; i < b.c.length; i++) {
        const v = b.v[i] > 0 ? b.v[i] : 1e-9;
        pv += tp[i] * v;
        vv += v;
        out[i] = pv / vv;
      }
      return { lines: [{ key: "avwap", label: "AVWAP", color: PAL.violet, width: 2, values: out }] };
    },
  },

  // ------------------------------------------------ trend & bands
  {
    id: "bb",
    name: "Bollinger bands",
    group: "Trend & bands",
    pane: "price",
    popular: true,
    params: [{ key: "period", label: "Period", def: 20, min: 2, max: 400 }, { key: "mult", label: "Std devs", def: 2, min: 0.5, max: 5, step: 0.1 }, maTypeParam("sma"), srcParam],
    short: (p) => `BB ${p.period}, ${p.mult}`,
    compute: (b, p) => {
      const a = source(b, str(p, "src"));
      const n = num(p, "period");
      const m = movingAverage(str(p, "type"), a, n, b.v);
      const sd = stdev(a, n);
      const k = num(p, "mult");
      return {
        lines: [
          { key: "up", label: "Upper", color: PAL.blue, values: m.map((x, i) => (nz(x) && nz(sd[i]) ? x + k * (sd[i] as number) : null)) },
          { key: "mid", label: "Basis", color: PAL.amber, style: "dashed", values: m },
          { key: "lo", label: "Lower", color: PAL.blue, values: m.map((x, i) => (nz(x) && nz(sd[i]) ? x - k * (sd[i] as number) : null)) },
        ],
      };
    },
  },
  {
    id: "psar",
    name: "Parabolic SAR",
    group: "Trend & bands",
    pane: "price",
    params: [{ key: "step", label: "Step", def: 0.02, min: 0.001, max: 0.5, step: 0.001 }, { key: "max", label: "Maximum", def: 0.2, min: 0.01, max: 1, step: 0.01 }],
    short: (p) => `SAR ${p.step}, ${p.max}`,
    compute: (b, p) => {
      const step = num(p, "step"),
        mx = num(p, "max");
      const n = b.c.length;
      const up: Line = new Array(n).fill(null),
        dn: Line = new Array(n).fill(null);
      if (n < 3) return { lines: [] };
      let long = b.c[1] >= b.c[0];
      let sar = long ? Math.min(b.l[0], b.l[1]) : Math.max(b.h[0], b.h[1]);
      let ep = long ? Math.max(b.h[0], b.h[1]) : Math.min(b.l[0], b.l[1]);
      let af = step;
      for (let i = 2; i < n; i++) {
        sar = sar + af * (ep - sar);
        if (long) {
          sar = Math.min(sar, b.l[i - 1], b.l[i - 2]);
          if (b.l[i] < sar) {
            long = false;
            sar = ep;
            ep = b.l[i];
            af = step;
          } else if (b.h[i] > ep) {
            ep = b.h[i];
            af = Math.min(mx, af + step);
          }
        } else {
          sar = Math.max(sar, b.h[i - 1], b.h[i - 2]);
          if (b.h[i] > sar) {
            long = true;
            sar = ep;
            ep = b.h[i];
            af = step;
          } else if (b.l[i] < ep) {
            ep = b.l[i];
            af = Math.min(mx, af + step);
          }
        }
        (long ? up : dn)[i] = sar;
      }
      return {
        lines: [
          { key: "up", label: "SAR (long)", color: PAL.green, style: "dots", values: up },
          { key: "dn", label: "SAR (short)", color: PAL.red, style: "dots", values: dn },
        ],
      };
    },
  },
  {
    id: "supertrend",
    name: "Supertrend",
    group: "Trend & bands",
    pane: "price",
    params: [{ key: "period", label: "ATR period", def: 10, min: 1, max: 200 }, { key: "mult", label: "Multiplier", def: 3, min: 0.5, max: 10, step: 0.1 }],
    short: (p) => `Supertrend ${p.period}, ${p.mult}`,
    compute: (b, p) => {
      const a = atr(b, num(p, "period"));
      const k = num(p, "mult");
      const n = b.c.length;
      const upL: Line = new Array(n).fill(null),
        dnL: Line = new Array(n).fill(null);
      let fu = NaN,
        fl = NaN,
        trendUp = true;
      for (let i = 0; i < n; i++) {
        if (!nz(a[i])) continue;
        const mid = (b.h[i] + b.l[i]) / 2;
        const bu = mid + k * (a[i] as number);
        const bl = mid - k * (a[i] as number);
        fu = Number.isNaN(fu) || bu < fu || b.c[i - 1] > fu ? bu : fu;
        fl = Number.isNaN(fl) || bl > fl || b.c[i - 1] < fl ? bl : fl;
        if (trendUp && b.c[i] < fl) trendUp = false;
        else if (!trendUp && b.c[i] > fu) trendUp = true;
        if (trendUp) upL[i] = fl;
        else dnL[i] = fu;
      }
      return {
        lines: [
          { key: "up", label: "Up", color: PAL.green, width: 2, values: upL },
          { key: "dn", label: "Down", color: PAL.red, width: 2, values: dnL },
        ],
      };
    },
  },
  {
    id: "ichimoku",
    name: "Ichimoku clouds",
    group: "Trend & bands",
    pane: "price",
    params: [{ key: "conv", label: "Conversion", def: 9, min: 1, max: 100 }, { key: "base", label: "Base", def: 26, min: 1, max: 200 }, { key: "span", label: "Leading span B", def: 52, min: 1, max: 300 }],
    short: (p) => `Ichimoku ${p.conv}/${p.base}/${p.span}`,
    compute: (b, p) => {
      const mid = (n: number) => {
        const hh = highest(b.h, n),
          ll = lowest(b.l, n);
        return hh.map((h, i) => (nz(h) && nz(ll[i]) ? (h + (ll[i] as number)) / 2 : null));
      };
      const base = num(p, "base");
      const tenkan = mid(num(p, "conv"));
      const kijun = mid(base);
      const spanA = tenkan.map((t, i) => (nz(t) && nz(kijun[i]) ? (t + (kijun[i] as number)) / 2 : null));
      const spanB = mid(num(p, "span"));
      return {
        lines: [
          { key: "tenkan", label: "Conversion", color: PAL.blue, values: tenkan },
          { key: "kijun", label: "Base", color: PAL.red, values: kijun },
          { key: "a", label: "Span A", color: "rgba(63,191,74,0.8)", values: shift(spanA, base) },
          { key: "b", label: "Span B", color: "rgba(229,69,60,0.8)", values: shift(spanB, base) },
          { key: "lag", label: "Lagging", color: "rgba(180,142,240,0.8)", style: "dashed", values: shift(b.c, -base) },
        ],
      };
    },
  },
  {
    id: "keltner",
    name: "Keltner channel",
    group: "Trend & bands",
    pane: "price",
    params: [{ key: "period", label: "EMA period", def: 20, min: 1, max: 400 }, { key: "atr", label: "ATR period", def: 10, min: 1, max: 200 }, { key: "mult", label: "Multiplier", def: 2, min: 0.1, max: 10, step: 0.1 }],
    short: (p) => `Keltner ${p.period}, ${p.mult}`,
    compute: (b, p) => {
      const m = ema(b.c, num(p, "period"));
      const a = atr(b, num(p, "atr"));
      const k = num(p, "mult");
      return {
        lines: [
          { key: "up", label: "Upper", color: PAL.violet, values: m.map((x, i) => (nz(x) && nz(a[i]) ? x + k * (a[i] as number) : null)) },
          { key: "mid", label: "Mid", color: PAL.gray, style: "dashed", values: m },
          { key: "lo", label: "Lower", color: PAL.violet, values: m.map((x, i) => (nz(x) && nz(a[i]) ? x - k * (a[i] as number) : null)) },
        ],
      };
    },
  },
  {
    id: "donchian",
    name: "Donchian channel",
    group: "Trend & bands",
    pane: "price",
    params: [{ key: "period", label: "Period", def: 20, min: 1, max: 400 }],
    short: (p) => `Donchian ${p.period}`,
    compute: (b, p) => {
      const n = num(p, "period");
      const hh = highest(b.h, n),
        ll = lowest(b.l, n);
      return {
        lines: [
          { key: "up", label: "Upper", color: PAL.teal, values: hh },
          { key: "mid", label: "Mid", color: PAL.gray, style: "dashed", values: hh.map((h, i) => (nz(h) && nz(ll[i]) ? (h + (ll[i] as number)) / 2 : null)) },
          { key: "lo", label: "Lower", color: PAL.teal, values: ll },
        ],
      };
    },
  },
  {
    id: "adx",
    name: "ADX / DMS",
    group: "Trend & bands",
    pane: "sub",
    params: [{ key: "period", label: "Period", def: 14, min: 2, max: 200 }],
    short: (p) => `ADX ${p.period}`,
    compute: (b, p) => {
      const n = num(p, "period");
      const len = b.c.length;
      const pdm: number[] = [0],
        mdm: number[] = [0];
      for (let i = 1; i < len; i++) {
        const u = b.h[i] - b.h[i - 1],
          d = b.l[i - 1] - b.l[i];
        pdm.push(u > d && u > 0 ? u : 0);
        mdm.push(d > u && d > 0 ? d : 0);
      }
      const tr = wilder(trueRange(b), n);
      const sp = wilder(pdm, n),
        sm = wilder(mdm, n);
      const pdi = tr.map((t, i) => (nz(t) && t > 0 && nz(sp[i]) ? (100 * (sp[i] as number)) / t : null));
      const mdi = tr.map((t, i) => (nz(t) && t > 0 && nz(sm[i]) ? (100 * (sm[i] as number)) / t : null));
      const dx = pdi.map((x, i) => (nz(x) && nz(mdi[i]) && x + (mdi[i] as number) > 0 ? (100 * Math.abs(x - (mdi[i] as number))) / (x + (mdi[i] as number)) : null));
      const adx = onValid(dx, (x) => wilder(x, n));
      return {
        lines: [
          { key: "adx", label: "ADX", color: PAL.white, width: 2, values: adx },
          { key: "pdi", label: "+DI", color: PAL.green, values: pdi },
          { key: "mdi", label: "−DI", color: PAL.red, values: mdi },
        ],
        levels: [20, 25],
      };
    },
  },

  // ------------------------------------------------ momentum
  {
    id: "rsi",
    name: "RSI",
    group: "Momentum",
    pane: "sub",
    popular: true,
    params: [{ key: "period", label: "Period", def: 14, min: 2, max: 200 }, srcParam],
    short: (p) => `RSI ${p.period}`,
    compute: (b, p) => {
      const a = source(b, str(p, "src"));
      const n = num(p, "period");
      const g: number[] = [],
        l: number[] = [];
      for (let i = 1; i < a.length; i++) {
        const d = a[i] - a[i - 1];
        g.push(Math.max(0, d));
        l.push(Math.max(0, -d));
      }
      const ag = wilder(g, n),
        al = wilder(l, n);
      const r: Line = [null, ...ag.map((x, i) => (nz(x) && nz(al[i]) ? ((al[i] as number) === 0 ? 100 : 100 - 100 / (1 + x / (al[i] as number))) : null))];
      return { lines: [{ key: "rsi", label: "RSI", color: PAL.violet, width: 2, values: r }], levels: [30, 50, 70] };
    },
  },
  {
    id: "macd",
    name: "MACD",
    group: "Momentum",
    pane: "sub",
    popular: true,
    params: [{ key: "fast", label: "Fast", def: 12, min: 1, max: 200 }, { key: "slow", label: "Slow", def: 26, min: 2, max: 400 }, { key: "signal", label: "Signal", def: 9, min: 1, max: 100 }, { key: "maType", label: "MA type", def: "ema", options: MA_TYPES }],
    short: (p) => `MACD ${p.fast},${p.slow},${p.signal}`,
    compute: (b, p) => {
      const t = str(p, "maType");
      const f = movingAverage(t, b.c, num(p, "fast"), b.v),
        s = movingAverage(t, b.c, num(p, "slow"), b.v);
      const macd = f.map((x, i) => (nz(x) && nz(s[i]) ? x - (s[i] as number) : null));
      const sig = onValid(macd, (x) => movingAverage(t, x, num(p, "signal")));
      const hist = macd.map((x, i) => (nz(x) && nz(sig[i]) ? x - (sig[i] as number) : null));
      return {
        lines: [
          { key: "hist", label: "Histogram", color: PAL.gray, style: "histogram", values: hist, colors: hist.map((x, i) => (nz(x) ? (x >= 0 ? (i > 0 && nz(hist[i - 1]) && x < (hist[i - 1] as number) ? "rgba(63,191,74,0.45)" : "rgba(63,191,74,0.85)") : i > 0 && nz(hist[i - 1]) && x > (hist[i - 1] as number) ? "rgba(229,69,60,0.45)" : "rgba(229,69,60,0.85)") : null)) },
          { key: "macd", label: "MACD", color: PAL.blue, width: 2, values: macd },
          { key: "sig", label: "Signal", color: PAL.orange, values: sig },
        ],
        levels: [0],
      };
    },
  },
  {
    id: "stoch",
    name: "Stochastics",
    group: "Momentum",
    pane: "sub",
    params: [{ key: "k", label: "%K period", def: 14, min: 1, max: 200 }, { key: "smooth", label: "%K smoothing", def: 3, min: 1, max: 50 }, { key: "d", label: "%D period", def: 3, min: 1, max: 50 }],
    short: (p) => `Stoch ${p.k},${p.smooth},${p.d}`,
    compute: (b, p) => {
      const hh = highest(b.h, num(p, "k")),
        ll = lowest(b.l, num(p, "k"));
      const raw = b.c.map((c, i) => (nz(hh[i]) && nz(ll[i]) ? ((hh[i] as number) - (ll[i] as number) > 0 ? (100 * (c - (ll[i] as number))) / ((hh[i] as number) - (ll[i] as number)) : 50) : null));
      const k = onValid(raw, (x) => sma(x, num(p, "smooth")));
      const d = onValid(k, (x) => sma(x, num(p, "d")));
      return {
        lines: [
          { key: "k", label: "%K", color: PAL.blue, width: 2, values: k },
          { key: "d", label: "%D", color: PAL.orange, values: d },
        ],
        levels: [20, 80],
      };
    },
  },
  {
    id: "cci",
    name: "Commodity channel index",
    group: "Momentum",
    pane: "sub",
    params: [{ key: "period", label: "Period", def: 20, min: 2, max: 400 }],
    short: (p) => `CCI ${p.period}`,
    compute: (b, p) => {
      const n = num(p, "period");
      const tp = source(b, "hlc3");
      const m = sma(tp, n);
      const out: Line = tp.map((x, i) => {
        if (!nz(m[i])) return null;
        let md = 0;
        for (let k = i - n + 1; k <= i; k++) md += Math.abs(tp[k] - (m[i] as number));
        md /= n;
        return md > 0 ? (x - (m[i] as number)) / (0.015 * md) : 0;
      });
      return { lines: [{ key: "cci", label: "CCI", color: PAL.teal, width: 2, values: out }], levels: [-100, 0, 100] };
    },
  },
  {
    id: "willr",
    name: "Williams %R",
    group: "Momentum",
    pane: "sub",
    params: [{ key: "period", label: "Period", def: 14, min: 2, max: 400 }],
    short: (p) => `%R ${p.period}`,
    compute: (b, p) => {
      const n = num(p, "period");
      const hh = highest(b.h, n),
        ll = lowest(b.l, n);
      return {
        lines: [{ key: "wr", label: "%R", color: PAL.pink, width: 2, values: b.c.map((c, i) => (nz(hh[i]) && nz(ll[i]) && (hh[i] as number) > (ll[i] as number) ? (-100 * ((hh[i] as number) - c)) / ((hh[i] as number) - (ll[i] as number)) : null)) }],
        levels: [-80, -20],
      };
    },
  },
  {
    id: "roc",
    name: "Price rate of change",
    group: "Momentum",
    pane: "sub",
    params: [{ key: "period", label: "Period", def: 12, min: 1, max: 400 }],
    short: (p) => `ROC ${p.period}`,
    compute: (b, p) => {
      const n = num(p, "period");
      return { lines: [{ key: "roc", label: "ROC %", color: PAL.amber, width: 2, values: b.c.map((c, i) => (i >= n && b.c[i - n] ? (c / b.c[i - n] - 1) * 100 : null)) }], levels: [0] };
    },
  },

  // ------------------------------------------------ volatility
  {
    id: "atr",
    name: "Average true range",
    group: "Volatility",
    pane: "sub",
    params: [{ key: "period", label: "Period", def: 14, min: 1, max: 400 }],
    short: (p) => `ATR ${p.period}`,
    compute: (b, p) => ({ lines: [{ key: "atr", label: "ATR", color: PAL.orange, width: 2, values: atr(b, num(p, "period")) }] }),
  },

  // ------------------------------------------------ volume
  {
    id: "obv",
    name: "On balance volume",
    group: "Volume",
    pane: "sub",
    params: [{ key: "ma", label: "Signal MA (0 = off)", def: 20, min: 0, max: 400 }],
    short: () => "OBV",
    compute: (b, p) => {
      let o = 0;
      const out = b.c.map((c, i) => {
        if (i > 0) o += c > b.c[i - 1] ? b.v[i] : c < b.c[i - 1] ? -b.v[i] : 0;
        return o;
      });
      const lines: OutLine[] = [{ key: "obv", label: "OBV", color: PAL.blue, width: 2, values: out }];
      if (num(p, "ma") > 0) lines.push({ key: "sig", label: `SMA ${p.ma}`, color: PAL.orange, values: sma(out, num(p, "ma")) });
      return { lines };
    },
  },
  {
    id: "mfi",
    name: "Money flow index",
    group: "Volume",
    pane: "sub",
    params: [{ key: "period", label: "Period", def: 14, min: 2, max: 200 }],
    short: (p) => `MFI ${p.period}`,
    compute: (b, p) => {
      const n = num(p, "period");
      const tp = source(b, "hlc3");
      const out: Line = new Array(tp.length).fill(null);
      for (let i = n; i < tp.length; i++) {
        let pos = 0,
          neg = 0;
        for (let k = i - n + 1; k <= i; k++) {
          const f = tp[k] * b.v[k];
          if (tp[k] > tp[k - 1]) pos += f;
          else if (tp[k] < tp[k - 1]) neg += f;
        }
        out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
      }
      return { lines: [{ key: "mfi", label: "MFI", color: PAL.teal, width: 2, values: out }], levels: [20, 80] };
    },
  },
];

export const INDICATOR_BY_ID = new Map(INDICATORS.map((d) => [d.id, d]));

export function defaultParams(def: IndicatorDef): Params {
  return Object.fromEntries(def.params.map((p) => [p.key, p.def]));
}

/** An indicator on the chart: which study and its settings. */
export interface ActiveIndicator {
  uid: string;
  id: string;
  params: Params;
}

/** A fresh instance with defaults. Repeated moving averages get the next common period. */
export function newIndicator(id: string, existing: ActiveIndicator[]): ActiveIndicator | null {
  const def = INDICATOR_BY_ID.get(id);
  if (!def) return null;
  const params = defaultParams(def);
  if (id === "ma") {
    const used = new Set(existing.filter((x) => x.id === "ma").map((x) => Number(x.params.period)));
    params.period = [50, 20, 200, 100, 9, 10].find((n) => !used.has(n)) ?? 30;
  }
  return { uid: `${id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, id, params };
}

/** Palette rotation so several copies of the same study stay distinguishable. */
export const MA_COLORS = ["#f5c542", "#4fb3e8", "#e07b39", "#b48ef0", "#3cc9b5", "#ef6fae", "#e6e6e6"];

export const DEFAULT_INDICATORS: ActiveIndicator[] = [
  { uid: "default-ema21", id: "ma", params: { type: "ema", period: 21, src: "close", offset: 0 } },
  { uid: "default-sma50", id: "ma", params: { type: "sma", period: 50, src: "close", offset: 0 } },
  { uid: "default-sma200", id: "ma", params: { type: "sma", period: 200, src: "close", offset: 0 } },
];
