// fetch-intraday
//
// Intraday bars for the Chart & Search tab: 1m to 1h OHLCV with pre- and
// post-market, from Yahoo Finance's chart endpoint, using the same interval
// windows the Yahoo chart uses (1-2m: up to 5 days, 5-30m: up to a month,
// 1h: up to a year).
//
// Every answer is cached in intraday_cache, 30 seconds while the market is
// open or in extended hours and 10 minutes otherwise, so any number of open
// tabs on the same symbol and interval cost one Yahoo request. The live
// quote stream (live_quotes over Realtime) keeps the newest bar moving in
// between.
//
// GET ?symbol=NVDA&interval=5m[&range=5d] ->
//   { symbol, interval, range, gmtoffset, prevClose, regular, t, o, h, l, c, v, cached, fetchedAt }
// Called by the app's /api/intraday route. Reads public market data only.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, json, marketClock } from "../_shared/common.ts";
import { intradayBars, INTRADAY, YahooRateLimited } from "../_shared/yahoo_live.ts";

const SYM_RE = /^[A-Z^][A-Z0-9.\-^=]{0,11}$/;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const symbol = String(url.searchParams.get("symbol") ?? "")
    .trim()
    .toUpperCase();
  const interval = String(url.searchParams.get("interval") ?? "5m");
  if (!SYM_RE.test(symbol)) return json({ error: "Enter a valid ticker symbol." }, 400);
  const spec = INTRADAY[interval];
  if (!spec) return json({ error: `Unsupported interval ${interval}. Use one of ${Object.keys(INTRADAY).join(", ")}.` }, 400);
  const reqRange = String(url.searchParams.get("range") ?? spec.def);
  const range = spec.ranges.includes(reqRange) ? reqRange : spec.def;

  const clock = marketClock();
  const live = !clock.weekend && clock.minutes >= 240 && clock.minutes < 1205; // 04:00-20:05 ET
  const ttlMs = live ? 30_000 : 600_000;

  const { data: hit } = await sb
    .from("intraday_cache")
    .select("payload,fetched_at")
    .eq("symbol", symbol)
    .eq("interval", interval)
    .eq("range", range)
    .maybeSingle();
  const cached = hit as { payload: Record<string, unknown>; fetched_at: string } | null;
  if (cached && Date.now() - Date.parse(cached.fetched_at) < ttlMs) {
    return json({ ...cached.payload, cached: true, fetchedAt: cached.fetched_at });
  }

  try {
    const bars = await intradayBars(symbol, interval, range);
    if (bars.t.length < 2) return json({ error: `No intraday bars for ${symbol} at ${interval}.` }, 404);
    const fetchedAt = new Date().toISOString();
    await sb.from("intraday_cache").upsert({ symbol, interval, range, payload: bars, fetched_at: fetchedAt }, { onConflict: "symbol,interval,range" });
    return json({ ...bars, cached: false, fetchedAt });
  } catch (e) {
    // serve the stale copy rather than nothing
    if (cached) return json({ ...cached.payload, cached: true, stale: true, fetchedAt: cached.fetched_at });
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: e instanceof YahooRateLimited ? "Yahoo is rate-limiting right now; try again in a minute." : msg }, e instanceof YahooRateLimited ? 429 : 502);
  }
});
