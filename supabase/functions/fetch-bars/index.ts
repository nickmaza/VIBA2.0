// fetch-bars
//
// Daily bars for the Chart & Search tab, always served from Supabase
// (raw_prices). A symbol whose bars are stale -- older than 15 minutes while
// the market is open, 12 hours otherwise -- is refreshed from Yahoo Finance
// first (Nasdaq fallback), so any chart shows the live session. Symbols
// outside the library are added once as kind 'adhoc' and kept in raw_prices.
//
// GET ?symbol=NVDA or POST { symbol } ->
//   { symbol, name, bars: { t, o, h, l, c, v }, source: "supabase", asOf, refreshed }
//
// Called by the app's /api/bars route. It only reads and stores public market
// data for real tickers; new symbols are capped per hour.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, json, readBody, marketClock } from "../_shared/common.ts";
import { pull, writeBars, META_COLS, type Meta } from "../_shared/prices.ts";

const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const LOOKBACK_DAYS = 760;
const NEW_SYMBOLS_PER_HOUR = 200;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const body = req.method === "POST" ? await readBody(req) : {};
  const symbol = String(body.symbol ?? url.searchParams.get("symbol") ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");
  if (!SYM_RE.test(symbol)) return json({ error: "Enter a valid ticker symbol." }, 400);

  const { data: metaRow } = await sb.from("symbol_meta").select(`${META_COLS},name,prices_synced_at`).eq("symbol", symbol).maybeSingle();
  let meta = metaRow as (Meta & { name: string | null; prices_synced_at: string | null }) | null;

  const clock = marketClock();
  const maxAgeMs = clock.open ? 15 * 60e3 : 12 * 3600e3;
  const syncedAt = meta?.prices_synced_at ? Date.parse(meta.prices_synced_at) : 0;
  const stale = !meta || (meta.bar_count ?? 0) < 60 || Date.now() - syncedAt > maxAgeMs;

  let refreshed = false;
  let fetchError: string | null = null;
  if (stale) {
    if (!meta) {
      const hourAgo = new Date(Date.now() - 3600e3).toISOString();
      const { count } = await sb.from("symbol_meta").select("symbol", { count: "exact", head: true }).eq("kind", "adhoc").gte("updated_at", hourAgo);
      if ((count ?? 0) >= NEW_SYMBOLS_PER_HOUR) return json({ error: "Too many new symbols requested this hour; try again later." }, 429);
    }
    const m: Meta = meta ?? { symbol, kind: "adhoc", first_bar: null, last_bar: null, bar_count: 0, last_event_ts: null, price_source: null };
    try {
      const got = await pull(m);
      if (!meta) {
        const { data: dir } = await sb.from("symbol_directory").select("name").eq("symbol", symbol).maybeSingle();
        const name = (dir as { name?: string } | null)?.name ?? got.name ?? symbol;
        const ins = await sb.from("symbol_meta").insert({ symbol, name, kind: "adhoc", active: false, updated_at: new Date().toISOString() });
        if (ins.error && !/duplicate/i.test(ins.error.message)) throw new Error(ins.error.message);
        meta = { ...m, name, prices_synced_at: null };
      }
      await writeBars(symbol, got, new Date().toISOString());
      await sb.rpc("mark_price_sync", { p_rows: [{ symbol, ok: true, source: got.source, last_event_ts: got.maxEventTs || null }] });
      await sb.rpc("after_price_sync", { p_symbols: [symbol] });
      refreshed = true;
    } catch (e) {
      fetchError = e instanceof Error ? e.message : String(e);
      if (meta) await sb.rpc("mark_price_sync", { p_rows: [{ symbol, ok: false, error: fetchError }] });
    }
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400e3).toISOString().slice(0, 10);
  const { data } = await sb.rpc("bars_json_many", { p_symbols: [symbol], p_since: since });
  const b = (data as Record<string, { t: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] }> | null)?.[symbol];
  if (!b || b.t.length < 20) {
    return json(
      { error: `No daily price history found for ${symbol}. Check the ticker, or search by company name.`, detail: fetchError },
      404,
    );
  }
  return json(
    {
      symbol,
      name: meta?.name ?? null,
      bars: { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v },
      source: "supabase",
      asOf: b.t[b.t.length - 1],
      refreshed,
      ...(fetchError ? { refreshError: fetchError } : {}),
    },
    200,
  );
});
