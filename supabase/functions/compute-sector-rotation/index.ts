// compute-sector-rotation
//
// Deno/TypeScript port of sector_rotation.py's compute_momentum_scores: for
// each of the 11 SPDR sector ETFs, a risk-adjusted blend of 3/6/12-month
// momentum (weights 0.2/0.3/0.5), divided by trailing annualized volatility.
// Reads from raw_prices (populated by ingest-prices), writes sector_rankings
// + refresh_log.
//
// Auth: custom shared-secret header (x-refresh-secret) -- write endpoint,
// called by the scheduled refresh job, not a browser.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REFRESH_SECRET = "Jl1kt0BO-VQC4xywXdrHuAV9pxgRiTxBjbZDMpDvZXI";

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

function stddev(x: number[]): number {
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  const variance = x.reduce((a, b) => a + (b - mean) * (b - mean), 0) / x.length;
  return Math.sqrt(variance);
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-refresh-secret") !== REFRESH_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  try {
    const tickers = Object.keys(SECTORS);
    // Fetched per-symbol (rather than one .in() query) so that PostgREST's
    // default max-rows page size (commonly 1000) can never silently truncate
    // the combined result once symbols * history-length exceeds it.
    const bySymbol = new Map<string, { date: string; close: number }[]>();
    for (const t of tickers) bySymbol.set(t, []);
    for (const t of tickers) {
      const rows = await withRetry(`raw_prices read failed for ${t}`, () =>
        supabase
          .from("raw_prices")
          .select("date,close")
          .eq("symbol", t)
          .order("date", { ascending: true })
          .range(0, 9999)
      );
      if (!rows || rows.length === 0) throw new Error(`no raw_prices data found for ${t}`);
      const arr = bySymbol.get(t)!;
      for (const r of rows as { date: string; close: number }[]) {
        arr.push({ date: r.date, close: Number(r.close) });
      }
    }

    type Row = {
      ticker: string;
      name: string;
      score: number;
      r3: number;
      r6: number;
      r12: number;
      as_of: string;
    };
    const computed: Row[] = [];
    const skipped: string[] = [];
    let latestAsOf = "";

    for (const t of tickers) {
      const series = bySymbol.get(t)!;
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
      const window = series.slice(n - 127); // 127 closes -> 126 returns
      const dailyReturns: number[] = [];
      for (let i = 1; i < window.length; i++) {
        dailyReturns.push(window[i].close / window[i - 1].close - 1.0);
      }
      const vol = stddev(dailyReturns) * Math.sqrt(252);
      if (vol === 0 || !Number.isFinite(vol)) {
        skipped.push(`${t} (zero/invalid volatility)`);
        continue;
      }

      const score = blended / vol;
      const asOf = series[n - 1].date;
      if (asOf > latestAsOf) latestAsOf = asOf;

      computed.push({
        ticker: t,
        name: SECTORS[t],
        score: Math.round(score * 10000) / 10000,
        // stored as percent (12.9 = +12.9%), matching scripts/refresh.py and the UI
        r3: Math.round(r3 * 10000) / 100,
        r6: Math.round(r6 * 10000) / 100,
        r12: Math.round(r12 * 10000) / 100,
        as_of: asOf,
      });
    }

    if (computed.length === 0) {
      throw new Error(`no sectors had enough history to rank; skipped: ${skipped.join("; ")}`);
    }

    computed.sort((a, b) => b.score - a.score);
    const ranked = computed.map((r, i) => ({ ...r, rank: i + 1, as_of: latestAsOf }));

    await withRetry("sector_rankings upsert failed", () =>
      supabase.from("sector_rankings").upsert(
        ranked.map((r) => ({
          ticker: r.ticker,
          rank: r.rank,
          name: r.name,
          score: r.score,
          r3: r.r3,
          r6: r.r6,
          r12: r.r12,
          as_of: r.as_of,
        })),
        { onConflict: "ticker" },
      )
    );

    await withRetry("refresh_log insert failed", () =>
      supabase.from("refresh_log").insert({
        source: "compute-sector-rotation",
        ok: true,
        note: `as_of=${latestAsOf} ranked=${ranked.length}${skipped.length ? ` skipped=[${skipped.join("; ")}]` : ""}`,
      })
    ).catch(() => {}); // logging must never fail the run

    return new Response(
      JSON.stringify({ ok: true, as_of: latestAsOf, ranked, skipped }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await withRetry("refresh_log insert failed", () =>
      supabase.from("refresh_log").insert({ source: "compute-sector-rotation", ok: false, note: message })
    ).catch(() => {});
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 500 });
  }
});
