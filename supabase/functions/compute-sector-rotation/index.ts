// compute-sector-rotation
//
// For each of the 11 SPDR sector ETFs, a risk-adjusted blend of 3/6/12-month
// momentum (weights 0.2/0.3/0.5), divided by trailing annualized volatility.
// Reads daily closes from raw_prices (sync-prices, Yahoo Finance), writes
// sector_rankings + refresh_log.
//
// Auth: x-refresh-secret -- write endpoint, called by pg_cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry } from "../_shared/common.ts";

const MOM_WEIGHTS = { m3: 0.2, m6: 0.3, m12: 0.5 };
const SECTORS: Record<string, string> = {
  XLE: "Energy",
  XLK: "Technology",
  XLV: "Health Care",
  XLF: "Financials",
  XLB: "Materials",
  XLI: "Industrials",
  XLRE: "Real Estate",
  XLP: "Cons. Staples",
  XLU: "Utilities",
  XLY: "Cons. Discretionary",
  XLC: "Communication Svcs",
};

function stddev(x: number[]): number {
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  return Math.sqrt(x.reduce((a, b) => a + (b - mean) * (b - mean), 0) / x.length);
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);

  try {
    const tickers = Object.keys(SECTORS);
    const since = new Date(Date.now() - 800 * 86400e3).toISOString().slice(0, 10);
    const bars = (await withRetry("bars_json_many", () =>
      sb.rpc("bars_json_many", { p_symbols: tickers, p_since: since })
    )) as Record<string, { t: string[]; c: number[] }> | null;

    const computed: Record<string, unknown>[] = [];
    const skipped: string[] = [];
    let latestAsOf = "";

    for (const t of tickers) {
      const b = bars?.[t];
      const series = b ? b.t.map((d, i) => ({ date: d, close: Number(b.c[i]) })) : [];
      if (series.length < 253) {
        skipped.push(`${t} (only ${series.length} bars, need >= 253)`);
        continue;
      }
      const n = series.length;
      const last = series[n - 1].close;
      const at = (k: number) => series[n - 1 - k].close; // k trading days back
      const r3 = last / at(63) - 1.0;
      const r6 = last / at(126) - 1.0;
      const r12 = last / at(252) - 1.0;
      const blended = MOM_WEIGHTS.m3 * r3 + MOM_WEIGHTS.m6 * r6 + MOM_WEIGHTS.m12 * r12;

      // trailing 126 daily returns -> annualized vol
      const window = series.slice(n - 127);
      const rets: number[] = [];
      for (let i = 1; i < window.length; i++) rets.push(window[i].close / window[i - 1].close - 1.0);
      const vol = stddev(rets) * Math.sqrt(252);
      if (vol === 0 || !Number.isFinite(vol)) {
        skipped.push(`${t} (zero/invalid volatility)`);
        continue;
      }

      const asOf = series[n - 1].date;
      if (asOf > latestAsOf) latestAsOf = asOf;
      computed.push({
        ticker: t,
        name: SECTORS[t],
        score: Math.round((blended / vol) * 10000) / 10000,
        // stored as percent (12.9 = +12.9%)
        r3: Math.round(r3 * 10000) / 100,
        r6: Math.round(r6 * 10000) / 100,
        r12: Math.round(r12 * 10000) / 100,
      });
    }

    if (computed.length === 0) throw new Error(`no sectors had enough history to rank; skipped: ${skipped.join("; ")}`);

    computed.sort((a, b) => (b.score as number) - (a.score as number));
    const ranked = computed.map((r, i) => ({ ...r, rank: i + 1, as_of: latestAsOf }));

    await withRetry("sector_rankings upsert", () => sb.from("sector_rankings").upsert(ranked, { onConflict: "ticker" }));

    await logRun(
      "compute-sector-rotation",
      true,
      `as_of=${latestAsOf} ranked=${ranked.length}${skipped.length ? ` skipped=[${skipped.join("; ")}]` : ""}`,
    );
    return json({ ok: true, as_of: latestAsOf, ranked, skipped });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logRun("compute-sector-rotation", false, message);
    return json({ ok: false, error: message }, 500);
  }
});
