// sync-quotes
//
// Live quotes for everything on screen, every ~30 seconds from 04:00 to
// 20:00 New York time (pg_cron job quotes-live) and every 30 minutes
// otherwise (quotes-offhours).
//
// Which symbols: quote_symbols() -- the core set the app always shows (market
// and sector ETFs, plays, setups, smart money plays) plus any symbol an open
// tab registered through watch_symbols() in the last three minutes. That is
// the same idea as Yahoo's streamer, which only subscribes the symbols that
// are visible on the page.
//
// Source: Yahoo's batch spark endpoint, 20 symbols per request (the chart
// endpoint for the few spark doesn't answer). Only rows whose price, extended
// price or session state changed are written, so Supabase Realtime pushes
// real changes and nothing else.
//
// Logging: refresh_log gets every failed run but only one successful run in
// ten minutes, so the 30-second cadence doesn't flood the pipeline view.
//
// Body (all optional): symbols (explicit list), wait (run inline), log (force a log row).
// Auth: x-refresh-secret. Called by pg_cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry, readBody, runInBackground, pool } from "../_shared/common.ts";
import { sparkQuotes, chartQuote, YahooRateLimited, type LiveQuote } from "../_shared/yahoo_live.ts";

interface Prev {
  symbol: string;
  price: number | string | null;
  ext_price: number | string | null;
  market_state: string | null;
  day_high: number | string | null;
  day_low: number | string | null;
}

const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
const changed = (q: LiveQuote, p: Prev | undefined) =>
  !p ||
  num(p.price) !== q.price ||
  num(p.ext_price) !== q.ext_price ||
  p.market_state !== q.market_state ||
  num(p.day_high) !== q.day_high ||
  num(p.day_low) !== q.day_low;

async function run(body: Record<string, unknown>) {
  const t0 = Date.now();
  let symbols: string[];
  if (Array.isArray(body.symbols) && body.symbols.length) {
    symbols = (body.symbols as unknown[]).map((s) => String(s).toUpperCase()).slice(0, 300);
  } else {
    const rows = ((await withRetry("quote_symbols", () => sb.rpc("quote_symbols"))) ?? []) as unknown[];
    symbols = rows.map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>).quote_symbols ?? ""))).filter(Boolean);
  }
  if (!symbols.length) return { ok: true, note: "no symbols" };

  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += 20) batches.push(symbols.slice(i, i + 20));

  const quotes: LiveQuote[] = [];
  const missing: string[] = [];
  const errors: string[] = [];
  let rateLimited = false;
  await pool(batches, 3, async (b) => {
    if (rateLimited) return;
    try {
      const r = await sparkQuotes(b);
      quotes.push(...r.quotes);
      missing.push(...r.missing);
      if (r.error) errors.push(r.error);
    } catch (e) {
      if (e instanceof YahooRateLimited) rateLimited = true;
      else errors.push(e instanceof Error ? e.message : String(e));
    }
  });
  // a handful of individual retries for what spark skipped
  if (!rateLimited && missing.length) {
    await pool(missing.slice(0, 12), 4, async (s) => {
      try {
        const q = await chartQuote(s);
        if (q) quotes.push(q);
      } catch (e) {
        if (e instanceof YahooRateLimited) rateLimited = true;
      }
    });
  }

  let written = 0;
  if (quotes.length) {
    const prev = ((await withRetry("live_quotes read", () =>
      sb.from("live_quotes").select("symbol,price,ext_price,market_state,day_high,day_low").in("symbol", quotes.map((q) => q.symbol))
    )) ?? []) as Prev[];
    const by = new Map(prev.map((p) => [p.symbol, p]));
    const now = new Date().toISOString();
    const rows = quotes.filter((q) => changed(q, by.get(q.symbol))).map((q) => ({ ...q, source: "yahoo", updated_at: now }));
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500);
      await withRetry("live_quotes upsert", () => sb.from("live_quotes").upsert(part, { onConflict: "symbol" }));
      written += part.length;
    }
  }

  const got = new Set(quotes.map((q) => q.symbol));
  const unanswered = symbols.filter((s) => !got.has(s));
  const ok = quotes.length > 0 && !rateLimited;
  const note =
    `symbols=${symbols.length} quoted=${quotes.length} changed=${written}` +
    (unanswered.length ? ` unanswered=${unanswered.length} [${unanswered.slice(0, 8).join(",")}]` : "") +
    (rateLimited ? " rate_limited=yes" : "") +
    (errors.length ? ` errors=${errors.length} [${errors.slice(0, 3).join("; ")}]` : "") +
    ` ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const d = new Date();
  const heartbeat = d.getUTCMinutes() % 10 === 0 && d.getUTCSeconds() < 30;
  if (!ok || heartbeat || body.log) await logRun("sync-quotes", ok, note);
  return { ok, quoted: quotes.length, changed: written, note };
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  return runInBackground(async () => {
    try {
      return await run(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logRun("sync-quotes", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
