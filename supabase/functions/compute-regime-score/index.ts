// compute-regime-score
//
// Deno/TypeScript port of regime_score.py: composite market-regime z-score for
// SPY/QQQ/IWM, built from five rolling-252-day-normalized signal families
// (trend, breadth, volatility, credit, rate curve). Reads from raw_prices
// (populated by ingest-prices), writes regime_snapshot + regime_history +
// refresh_log.
//
// Auth: custom shared-secret header (x-refresh-secret) -- this endpoint writes
// data and is meant to be called by the scheduled refresh job, not a browser.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REFRESH_SECRET = "Jl1kt0BO-VQC4xywXdrHuAV9pxgRiTxBjbZDMpDvZXI";
const ROLL = 252;
const WEIGHTS = { trend: 0.25, breadth: 0.25, vol: 0.20, credit: 0.20, curve: 0.10 };
const INDICES = ["SPY", "QQQ", "IWM"] as const;
const PROXIES = ["RSP", "VIXY", "HYG", "IEF", "SHY"] as const;
const ALL_SYMBOLS = [...INDICES, ...PROXIES];

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---------- transient-failure retry ----------
// The REST gateway occasionally answers a perfectly good request with an
// instant 504 (observed on scheduled runs right at the top of the hour), and
// the identical request succeeds a second later. Retry those with backoff;
// real data errors (bad input, missing history) still fail immediately.
// "JWT issued at future" is a cold-start clock-skew rejection from PostgREST
// that clears within seconds, so it is treated as transient too.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function isTransient(msg: string): boolean {
  return /timeout|gateway|\b50[234]\b|fetch failed|network|connection|ECONNRESET|EPIPE|issued at future|jwt/i.test(msg);
}
async function withRetry<T>(
  label: string,
  fn: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
  attempts = 4,
): Promise<T | null> {
  let lastMsg = "";
  for (let i = 0; i < attempts; i++) {
    let res: { data: T | null; error: { message: string } | null };
    try {
      res = await fn();
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e);
      if (!isTransient(lastMsg)) throw new Error(`${label}: ${lastMsg}`);
      await sleep(800 * (i + 1));
      continue;
    }
    if (!res.error) return res.data;
    lastMsg = res.error.message;
    if (!isTransient(lastMsg)) throw new Error(`${label}: ${lastMsg}`);
    await sleep(800 * (i + 1));
  }
  throw new Error(`${label}: ${lastMsg} (gave up after ${attempts} attempts)`);
}

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
  // population std (ddof=0), matching pandas .rolling(w).std(ddof=0)
  const out: (number | null)[] = new Array(x.length).fill(null);
  for (let i = window - 1; i < x.length; i++) {
    const slice = x.slice(i - window + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / window;
    const variance = slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / window;
    out[i] = Math.sqrt(variance);
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
  const mean = rollingMean(clean.map((v) => (Number.isNaN(v) ? 0 : v)), window);
  const std = rollingStdDdof0(clean.map((v) => (Number.isNaN(v) ? 0 : v)), window);
  const out: (number | null)[] = new Array(x.length).fill(null);
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(clean[i]) || mean[i] === null || std[i] === null) continue;
    // if any of the last `window` raw inputs were null, this point is unreliable;
    // require the full window to be non-null, mirroring pandas NaN propagation
    let windowOk = i >= window - 1;
    if (windowOk) {
      for (let j = i - window + 1; j <= i; j++) {
        if (Number.isNaN(clean[j])) { windowOk = false; break; }
      }
    }
    if (!windowOk) continue;
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

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-refresh-secret") !== REFRESH_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  try {
    // 1) pull aligned closes for the 8 tickers this formula needs.
    // Fetched per-symbol (rather than one .in() query) so that PostgREST's
    // default max-rows page size (commonly 1000) can never silently truncate
    // the combined result once symbols * history-length exceeds it.
    const bySymbol = new Map<string, Map<string, number>>();
    for (const sym of ALL_SYMBOLS) bySymbol.set(sym, new Map());
    for (const sym of ALL_SYMBOLS) {
      const rows = await withRetry(`raw_prices read failed for ${sym}`, () =>
        supabase
          .from("raw_prices")
          .select("date,close")
          .eq("symbol", sym)
          .order("date", { ascending: true })
          .range(0, 9999)
      );
      if (!rows || rows.length === 0) throw new Error(`no raw_prices data found for ${sym}`);
      const m = bySymbol.get(sym)!;
      for (const r of rows as { date: string; close: number }[]) {
        m.set(r.date, Number(r.close));
      }
    }

    // dates where ALL required symbols have a real print
    const dateSets = ALL_SYMBOLS.map((s) => bySymbol.get(s)!);
    const candidateDates = [...dateSets[0].keys()].sort();
    const dates = candidateDates.filter((d) => dateSets.every((m) => m.has(d)));

    if (dates.length < ROLL + 30) {
      throw new Error(
        `not enough aligned history yet (${dates.length} dates, need >= ${ROLL + 30}); ` +
          `seed raw_prices with more history first`,
      );
    }

    const closes: Record<string, number[]> = {};
    for (const sym of ALL_SYMBOLS) closes[sym] = dates.map((d) => bySymbol.get(sym)!.get(d)!);

    // 2) shared, market-wide components
    const breadthRatio = dates.map((_, i) => closes["RSP"][i] / closes["SPY"][i]);
    const zBreadth = rollZ(pctChange(breadthRatio, 20));

    const vixyShort = rollingMean(closes["VIXY"], 10);
    const vixyLong = rollingMean(closes["VIXY"], 60);
    const volSpike: (number | null)[] = dates.map((_, i) =>
      vixyShort[i] !== null && vixyLong[i] !== null && vixyLong[i]! !== 0
        ? vixyShort[i]! / vixyLong[i]! - 1.0
        : null
    );
    const zVolRaw = rollZ(volSpike);
    const zVol = zVolRaw.map((v) => (v === null ? null : -v));

    const creditRatio = dates.map((_, i) => closes["HYG"][i] / closes["IEF"][i]);
    const zCredit = rollZ(pctChange(creditRatio, 20));

    const curveRatio = dates.map((_, i) => closes["IEF"][i] / closes["SHY"][i]);
    const zCurve = rollZ(pctChange(curveRatio, 20));

    // 3) per-index trend + composite
    const results: {
      symbol: string;
      score: number;
      bucket: string;
      z_trend: number | null;
      z_breadth: number | null;
      z_vol: number | null;
      z_credit: number | null;
      z_curve: number | null;
    }[] = [];
    const historyRows: { d: string; spy: number | null; qqq: number | null; iwm: number | null }[] =
      dates.map((d) => ({ d, spy: null, qqq: null, iwm: null }));

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
        if (
          zTrend[i] === null || zBreadth[i] === null || zVol[i] === null ||
          zCredit[i] === null || zCurve[i] === null
        ) return null;
        return (
          WEIGHTS.trend * zTrend[i]! +
          WEIGHTS.breadth * zBreadth[i]! +
          WEIGHTS.vol * zVol[i]! +
          WEIGHTS.credit * zCredit[i]! +
          WEIGHTS.curve * zCurve[i]!
        );
      });
      const composite = rollZ(compositeRaw);

      for (let i = 0; i < dates.length; i++) {
        const key = idx.toLowerCase() as "spy" | "qqq" | "iwm";
        historyRows[i][key] = composite[i];
      }

      const latest = composite[composite.length - 1];
      if (latest === null) throw new Error(`latest composite score for ${idx} is null (insufficient history)`);

      const round4 = (v: number | null) => (v === null ? null : Math.round(v * 10000) / 10000);
      results.push({
        symbol: idx,
        score: Math.round(latest * 10000) / 10000,
        bucket: bucket(latest),
        // the raw component z-scores that feed the composite above, exposed so
        // the UI can show exactly what's being tracked -- not just the blend.
        z_trend: round4(zTrend[zTrend.length - 1]),
        z_breadth: round4(zBreadth[zBreadth.length - 1]),
        z_vol: round4(zVol[zVol.length - 1]),
        z_credit: round4(zCredit[zCredit.length - 1]),
        z_curve: round4(zCurve[zCurve.length - 1]),
      });
    }

    const asOf = dates[dates.length - 1];

    // 4) upsert regime_snapshot
    await withRetry("regime_snapshot upsert failed", () =>
      supabase.from("regime_snapshot").upsert(
        results.map((r) => ({
          index_symbol: r.symbol,
          score: r.score,
          bucket: r.bucket,
          as_of: asOf,
          z_trend: r.z_trend,
          z_breadth: r.z_breadth,
          z_vol: r.z_vol,
          z_credit: r.z_credit,
          z_curve: r.z_curve,
        })),
        { onConflict: "index_symbol" },
      )
    );

    // 5) append/update regime_history: only rows with all 3 composites present,
    // and only the last N (avoid rewriting the whole 2000+ row history every run)
    const maxRow = await withRetry("regime_history read failed", () =>
      supabase
        .from("regime_history")
        .select("d")
        .order("d", { ascending: false })
        .limit(1)
        .maybeSingle()
    );
    const lastStored = (maxRow as { d?: string } | null)?.d;

    const validHistory = historyRows.filter(
      (r) => r.spy !== null && r.qqq !== null && r.iwm !== null,
    );
    const newHistory = lastStored
      ? validHistory.filter((r) => r.d > lastStored)
      : validHistory.slice(-30); // first run: seed the last 30 days only, backfill was done separately

    if (newHistory.length > 0) {
      await withRetry("regime_history upsert failed", () =>
        supabase.from("regime_history").upsert(
          newHistory.map((r) => ({
            d: r.d,
            spy: Math.round(r.spy! * 10000) / 10000,
            qqq: Math.round(r.qqq! * 10000) / 10000,
            iwm: Math.round(r.iwm! * 10000) / 10000,
          })),
          { onConflict: "d" },
        )
      );
    }

    await withRetry("refresh_log insert failed", () =>
      supabase.from("refresh_log").insert({
        source: "compute-regime-score",
        ok: true,
        note: `as_of=${asOf} snapshot=${results.length} history_rows=${newHistory.length}`,
      })
    ).catch(() => {}); // logging must never fail the run

    return new Response(
      JSON.stringify({ ok: true, as_of: asOf, snapshot: results, history_rows_written: newHistory.length }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await withRetry("refresh_log insert failed", () =>
      supabase.from("refresh_log").insert({ source: "compute-regime-score", ok: false, note: message })
    ).catch(() => {});
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 500 });
  }
});
