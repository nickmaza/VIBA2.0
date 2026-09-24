// VIBA technical engine: indicators, automatic support/resistance, and setup
// detection with exact entry / stop / take-profit levels.
//
// Pure functions over daily OHLCV bars, so the same code runs on the server
// (Plays board) and in the browser (Chart & Search). Everything here is
// rules-based arithmetic. It ranks and sizes risk; it does not predict.

export interface Bars {
  t: string[]; // ISO dates, oldest first
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

export type CheckState = "ok" | "pending" | "fail";
export interface Check {
  label: string;
  state: CheckState;
}
export type SetupStatus = "confirmed" | "pending" | "waiting";
export type SetupKey =
  | "extended"
  | "breakout-confirmed"
  | "pullback"
  | "oversold"
  | "breakout-pending"
  | "reclaim"
  | "breakdown";

export interface Setup {
  key: SetupKey;
  name: string;
  side: "long" | "short";
  status: SetupStatus;
  entry: number;
  entryType: string;
  stop: number;
  tp1: number;
  tp2: number;
  risk: number;
  riskPct: number;
  rr1: number;
  rr2: number;
  tp1Pct: number;
  tp2Pct: number;
  stopPct: number;
  checks: Check[];
  why: string;
  invalid: string;
}

export interface Level {
  price: number;
  touches: number;
  date: string | null;
  is52?: boolean;
}

export interface Indicators {
  close: number;
  date: string;
  atr: number;
  atrPct: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema21: number | null;
  rsi: number;
  volRatio: number | null;
  macdHist: number | null;
  macdRising: boolean;
  hi20: number;
  lo10: number;
  hi52: number;
  lo52: number;
  offHi: number;
  trendUp: boolean;
  trendDown: boolean;
  r1m: number | null;
  r3m: number | null;
  r12m: number | null;
}

export interface Analysis {
  ind: Indicators;
  levels: { resistance: Level[]; support: Level[] };
  setups: Setup[];
  primary: Setup | null;
  trend: "Uptrend" | "Downtrend" | "Mixed / range";
  narrative: string[];
  noSetup: string | null;
  series: {
    sma20: (number | null)[];
    sma50: (number | null)[];
    sma200: (number | null)[];
    ema21: (number | null)[];
    rsi: (number | null)[];
  };
}

export type AnalysisResult = Analysis | { error: string };

export function isAnalysis(a: AnalysisResult): a is Analysis {
  return !("error" in a);
}

// ---------- indicators ----------
export function sma(a: number[], n: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) o[i] = s / n;
  }
  return o;
}

export function ema(a: number[], n: number): (number | null)[] {
  const o: (number | null)[] = new Array(a.length).fill(null);
  const k = 2 / (n + 1);
  let p: number | null = null;
  for (let i = 0; i < a.length; i++) {
    if (i < n - 1) continue;
    if (p === null) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += a[j];
      p = s / n;
    } else p = a[i] * k + p * (1 - k);
    o[i] = p;
  }
  return o;
}

function rsi(c: number[], n = 14): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null);
  if (c.length <= n) return o;
  let g = 0,
    l = 0;
  for (let i = 1; i <= n; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  g /= n;
  l /= n;
  o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}

function atr(h: number[], l: number[], c: number[], n = 14): (number | null)[] {
  const o: (number | null)[] = new Array(c.length).fill(null);
  const tr = [h[0] - l[0]];
  for (let i = 1; i < c.length; i++)
    tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  if (c.length < n) return o;
  let s = 0;
  for (let i = 0; i < n; i++) s += tr[i];
  let p = s / n;
  o[n - 1] = p;
  for (let i = n; i < c.length; i++) {
    p = (p * (n - 1) + tr[i]) / n;
    o[i] = p;
  }
  return o;
}

function macdHist(c: number[]): (number | null)[] {
  const f = ema(c, 12),
    s = ema(c, 26);
  const m = c.map((_, i) => (f[i] !== null && s[i] !== null ? (f[i] as number) - (s[i] as number) : null));
  const start = m.findIndex((x) => x !== null);
  const sig: (number | null)[] = new Array(c.length).fill(null);
  if (start >= 0) {
    const sub = ema(m.slice(start) as number[], 9);
    for (let i = 0; i < sub.length; i++) sig[start + i] = sub[i];
  }
  return m.map((x, i) => (x !== null && sig[i] !== null ? x - (sig[i] as number) : null));
}

const r2 = (x: number) => Math.round(x * 100) / 100;
function maxOf(a: number[], from: number, to: number) {
  let m = -Infinity;
  for (let i = Math.max(0, from); i <= to; i++) if (a[i] > m) m = a[i];
  return m;
}
function minOf(a: number[], from: number, to: number) {
  let m = Infinity;
  for (let i = Math.max(0, from); i <= to; i++) if (a[i] < m) m = a[i];
  return m;
}

export function money(x: number): string {
  return "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- levels ----------
interface RawLevel {
  price: number;
  touches: number;
  lastIdx: number | null;
  date: string | null;
  is52?: boolean;
}

/** Swing highs/lows (5 bars each side) over the last year, clustered within ~0.6 ATR. */
function clusterLevels(B: Bars, A: number): RawLevel[] {
  const n = B.c.length,
    from = Math.max(0, n - 260),
    k = 5;
  const pts: { i: number; p: number }[] = [];
  for (let i = Math.max(k, from); i < n - k; i++) {
    let isH = true,
      isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (B.h[j] > B.h[i]) isH = false;
      if (B.l[j] < B.l[i]) isL = false;
    }
    if (isH) pts.push({ i, p: B.h[i] });
    if (isL) pts.push({ i, p: B.l[i] });
  }
  pts.sort((a, b) => a.p - b.p);
  const tol = Math.max(A * 0.6, B.c[n - 1] * 0.006);
  const cl: { pts: { i: number; p: number }[]; sum: number }[] = [];
  for (const pt of pts) {
    const last = cl[cl.length - 1];
    if (last && Math.abs(pt.p - last.sum / last.pts.length) <= tol) {
      last.pts.push(pt);
      last.sum += pt.p;
    } else cl.push({ pts: [pt], sum: pt.p });
  }
  return cl.map((g) => {
    const li = Math.max(...g.pts.map((x) => x.i));
    return { price: g.sum / g.pts.length, touches: g.pts.length, lastIdx: li, date: B.t[li] };
  });
}

// ---------- main ----------
type Draft = Omit<Setup, "status" | "risk" | "riskPct" | "rr1" | "rr2" | "tp1Pct" | "tp2Pct" | "stopPct" | "tp1" | "tp2"> & {
  status?: SetupStatus;
  tp1: number | null;
  tp2: number | null;
};

export function analyze(B: Bars): AnalysisResult {
  const n = B.c.length;
  if (n < 60) return { error: `Not enough price history (${n} bars). At least 60 daily bars are needed.` };
  const { c, h, l, o, v } = B;
  const L = n - 1;
  const S20 = sma(c, 20),
    S50 = sma(c, 50),
    S200 = sma(c, 200),
    E21 = ema(c, 21),
    R = rsi(c, 14),
    ATR = atr(h, l, c, 14),
    MH = macdHist(c),
    V50 = sma(v, 50);
  const C = c[L],
    a = ATR[L] as number,
    s20 = S20[L] as number,
    s50 = S50[L] as number,
    s200 = S200[L],
    e21 = E21[L] as number,
    r = R[L] as number;
  const vr = V50[L] ? v[L] / (V50[L] as number) : null;
  const mh = MH[L],
    mhPrev = MH[L - 1];
  const hi20 = maxOf(h, L - 19, L),
    lo10 = minOf(l, L - 9, L),
    hi10 = maxOf(h, L - 9, L),
    hi52 = maxOf(h, L - 251, L),
    lo52 = minOf(l, L - 251, L);
  const has200 = s200 !== null;
  const trendUp = has200 ? C > (s200 as number) && s50 > (s200 as number) : C > s50;
  const trendDown = has200 ? C < (s200 as number) && s50 < (s200 as number) : C < s50;

  const raw = clusterLevels(B, a);
  const res = raw.filter((x) => x.price > C + 0.15 * a).sort((x, y) => x.price - y.price);
  const sup = raw.filter((x) => x.price < C - 0.15 * a).sort((x, y) => y.price - x.price);
  const pick = (list: RawLevel[]) => {
    const strong = list.filter((x) => x.touches >= 2 || (x.lastIdx !== null && L - x.lastIdx <= 60));
    return (strong.length ? strong : list).slice(0, 3);
  };
  let R3 = pick(res);
  const S3 = pick(sup);
  if (hi52 > C + 0.15 * a && !R3.some((x) => Math.abs(x.price - hi52) < 0.6 * a))
    R3.push({ price: hi52, touches: 1, lastIdx: null, date: null, is52: true });
  R3 = R3.sort((x, y) => x.price - y.price).slice(0, 3);
  const R1 = R3[0] ?? null,
    R2 = R3[1] ?? null,
    S1 = S3[0] ?? null;

  const ind: Indicators = {
    close: C,
    date: B.t[L],
    atr: a,
    atrPct: (a / C) * 100,
    sma20: s20,
    sma50: s50,
    sma200: s200,
    ema21: e21,
    rsi: r,
    volRatio: vr,
    macdHist: mh,
    macdRising: mh !== null && mhPrev !== null && mh > mhPrev,
    hi20,
    lo10,
    hi52,
    lo52,
    offHi: (C / hi52 - 1) * 100,
    trendUp,
    trendDown,
    r1m: n > 21 ? (C / c[L - 21] - 1) * 100 : null,
    r3m: n > 63 ? (C / c[L - 63] - 1) * 100 : null,
    r12m: n > 252 ? (C / c[L - 252] - 1) * 100 : null,
  };

  const setups: Setup[] = [];
  const chk = (label: string, ok: boolean, pending = false): Check => ({
    label,
    state: ok ? "ok" : pending ? "pending" : "fail",
  });
  const finish = (d: Draft) => {
    const entry = r2(d.entry);
    let stop = r2(d.stop);
    let risk = Math.abs(entry - stop);
    const dir = d.side === "short" ? -1 : 1;
    if (risk < 0.8 * a) {
      stop = r2(entry - dir * 0.8 * a);
      risk = Math.abs(entry - stop);
    }
    let tp1 = d.tp1;
    if (tp1 === null || dir * (tp1 - entry) < 1.0 * risk) tp1 = entry + dir * 2 * risk;
    let tp2 = d.tp2;
    if (tp2 === null || dir * (tp2 - tp1) < 0.5 * risk)
      tp2 = entry + dir * Math.max(3 * risk, Math.abs(tp1 - entry) + 1.5 * risk);
    tp1 = r2(tp1);
    tp2 = r2(tp2);
    const need = d.checks.filter((x) => x.state !== "ok");
    setups.push({
      ...d,
      entry,
      stop,
      tp1,
      tp2,
      status: d.status ?? (need.length === 0 ? "confirmed" : "pending"),
      risk: r2(risk),
      riskPct: r2((risk / entry) * 100),
      rr1: r2(Math.abs(tp1 - entry) / risk),
      rr2: r2(Math.abs(tp2 - entry) / risk),
      tp1Pct: r2((tp1 / entry - 1) * 100),
      tp2Pct: r2((tp2 / entry - 1) * 100),
      stopPct: r2((stop / entry - 1) * 100),
    });
  };
  const nextAbove = (p: number) =>
    R3.concat(res)
      .filter((q) => q.price > p + 0.3 * a)
      .sort((x, y) => x.price - y.price)[0]?.price ?? null;
  const nextBelow = (p: number) =>
    S3.concat(sup)
      .filter((q) => q.price < p - 0.3 * a)
      .sort((x, y) => y.price - x.price)[0]?.price ?? null;
  const extended = trendUp && (r >= 75 || C - e21 > 2.5 * a);

  // 1. Breakout confirmed: a 2+ touch level crossed in the last 5 sessions and still holding.
  let bo: { lv: RawLevel; idx: number } | null = null;
  for (const lv of sup.concat(raw.filter((x) => x.price <= C))) {
    if (bo || lv.touches < 2 || lv.price < C - 2 * a) continue;
    for (let k = 1; k <= 5 && !bo; k++) {
      const ix = L - k + 1;
      if (c[ix - 1] <= lv.price && c[ix] > lv.price && maxOf(c, ix - 30, ix - 1) <= lv.price + 0.2 * a) {
        let held = true;
        for (let q = ix; q <= L; q++) if (c[q] <= lv.price) held = false;
        if (held) bo = { lv, idx: ix };
      }
    }
  }
  if (bo && C > s50) {
    const bvr = V50[bo.idx] ? v[bo.idx] / (V50[bo.idx] as number) : 0;
    const Lp = bo.lv.price;
    const near = C - Lp <= 1.2 * a;
    const baseLow = minOf(l, L - 40, L);
    finish({
      key: "breakout-confirmed",
      name: "Breakout (confirmed)",
      side: "long",
      entry: near ? C : Lp + 0.25 * a,
      entryType: near
        ? "Buy near current price, or add on a retest of the breakout level"
        : "Limit buy on a retest of the breakout level",
      stop: Lp - 1.0 * a,
      tp1: nextAbove(C),
      tp2: Lp + (Lp - baseLow),
      checks: [
        chk(`Closed above ${money(Lp)} (${bo.lv.touches}-touch level) on ${B.t[bo.idx]}`, true),
        chk(`Breakout volume ≥ 1.3× 50-day average (was ${bvr.toFixed(1)}×)`, bvr >= 1.3, true),
        chk("Still holding above the breakout level", C > Lp),
        chk("Above the 50-day average", C > s50),
      ],
      why: `Price broke through resistance at ${money(Lp)} that had capped it ${bo.lv.touches} times, and is holding above it. Old resistance should now act as support. The measured move from the ${money(baseLow)} base projects toward ${money(Lp + (Lp - baseLow))}.`,
      invalid: `A daily close back below ${money(Lp)} turns this into a failed breakout.`,
    });
  }

  // 2. Breakout pending: coiling just under resistance.
  if (R1 && C > s50 && (!has200 || C > (s200 as number)) && R1.price - C <= 1.5 * a && (R1.price - C) / C <= 0.05) {
    const ent = R1.price + 0.1 * a;
    const nx = nextAbove(ent);
    finish({
      key: "breakout-pending",
      name: "Breakout (needs confirmation)",
      side: "long",
      entry: ent,
      entryType: "Buy-stop just above resistance; only fills if price breaks out",
      stop: Math.max(lo10 - 0.1 * a, ent - 2 * a),
      tp1: nx,
      tp2: null,
      checks: [
        chk(`Trading above the 50-day${has200 ? " and 200-day" : ""} averages`, true),
        chk(`RSI above 50 (now ${r.toFixed(0)})`, r > 50),
        chk(`Daily close above ${money(R1.price)}${R1.is52 ? " (52-week high)" : ""}`, false, true),
        chk("Breakout volume ≥ 1.5× average", false, true),
      ],
      why: `Price is coiling ${((R1.price / C - 1) * 100).toFixed(1)}% under ${R1.is52 ? "its 52-week high" : "resistance"} at ${money(R1.price)}${R1.touches > 1 ? `, a level that has turned it back ${R1.touches} times` : ""}. A close through it on volume opens room toward ${nx ? money(nx) : "new highs"}.`,
      invalid: `No trade unless the breakout happens. After entry, a close back below ${money(R1.price)} is the first warning.`,
    });
  }

  // 3. Extended: trend is fine, price is not.
  if (extended) {
    const zone = e21;
    const sp = Math.min(s50, nextBelow(zone) ?? s50) - 0.5 * a;
    finish({
      key: "extended",
      name: "Extended — wait for pullback",
      side: "long",
      status: "waiting",
      entry: zone,
      entryType: "Limit buy near the 21-day EMA after the run cools off",
      stop: Math.max(sp, zone - 3 * a),
      tp1: hi20,
      tp2: null,
      checks: [
        chk("Uptrend intact (above rising 50-day and 200-day)", true),
        chk(`Price pulls back into the ${money(zone)} zone`, false, true),
        chk(`RSI resets below 65 (now ${r.toFixed(0)})`, r < 65, true),
        chk("Holds the 21-day EMA on a closing basis", false, true),
      ],
      why: `The trend is strong but price is ${((C / e21 - 1) * 100).toFixed(1)}% above its 21-day EMA${r >= 75 ? ` with RSI at ${r.toFixed(0)}` : ""}. Buying here means chasing. The better entry is a pullback toward ${money(zone)}, where risk to the stop is much smaller.`,
      invalid: `If price closes below the 50-day (${money(s50)}) before reaching the zone, stand aside.`,
    });
  }

  // 4. Pullback to support inside an uptrend.
  if (trendUp && !extended && r >= 30 && r <= 62 && C >= s50 - 0.5 * a) {
    const cands: { p: number; n: string }[] = [
      { p: e21, n: "21-day EMA" },
      { p: s50, n: "50-day average" },
    ];
    if (S1) cands.push({ p: S1.price, n: `support at ${money(S1.price)}` });
    const z = cands
      .filter((x) => Math.abs(C - x.p) <= 1.3 * a && x.p <= C + 0.3 * a)
      .sort((x, y) => y.p - x.p)[0];
    if (z) {
      const reversal = c[L] > h[L - 1] || (c[L] > o[L] && Math.min(o[L], c[L]) - l[L] > (h[L] - l[L]) * 0.4);
      const ent2 = reversal ? C : Math.min(h[L] + 0.05 * a, C + 0.75 * a);
      const st2 = Math.max(Math.min(z.p, lo10) - 0.5 * a, ent2 - 3 * a);
      finish({
        key: "pullback",
        name: "Pullback to support",
        side: "long",
        entry: ent2,
        entryType: reversal
          ? "Buy at current price; the reversal bar is in"
          : `Buy-stop at ${money(ent2)} so the order only fills once price turns up off support`,
        stop: st2,
        tp1: hi20 > ent2 ? hi20 : null,
        tp2: hi52 > ent2 ? hi52 : null,
        checks: [
          chk("Uptrend: 50-day above 200-day, price above 200-day", true),
          chk(`Pulled back to the ${z.n} (${money(z.p)})`, true),
          chk(`RSI reset to ${r.toFixed(0)} (not overbought)`, true),
          chk("Bullish reversal candle off support", reversal, true),
        ],
        why: `The primary trend is up and price has pulled back to the ${z.n}. This is the lower-risk way to join an uptrend: the stop sits just under support, and the first target is the recent ${money(hi20)} high.`,
        invalid: `A daily close below ${money(st2)} means support failed.`,
      });
    }
  }

  // 5. Oversold bounce inside a long-term uptrend.
  if (has200 && C > (s200 as number) && r <= 32) {
    const ent3 = Math.min(h[L] + 0.05 * a, C + 0.75 * a);
    finish({
      key: "oversold",
      name: "Oversold bounce",
      side: "long",
      entry: ent3,
      entryType: "Buy-stop above today's high to confirm buyers stepped in",
      stop: minOf(l, L - 4, L) - 0.3 * a,
      tp1: s20 > ent3 ? s20 : null,
      tp2: s50 > ent3 ? s50 : null,
      checks: [
        chk("Still above the 200-day average", true),
        chk(`RSI oversold at ${r.toFixed(0)}`, true),
        chk(`Price trades up through ${money(ent3)}`, false, true),
      ],
      why: `A sharp selloff pushed RSI to ${r.toFixed(0)} while the long-term trend is still up. These usually snap back toward the 20-day average (${money(s20)}). This is a short-term trade, not a trend entry.`,
      invalid: `A new low below ${money(minOf(l, L - 4, L))} cancels the bounce.`,
    });
  }

  // 6. Reclaim of the 200-day while the 50-day is still below it.
  if (has200 && C > (s200 as number) && s50 < (s200 as number)) {
    let crossed = false;
    for (let k = 1; k <= 10; k++) if (S200[L - k] !== null && c[L - k] < (S200[L - k] as number)) crossed = true;
    if (crossed) {
      finish({
        key: "reclaim",
        name: "200-day reclaim",
        side: "long",
        entry: C,
        entryType: "Buy near current price or on a retest of the 200-day",
        stop: (s200 as number) - 1.0 * a,
        tp1: R1 ? R1.price : null,
        tp2: R2 ? R2.price : null,
        checks: [
          chk(`Closed back above the 200-day (${money(s200 as number)})`, true),
          chk("50-day turns up through the 200-day (golden cross)", false, true),
          chk("Holds above the 200-day for 3+ sessions", false, true),
        ],
        why: "Price recently climbed back above its 200-day average, often the first sign a downtrend is ending. It is early: the 50-day is still below the 200-day.",
        invalid: `A close back under the 200-day (${money(s200 as number)}).`,
      });
    }
  }

  // 7. Breakdown (short) in a downtrend sitting on support.
  if (trendDown && S1 && C - S1.price <= 1.5 * a) {
    const ent4 = S1.price - 0.1 * a;
    const nb = nextBelow(ent4);
    finish({
      key: "breakdown",
      name: "Breakdown (short, needs confirmation)",
      side: "short",
      entry: ent4,
      entryType: "Sell-short stop just under support; only fills if support breaks",
      stop: Math.max(ent4 + 1 * a, Math.min(hi10 + 0.1 * a, ent4 + 2.5 * a)),
      tp1: nb,
      tp2: null,
      checks: [
        chk("Downtrend: below a falling 50-day and 200-day", true),
        chk(`Daily close below ${money(S1.price)}`, false, true),
        chk("Breakdown volume ≥ 1.5× average", false, true),
      ],
      why: `Price is in a downtrend and sitting just above support at ${money(S1.price)}. If that gives way, the next support is ${nb ? money(nb) : "well below"}. Shorting carries unlimited risk; long-only traders should treat this as a reason to avoid the stock.`,
      invalid: `A close back above ${money(Math.min(hi10, s50))}.`,
    });
  }

  const order: SetupKey[] = ["extended", "breakout-confirmed", "pullback", "oversold", "breakout-pending", "reclaim", "breakdown"];
  setups.sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key));
  const primary = setups[0] ?? null;
  const trend = trendUp ? "Uptrend" : trendDown ? "Downtrend" : "Mixed / range";
  const levels = {
    resistance: R3.map((x) => ({ price: r2(x.price), touches: x.touches, date: x.date, is52: !!x.is52 })),
    support: S3.map((x) => ({ price: r2(x.price), touches: x.touches, date: x.date })),
  };
  let noSetup: string | null = null;
  if (!primary) {
    noSetup = trendDown
      ? `No long setup. Price is below a falling 200-day average. It needs to reclaim the 50-day (${money(s50)})${has200 ? ` and then the 200-day (${money(s200 as number)})` : ""} before a long trade makes sense.`
      : `No clean setup right now. Price is between support${S1 ? ` at ${money(S1.price)}` : ""} and resistance${R1 ? ` at ${money(R1.price)}` : ""}. Wait for a test of either level.`;
  }
  return {
    ind,
    levels,
    setups,
    primary,
    trend,
    narrative: buildNarrative(ind, levels, trend),
    noSetup,
    series: { sma20: S20, sma50: S50, sma200: S200, ema21: E21, rsi: R },
  };
}

function buildNarrative(I: Indicators, lv: { resistance: Level[]; support: Level[] }, trend: string): string[] {
  const p: string[] = [];
  const ma: string[] = [];
  if (I.ema21 !== null) ma.push(`${I.close > I.ema21 ? "above" : "below"} the 21-day EMA (${money(I.ema21)})`);
  if (I.sma50 !== null) ma.push(`${I.close > I.sma50 ? "above" : "below"} the 50-day (${money(I.sma50)})`);
  if (I.sma200 !== null) ma.push(`${I.close > I.sma200 ? "above" : "below"} the 200-day (${money(I.sma200)})`);
  p.push(
    `${trend}. Closed at ${money(I.close)} on ${I.date}, ${ma.join(", ")}.` +
      (I.sma200 !== null && I.sma50 !== null ? ` The 50-day is ${I.sma50 > I.sma200 ? "above" : "below"} the 200-day.` : "")
  );
  const rs = I.rsi >= 70 ? "overbought" : I.rsi >= 55 ? "bullish" : I.rsi >= 45 ? "neutral" : I.rsi >= 30 ? "weak" : "oversold";
  p.push(
    `RSI(14) is ${I.rsi.toFixed(0)} (${rs}). MACD histogram is ${(I.macdHist ?? 0) >= 0 ? "positive" : "negative"} and ${I.macdRising ? "rising" : "falling"}. Last session volume was ${I.volRatio ? I.volRatio.toFixed(1) + "×" : "n/a"} the 50-day average. ATR(14) is ${money(I.atr)} (${I.atrPct.toFixed(1)}% of price), which is the typical daily range.`
  );
  const r = lv.resistance[0],
    s = lv.support[0];
  p.push(
    `Nearest resistance: ${r ? money(r.price) + (r.is52 ? " (52-week high)" : ` (${r.touches} touch${r.touches > 1 ? "es" : ""})`) : "none overhead, price is at highs"}. Nearest support: ${s ? `${money(s.price)} (${s.touches} touch${s.touches > 1 ? "es" : ""})` : "none nearby"}. Price is ${Math.abs(I.offHi).toFixed(1)}% ${I.offHi < -0.05 ? "below" : "at"} its 52-week high.`
  );
  return p;
}
