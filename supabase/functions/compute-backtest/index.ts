// compute-backtest
//
// Monthly sector-rotation backtest on the 11 SPDR sector ETFs, recomputed
// from the stored price history (raw_prices, dividend-adjusted closes from
// Yahoo Finance) and the stored regime score (regime_history):
//
//   signal   at each month-end, every sector with enough history gets the
//            same score the live ranking uses: (0.2*r3 + 0.3*r6 + 0.5*r12) / vol126
//   baseline equal weight in every eligible sector
//   top3     equal weight in the 3 highest scores
//   dual     top3, but in 1-3y Treasuries (SHY) when the SPY regime score at
//            month-end is at or below -0.4 (risk-off or worse)
//   bottom3  equal weight in the 3 lowest scores (sanity check)
// Holdings are rebalanced monthly; returns are total returns (dividends
// reinvested); no costs or slippage. The current month is included to date.
//
// Writes backtest_curves (growth of $1 by month since 2016-01) and
// backtest_stats. Auth: x-refresh-secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry } from "../_shared/common.ts";

const SECTORS = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE", "XLC"];
const CASH = "SHY";
const START_MONTH = "2016-01";
const REGIME_CUTOFF = -0.4;
const LABELS: Record<string, string> = {
  baseline: "Equal-weight (baseline)",
  top3: "Top-3 momentum",
  dual: "Top-3 + regime filter",
  bottom3: "Bottom-3 (sanity check)",
};

function stddev(x: number[], sample = false): number {
  if (x.length < 2) return 0;
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - (sample ? 1 : 0)));
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const t0 = Date.now();
  try {
    const bars = (await withRetry("bars_json_many", () =>
      sb.rpc("bars_json_many", { p_symbols: [...SECTORS, CASH, "SPY"], p_since: "2013-01-01" })
    )) as Record<string, { t: string[]; a: number[] }> | null;
    if (!bars?.SPY) throw new Error("no SPY history in raw_prices");

    // calendar: SPY sessions; per-symbol adjusted close maps
    const cal = bars.SPY.t;
    const px = new Map<string, Map<string, number>>();
    for (const s of [...SECTORS, CASH]) {
      const b = bars[s];
      if (b) px.set(s, new Map(b.t.map((d, i) => [d, Number(b.a[i])])));
    }

    // month-end sessions (last SPY session of each month) + the latest session
    const monthEnds: string[] = [];
    for (let i = 0; i < cal.length; i++) {
      const next = cal[i + 1];
      if (!next || next.slice(0, 7) !== cal[i].slice(0, 7)) monthEnds.push(cal[i]);
    }
    const idxOf = new Map(cal.map((d, i) => [d, i]));

    // regime score (SPY composite) as of each date
    const regime: { d: string; spy: number }[] = [];
    for (let from = 0; from < 20000; from += 1000) {
      const { data } = await sb.from("regime_history").select("d,spy").order("d").range(from, from + 999);
      const rows = (data ?? []) as { d: string; spy: number }[];
      regime.push(...rows.map((r) => ({ d: r.d, spy: Number(r.spy) })));
      if (rows.length < 1000) break;
    }
    const regimeAt = (d: string): number | null => {
      let lo = 0, hi = regime.length - 1, ans: number | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (regime[mid].d <= d) {
          ans = regime[mid].spy;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return ans;
    };

    // momentum score for one sector at calendar index i (needs 252 + 126 sessions)
    const scoreAt = (s: string, i: number): number | null => {
      const m = px.get(s);
      if (!m || i < 252) return null;
      const at = (k: number) => m.get(cal[i - k]);
      const last = at(0), c63 = at(63), c126 = at(126), c252 = at(252);
      if (!last || !c63 || !c126 || !c252) return null;
      const rets: number[] = [];
      for (let k = 125; k >= 0; k--) {
        const a = m.get(cal[i - k - 1]), b = m.get(cal[i - k]);
        if (!a || !b) return null;
        rets.push(b / a - 1);
      }
      const vol = stddev(rets) * Math.sqrt(252);
      if (!(vol > 0)) return null;
      return (0.2 * (last / c63 - 1) + 0.3 * (last / c126 - 1) + 0.5 * (last / c252 - 1)) / vol;
    };
    const ret = (s: string, from: string, to: string): number | null => {
      const m = px.get(s);
      const a = m?.get(from), b = m?.get(to);
      return a && b ? b / a - 1 : null;
    };
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

    // walk month by month: signal at month-end t, hold through the next month-end
    const monthly: Record<string, { month: string; r: number }[]> = { baseline: [], top3: [], dual: [], bottom3: [] };
    let cashMonths = 0;
    for (let k = 0; k + 1 < monthEnds.length; k++) {
      const t = monthEnds[k], t1 = monthEnds[k + 1];
      const month = t1.slice(0, 7);
      if (month < START_MONTH) continue;
      const i = idxOf.get(t)!;
      const scored = SECTORS.map((s) => ({ s, score: scoreAt(s, i) }))
        .filter((x): x is { s: string; score: number } => x.score !== null && ret(x.s, t, t1) !== null)
        .sort((a, b) => b.score - a.score);
      if (scored.length < 6) continue;
      const r = (list: string[]) => avg(list.map((s) => ret(s, t, t1)!));
      const top = scored.slice(0, 3).map((x) => x.s);
      const bottom = scored.slice(-3).map((x) => x.s);
      const reg = regimeAt(t);
      const riskOff = reg !== null && reg <= REGIME_CUTOFF;
      if (riskOff) cashMonths++;
      monthly.baseline.push({ month, r: r(scored.map((x) => x.s)) });
      monthly.top3.push({ month, r: r(top) });
      monthly.bottom3.push({ month, r: r(bottom) });
      monthly.dual.push({ month, r: riskOff ? ret(CASH, t, t1) ?? 0 : r(top) });
    }
    if (!monthly.baseline.length) throw new Error("not enough sector history to run the backtest");

    const curves: { strategy: string; month: string; growth: number }[] = [];
    const stats: Record<string, unknown>[] = [];
    for (const [strategy, rows] of Object.entries(monthly)) {
      let g = 1, peak = 1, maxDd = 0;
      for (const x of rows) {
        g *= 1 + x.r;
        peak = Math.max(peak, g);
        maxDd = Math.min(maxDd, g / peak - 1);
        curves.push({ strategy, month: x.month, growth: Math.round(g * 10000) / 10000 });
      }
      const rs = rows.map((x) => x.r);
      const years = rs.length / 12;
      const annVol = stddev(rs, true) * Math.sqrt(12);
      const annRet = avg(rs) * 12;
      stats.push({
        strategy,
        label: LABELS[strategy],
        cagr: Math.round((Math.pow(g, 1 / years) - 1) * 10000) / 100,
        ann_vol: Math.round(annVol * 10000) / 100,
        sharpe: annVol > 0 ? Math.round((annRet / annVol) * 100) / 100 : 0,
        max_dd: Math.round(maxDd * 10000) / 100,
        total_return: Math.round((g - 1) * 10000) / 100,
      });
    }

    await withRetry("backtest_curves clear", () => sb.from("backtest_curves").delete().neq("strategy", "__none__"));
    for (let i = 0; i < curves.length; i += 1000) {
      const part = curves.slice(i, i + 1000);
      await withRetry("backtest_curves insert", () => sb.from("backtest_curves").insert(part));
    }
    await withRetry("backtest_stats upsert", () => sb.from("backtest_stats").upsert(stats, { onConflict: "strategy" }));

    const first = monthly.baseline[0].month, last = monthly.baseline[monthly.baseline.length - 1].month;
    const note = `months=${monthly.baseline.length} (${first}..${last}) regime_cash_months=${cashMonths} ` +
      stats.map((s) => `${s.strategy}:${s.cagr}%/${s.max_dd}%`).join(" ") + ` ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    await logRun("compute-backtest", true, note);
    return json({ ok: true, note, stats });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logRun("compute-backtest", false, message);
    return json({ ok: false, error: message }, 500);
  }
});
