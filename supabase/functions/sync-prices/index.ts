// sync-prices
//
// Real daily OHLCV for the whole library, from Yahoo Finance's public chart
// API, with Nasdaq's historical-quotes API as the fallback (see
// _shared/prices.ts). Writes raw_prices (split-adjusted OHLCV plus the
// dividend-adjusted close) and refreshes symbol_stats / symbol_meta
// bookkeeping for every symbol it touches.
//
// History depth: the regime inputs and sector ETFs keep everything since
// 2010 (the regime score and the backtest need long history); stocks and
// other ETFs keep ~800 calendar days (two years of charts + the 200-day).
// A new split or dividend triggers a full refetch of that symbol so the
// adjusted history stays consistent.
//
// Body (all optional):
//   group         "queue" (default): stalest active symbols first
//                 "core": market ETFs + everything the UI is showing (intraday)
//   symbols       explicit list (symbols already in symbol_meta)
//   limit         symbols per run (default 60, max 250)
//   staleMinutes  queue only: skip symbols synced more recently (default 360)
//   full          true = refetch the whole history window
//   wait          true = run inline and return the result
//
// Auth: x-refresh-secret. Called by pg_cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry, readBody, runInBackground, pool } from "../_shared/common.ts";
import { pull, writeBars, RateLimited, META_COLS, type Meta } from "../_shared/prices.ts";

async function pickSymbols(body: Record<string, unknown>): Promise<Meta[]> {
  const limit = Math.min(250, Math.max(1, Number(body.limit ?? 60)));
  if (Array.isArray(body.symbols) && body.symbols.length) {
    const syms = (body.symbols as unknown[]).map((s) => String(s).toUpperCase()).slice(0, 250);
    return ((await withRetry("symbol_meta read", () => sb.from("symbol_meta").select(META_COLS).in("symbol", syms))) ?? []) as Meta[];
  }
  if (body.group === "core") {
    const core = ((await withRetry("core_symbols", () => sb.rpc("core_symbols"))) ?? []) as unknown[];
    const syms = core.map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>).core_symbols ?? ""))).filter(Boolean);
    return ((await withRetry("symbol_meta read", () => sb.from("symbol_meta").select(META_COLS).in("symbol", syms))) ?? []) as Meta[];
  }
  const stale = new Date(Date.now() - Number(body.staleMinutes ?? 360) * 60000).toISOString();
  return ((await withRetry("symbol_meta queue", () =>
    sb
      .from("symbol_meta")
      .select(META_COLS)
      .eq("active", true)
      .or(`prices_synced_at.is.null,prices_synced_at.lt.${stale}`)
      .order("prices_synced_at", { ascending: true, nullsFirst: true })
      .order("symbol")
      .limit(limit)
  )) ?? []) as Meta[];
}

async function run(body: Record<string, unknown>) {
  const t0 = Date.now();
  const runStart = new Date().toISOString();
  const group = Array.isArray(body.symbols) && body.symbols.length ? "symbols" : body.group === "core" ? "core" : "queue";
  const metas = await pickSymbols(body);
  if (!metas.length) {
    const note = `group=${group} nothing to sync`;
    if (group !== "queue") await logRun("sync-prices", true, note);
    return { ok: true, note };
  }

  const marks: Record<string, unknown>[] = [];
  const touched: string[] = [];
  const errors: string[] = [];
  let rows = 0, fulls = 0, fallback = 0, rateLimited = false;

  await pool(metas, 6, async (m) => {
    if (rateLimited || Date.now() - t0 > 110000) return; // leave the rest for the next run
    try {
      const got = await pull(m, Boolean(body.full));
      rows += await writeBars(m.symbol, got, runStart);
      if (got.full) fulls++;
      if (got.source !== "yahoo") fallback++;
      touched.push(m.symbol);
      marks.push({ symbol: m.symbol, ok: true, source: got.source, last_event_ts: got.maxEventTs || null });
    } catch (e) {
      if (e instanceof RateLimited) {
        rateLimited = true;
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${m.symbol}: ${msg}`);
      marks.push({ symbol: m.symbol, ok: false, error: msg });
    }
  });

  if (marks.length) await withRetry("mark_price_sync", () => sb.rpc("mark_price_sync", { p_rows: marks }));
  let stats = 0;
  if (touched.length) {
    stats = ((await withRetry("after_price_sync", () => sb.rpc("after_price_sync", { p_symbols: touched }))) as number | null) ?? 0;
  }

  const note =
    `group=${group} synced=${touched.length}/${metas.length} rows=${rows} full=${fulls}` +
    (fallback ? ` nasdaq_fallback=${fallback}` : "") +
    (rateLimited ? " rate_limited=yes" : "") +
    ` stats=${stats} ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    (errors.length ? ` errors=${errors.length} [${errors.slice(0, 6).join("; ")}]` : "");
  const ok = touched.length > 0 || errors.length === 0;
  await logRun("sync-prices", ok, note);
  return { ok, synced: touched.length, attempted: metas.length, rows, full: fulls, errors, note };
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  return runInBackground(async () => {
    try {
      return await run(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logRun("sync-prices", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
