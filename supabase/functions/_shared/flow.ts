// Money-flow metrics from daily OHLCV: is volume confirming the price move
// (accumulation) or leaning against it (distribution)?
//
// These are the classic "follow the volume" reads that institutions leave
// behind when they build or unwind large positions over days and weeks:
//   CMF    Chaikin Money Flow (20d): where each bar closes inside its range, volume-weighted
//   OBV    On-Balance Volume slope (20d): net up-day minus down-day volume, as a share of volume
//   U/D    up-day volume / down-day volume (20d)
//   A/D    accumulation vs distribution days (25d): up or down closes on above-average volume
//   RVOL   5-day average volume vs the prior 50 days
import type { Bars } from "./ta.ts";

export type FlowLabel = "Strong accumulation" | "Accumulation" | "Neutral" | "Distribution" | "Heavy distribution";

export interface Flow {
  score: number; // 0..100, 50 = neutral
  label: FlowLabel;
  cmf: number; // -1..+1
  obvSlope: number; // -1..+1
  upDownVol: number; // ratio
  accDays: number;
  distDays: number;
  relVol5: number;
  dollarVol20: number; // average daily dollar volume, 20d
  r1m: number | null; // % return, 21 sessions
  r3m: number | null; // % return, 63 sessions
  above50: boolean;
  above200: boolean | null;
  last: number;
  date: string;
}

export function flowLabel(score: number): FlowLabel {
  if (score >= 70) return "Strong accumulation";
  if (score >= 57) return "Accumulation";
  if (score > 43) return "Neutral";
  if (score > 30) return "Distribution";
  return "Heavy distribution";
}

export function moneyFlow(B: Bars): Flow | null {
  const n = B.c.length;
  if (n < 60) return null;
  const { h, l, c, v } = B;
  const L = n - 1;
  const mfm = (i: number) => (h[i] - l[i] > 0 ? (c[i] - l[i] - (h[i] - c[i])) / (h[i] - l[i]) : 0);

  let mfv = 0, vol20 = 0, obv = 0, up = 0, dn = 0, dollar = 0;
  for (let i = L - 19; i <= L; i++) {
    mfv += mfm(i) * v[i];
    vol20 += v[i];
    dollar += c[i] * v[i];
    if (c[i] > c[i - 1]) { obv += v[i]; up += v[i]; }
    else if (c[i] < c[i - 1]) { obv -= v[i]; dn += v[i]; }
  }
  const cmf = vol20 > 0 ? mfv / vol20 : 0;
  const obvSlope = vol20 > 0 ? obv / vol20 : 0;
  const upDownVol = dn > 0 ? up / dn : up > 0 ? 3 : 1;

  let accDays = 0, distDays = 0;
  for (let i = L - 24; i <= L; i++) {
    let s = 0;
    for (let j = i - 50; j < i; j++) s += v[Math.max(0, j)];
    const avg = s / 50;
    const ch = c[i] / c[i - 1] - 1;
    if (v[i] > avg && ch > 0.002) accDays++;
    if (v[i] > avg && ch < -0.002) distDays++;
  }
  let v5 = 0, v50 = 0;
  for (let i = L - 4; i <= L; i++) v5 += v[i];
  for (let i = L - 54; i <= L - 5; i++) v50 += v[Math.max(0, i)];
  const relVol5 = v50 > 0 ? v5 / 5 / (v50 / 50) : 1;

  const composite =
    1.1 * cmf + 0.7 * obvSlope + 0.2 * Math.log(Math.max(0.2, Math.min(5, upDownVol))) + 0.035 * (accDays - distDays);
  const score = Math.round(50 + 50 * Math.tanh(composite));

  let s50 = 0;
  for (let i = L - 49; i <= L; i++) s50 += c[i];
  let above200: boolean | null = null;
  if (n >= 200) {
    let s200 = 0;
    for (let i = L - 199; i <= L; i++) s200 += c[i];
    above200 = c[L] > s200 / 200;
  }
  return {
    score,
    label: flowLabel(score),
    cmf,
    obvSlope,
    upDownVol,
    accDays,
    distDays,
    relVol5,
    dollarVol20: dollar / 20,
    r1m: n > 21 ? (c[L] / c[L - 21] - 1) * 100 : null,
    r3m: n > 63 ? (c[L] / c[L - 63] - 1) * 100 : null,
    above50: c[L] > s50 / 50,
    above200,
    last: c[L],
    date: B.t[L],
  };
}

/** % change of the ratio a/b over the last `k` sessions, aligned by date. */
export function ratioChange(a: Bars, b: Bars, k = 20): number | null {
  const idx = new Map(b.t.map((t, i) => [t, i]));
  const pts: number[] = [];
  for (let i = 0; i < a.t.length; i++) {
    const j = idx.get(a.t[i]);
    if (j !== undefined && b.c[j] > 0) pts.push(a.c[i] / b.c[j]);
  }
  if (pts.length <= k) return null;
  return (pts[pts.length - 1] / pts[pts.length - 1 - k] - 1) * 100;
}
