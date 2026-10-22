// sync-news
//
// The news feed: each symbol's latest stories from Yahoo Finance's search
// endpoint, the same stories Yahoo lists under a quote's "Recent News"
// (headline, publisher, publish time, related tickers, thumbnail). Market
// news comes from the index symbols ^GSPC, ^IXIC and ^DJI.
//
// news_queue() picks the stalest symbols among the market feed, the core set
// and whatever an open tab is showing; each run covers up to `limit` of them
// (4 requests at a time). upsert_news() stores new stories and merges the
// related tickers of stories already stored, keyed by Yahoo's story uuid, so
// a story mentioned under five tickers is stored once. Supabase Realtime
// announces each new row to open tabs.
//
// Schedule: every 2 minutes from 04:00 to 20:00 New York time (news-live,
// a symbol is due after 8 minutes), every 15 minutes otherwise.
//
// Body (all optional): limit (default 20, max 60), staleMinutes (default 8),
// symbols (explicit list), wait.
// Auth: x-refresh-secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry, readBody, runInBackground, pool } from "../_shared/common.ts";
import { symbolNews, YahooRateLimited, type NewsRow } from "../_shared/yahoo_live.ts";

async function run(body: Record<string, unknown>) {
  const t0 = Date.now();
  let symbols: string[];
  if (Array.isArray(body.symbols) && body.symbols.length) {
    symbols = (body.symbols as unknown[]).map((s) => String(s).toUpperCase()).slice(0, 60);
  } else {
    const q = ((await withRetry("news_queue", () =>
      sb.rpc("news_queue", { p_limit: Number(body.limit ?? 20), p_stale_minutes: Number(body.staleMinutes ?? 8) })
    )) ?? []) as { symbol: string }[];
    symbols = q.map((r) => r.symbol);
  }
  if (!symbols.length) return { ok: true, note: "nothing due" };

  const rows: NewsRow[] = [];
  const marks: { symbol: string; synced_at: string; stories: number | null; error: string | null }[] = [];
  const errors: string[] = [];
  let rateLimited = false;
  await pool(symbols, 4, async (s) => {
    if (rateLimited || Date.now() - t0 > 50000) return;
    try {
      const got = await symbolNews(s, 20);
      rows.push(...got);
      marks.push({ symbol: s, synced_at: new Date().toISOString(), stories: got.length, error: null });
    } catch (e) {
      if (e instanceof YahooRateLimited) {
        rateLimited = true;
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${s}: ${msg}`);
      marks.push({ symbol: s, synced_at: new Date().toISOString(), stories: null, error: msg.slice(0, 300) });
    }
  });

  let fresh = 0;
  if (rows.length) {
    fresh = ((await withRetry("upsert_news", () => sb.rpc("upsert_news", { p_rows: rows }))) as number | null) ?? 0;
  }
  if (marks.length) await withRetry("news_sync upsert", () => sb.from("news_sync").upsert(marks, { onConflict: "symbol" }));

  const ok = marks.some((m) => m.error === null) && !rateLimited;
  const note =
    `symbols=${marks.length}/${symbols.length} stories=${rows.length} new=${fresh}` +
    (rateLimited ? " rate_limited=yes" : "") +
    (errors.length ? ` errors=${errors.length} [${errors.slice(0, 4).join("; ")}]` : "") +
    ` ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  // log runs that found something or failed; quiet no-op runs stay out of the pipeline view
  if (fresh > 0 || !ok || body.log) await logRun("sync-news", ok, note);
  return { ok, symbols: marks.length, stories: rows.length, new: fresh, note };
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  return runInBackground(async () => {
    try {
      return await run(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logRun("sync-news", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
