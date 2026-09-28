// compute-regime-score
//
// Composite market-regime z-score for SPY/QQQ/IWM, built from five
// rolling-252-day-normalized signal families (trend, breadth, volatility,
// credit, rate curve). Reads daily closes from raw_prices (filled by
// sync-prices from Yahoo Finance, history since 2010), writes regime_snapshot
// + regime_history + refresh_log.
//
// Body (optional): { full: true } rewrites the whole regime_history from the
// price history; otherwise the last 10 sessions are refreshed (today's value
// moves intraday while the session is open).
//
// Auth: x-refresh-secret -- this endpoint writes data and is called by pg_cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry, readBody } from "../_shared/common.ts";

const ROLL = 252;
const WEIGHTS = { trend: 0.25, breadth: 0.25, vol: 0.2, credit: 0.2, curve: 0.1 };
const INDICES = ["SPY", "QQQ", "IWM"] as const;
const PROXIES = ["RSP", "VIXY", "HYG", "IEF", "SHY"] as const;
const ALL_SYMBOLS = [...INDICES, ...PROXIES];

// ---------- pure array math helpers (mirror pandas .rolling()/.pct_change()) ----------
function rollingMean(x: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(x.length).fill(null);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
    if (i >= window) sum -= x[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function rollingStdDdof0(x: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(x.length).fill(null);
  for (let i = window - 1; i < x.length; i++) {
    let mean = 0;
    for (let j = i - window + 1; j <= i; j++) mean += x[j];
    mean /= window;
    let v = 0;
    for (let j = i - window + 1; j <= i; j++) v += (x[j] - mean) * (x[j] - mean);
    out[i] = Math.sqrt(v / window);
  }
  return out;
}

function pctChange(x: number[], periods: number): (number | null)[] {
  const out: (number | null)[] = new Array(x.length).fill(null);
  for (let i = periods; i < x.length; i++) {
    const prev = x[i - periods];
    out[i] = prev === 0 ? null : x[i] / prev - 1.0;
  }
  return out;
}

function rollZ(x: (number | null)[], window: number = ROLL): (number | null)[] {
  const clean = x.map((v) => (v === null || !Number.isFinite(v) ? NaN : v));
  const zeroed = clean.map((v) => (Number.isNaN(v) ? 0 : v));
  const mean = rollingMean(zeroed, window);
  const std = rollingStdDdof0(zeroed, window);
  const out: (number | null)[] = new Array(x.length).fill(null);
  // index of the most recent NaN at or before i, to require a full clean window
  let lastNaN = -1;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(clean[i])) lastNaN = i;
    if (Number.isNaN(clean[i]) || mean[i] === null || std[i] === null) continue;
    if (i < window - 1 || lastNaN > i - window) continue;
    const sd = std[i]!;
    if (sd === 0) continue;
    out[i] = (clean[i] - mean[i]!) / sd;
  }
  return out;
}

function bucket(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return "n/a";
  if (score >= 1.25) return "strong risk-on";
  if (score >= 0.4) return "risk-on";
  if (score > -0.4) return "neutral";
  if (score > -1.25) return "risk-off / caution";
  return "elevated risk / crash-warning";
}

const round4 = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 10000);

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  const full = Boolean(body.full);

  try {
    // 1) aligned closes for the 8 tickers this formula needs (one JSON payload,
    //    so no PostgREST page limit can truncate the history)
    const bars = (await withRetry("bars_json_many", () =>
      sb.rpc("bars_json_many", { p_symbols: ALL_SYMBOLS, p_since: "2009-01-01" })
    )) as Record<string, { t: string[]; c: number[] }> | null;
    const bySymbol = new Map<string, Map<string, number>>();
    for (const sym of ALL_SYMBOLS) {
      const b = bars?.[sym];
      if (!b || !b.t?.length) throw new Error(`no raw_prices data found for ${sym}`);
      bySymbol.set(sym, new Map(b.t.map((d, i) => [d, Number(b.c[i])])));
    }

    const dateSets = ALL_SYMBOLS.map((s) => bySymbol.get(s)!);
    const dates = [...dateSets[0].keys()].sort().filter((d) => dateSets.every((m) => m.has(d)));
    if (dates.length < ROLL * 2 + 230) {
      throw new Error(`not enough aligned history yet (${dates.length} dates); run sync-prices for the regime inputs first`);
    }

    const closes: Record<string, number[]> = {};
    for (const sym of ALL_SYMBOLS) closes[sym] = dates.map((d) => bySymbol.get(sym)!.get(d)!);

    // 2) shared, market-wide components
    const breadthRatio = dates.map((_, i) => closes["RSP"][i] / closes["SPY"][i]);
    const zBreadth = rollZ(pctChange(breadthRatio, 20));

    const vixyShort = rollingMean(closes["VIXY"], 10);
    const vixyLong = rollingMean(closes["VIXY"], 60);
    const volSpike: (number | null)[] = dates.map((_, i) =>
      vixyShort[i] !== null && vixyLong[i] !== null && vixyLong[i]! !== 0 ? vixyShort[i]! / vixyLong[i]! - 1.0 : null
    );
    const zVol = rollZ(volSpike).map((v) => (v === null ? null : -v));

    const creditRatio = dates.map((_, i) => closes["HYG"][i] / closes["IEF"][i]);
    const zCredit = rollZ(pctChange(creditRatio, 20));

    const curveRatio = dates.map((_, i) => closes["IEF"][i] / closes["SHY"][i]);
    const zCurve = rollZ(pctChange(curveRatio, 20));

    // 3) per-index trend + composite
    const results: Record<string, unknown>[] = [];
    const historyRows: { d: string; spy: number | null; qqq: number | null; iwm: number | null }[] = dates.map((d) => ({
      d,
      spy: null,
      qqq: null,
      iwm: null,
    }));

    for (const idx of INDICES) {
      const p = closes[idx];
      const dma50 = rollingMean(p, 50);
      const dma200 = rollingMean(p, 200);
      const trendRaw: (number | null)[] = dates.map((_, i) => {
        if (dma50[i] === null || dma200[i] === null || dma50[i] === 0 || dma200[i] === 0) return null;
        return 0.5 * (p[i] / dma50[i]! - 1.0) + 0.5 * (p[i] / dma200[i]! - 1.0);
      });
      const zTrend = rollZ(trendRaw);

      const compositeRaw: (number | null)[] = dates.map((_, i) => {
        if (zTrend[i] === null || zBreadth[i] === null || zVol[i] === null || zCredit[i] === null || zCurve[i] === null) return null;
        return (
          WEIGHTS.trend * zTrend[i]! +
          WEIGHTS.breadth * zBreadth[i]! +
          WEIGHTS.vol * zVol[i]! +
          WEIGHTS.credit * zCredit[i]! +
          WEIGHTS.curve * zCurve[i]!
        );
      });
      const composite = rollZ(compositeRaw);

      const key = idx.toLowerCase() as "spy" | "qqq" | "iwm";
      for (let i = 0; i < dates.length; i++) historyRows[i][key] = composite[i];

      const latest = composite[composite.length - 1];
      if (latest === null) throw new Error(`latest composite score for ${idx} is null (insufficient history)`);
      results.push({
        index_symbol: idx,
        score: round4(latest),
        bucket: bucket(latest),
        z_trend: round4(zTrend[zTrend.length - 1]),
        z_breadth: round4(zBreadth[zBreadth.length - 1]),
        z_vol: round4(zVol[zVol.length - 1]),
        z_credit: round4(zCredit[zCredit.length - 1]),
        z_curve: round4(zCurve[zCurve.length - 1]),
      });
    }

    const asOf = dates[dates.length - 1];

    // 4) upsert regime_snapshot
    await withRetry("regime_snapshot upsert", () =>
      sb.from("regime_snapshot").upsert(
        results.map((r) => ({ ...r, as_of: asOf, updated_at: new Date().toISOString() })),
        { onConflict: "index_symbol" },
      )
    );

    // 5) regime_history: the whole series on a full rebuild, else the last 10 sessions
    const valid = historyRows
      .filter((r) => r.spy !== null && r.qqq !== null && r.iwm !== null)
      .map((r) => ({ d: r.d, spy: round4(r.spy), qqq: round4(r.qqq), iwm: round4(r.iwm) }));
    const toWrite = full ? valid : valid.slice(-10);
    for (let i = 0; i < toWrite.length; i += 1000) {
      const part = toWrite.slice(i, i + 1000);
      await withRetry("regime_history upsert", () => sb.from("regime_history").upsert(part, { onConflict: "d" }));
    }
    let pruned = 0;
    if (full && valid.length) {
      // rows the price history can't reproduce (e.g. from an older data vendor)
      const { count } = await sb.from("regime_history").delete({ count: "exact" }).lt("d", valid[0].d);
      pruned = count ?? 0;
    }

    await logRun(
      "compute-regime-score",
      true,
      `as_of=${asOf} snapshot=${results.length} history_rows=${toWrite.length}${full ? ` full_rebuild first=${valid[0]?.d} pruned=${pruned}` : ""}`,
    );
    return json({ ok: true, as_of: asOf, snapshot: results, history_rows_written: toWrite.length, first: valid[0]?.d });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logRun("compute-regime-score", false, message);
    return json({ ok: false, error: message }, 500);
  }
});
