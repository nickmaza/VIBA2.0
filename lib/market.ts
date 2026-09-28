// Daily price history and symbol search, all served by Supabase.
//
//   bars    raw_prices: daily OHLCV from Yahoo Finance (Nasdaq fallback),
//           kept current by the sync-prices edge function on pg_cron. The
//           Chart & Search tab goes through the fetch-bars edge function,
//           which refreshes a stale symbol from the market first and adds a
//           symbol outside the library on its first request.
//   search  search_symbols(): the library plus the full US stock and ETF
//           directory (symbol_directory, from Nasdaq's screener, synced weekly).
import { supabase, edgeFunctionUrl, SUPABASE_ANON_KEY } from "./supabase";
import type { Bars } from "./ta";

export type BarSource = "supabase";

export interface BarsResult {
  symbol: string;
  name: string | null;
  bars: Bars;
  source: BarSource;
  asOf: string; // date of the last bar
  refreshed?: boolean; // fetch-bars pulled fresh bars from the market for this request
}

export interface SymbolHit {
  symbol: string;
  name: string;
  type: string; // "Stock" | "ETF"
  inLibrary: boolean;
}

interface RawBars {
  t: string[];
  o: unknown[];
  h: unknown[];
  l: unknown[];
  c: unknown[];
  v: unknown[];
}

export function cleanSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);
}

const toNum = (x: unknown) => {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
};

function toBars(b: RawBars): Bars {
  return {
    t: b.t.map(String),
    o: b.o.map(toNum),
    h: b.h.map(toNum),
    l: b.l.map(toNum),
    c: b.c.map(toNum),
    v: b.v.map(toNum),
  };
}

/** Daily bars for many symbols in one round trip (the bars_json_many RPC). */
export async function getBarsMany(symbols: string[], lookbackDays = 760): Promise<Map<string, Bars>> {
  const out = new Map<string, Bars>();
  const uniq = Array.from(new Set(symbols.map(cleanSymbol).filter(Boolean)));
  if (!uniq.length) return out;
  const since = new Date(Date.now() - lookbackDays * 864e5).toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc("bars_json_many", { p_symbols: uniq, p_since: since });
  if (error) throw new Error(`bars_json_many: ${error.message}`);
  const j = (data ?? {}) as Record<string, RawBars | undefined>;
  for (const s of uniq) {
    const b = j[s];
    if (b && Array.isArray(b.t) && b.t.length) out.set(s, toBars(b));
  }
  return out;
}

export type FetchBarsResult = { ok: true; result: BarsResult } | { ok: false; status: number; error: string };

/**
 * One symbol's two-year daily history through the fetch-bars edge function.
 * The function serves raw_prices, refreshing the symbol from the market first
 * when its bars are stale (15 minutes in the session, 12 hours otherwise).
 */
export async function fetchBars(symbol: string): Promise<FetchBarsResult> {
  let res: Response;
  try {
    res = await fetch(`${edgeFunctionUrl("fetch-bars")}?symbol=${encodeURIComponent(symbol)}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) {
    return { ok: false, status: 502, error: `Supabase fetch-bars didn't respond: ${e instanceof Error ? e.message : String(e)}` };
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !j.bars) {
    return { ok: false, status: res.ok ? 502 : res.status, error: String(j.error ?? `fetch-bars failed (${res.status})`) };
  }
  return {
    ok: true,
    result: {
      symbol: String(j.symbol ?? symbol),
      name: j.name ? String(j.name) : null,
      bars: toBars(j.bars as RawBars),
      source: "supabase",
      asOf: String(j.asOf ?? ""),
      refreshed: Boolean(j.refreshed),
    },
  };
}

/** Ticker / company-name search across the library and the US listings directory. */
export async function searchSymbols(q: string, limit = 10): Promise<SymbolHit[]> {
  const query = q.trim().slice(0, 60);
  if (!query) return [];
  const { data, error } = await supabase.rpc("search_symbols", { q: query, lim: limit });
  if (error) throw new Error(`search_symbols: ${error.message}`);
  return ((data ?? []) as { symbol: string; name: string; type: string; in_library: boolean }[]).map((r) => ({
    symbol: r.symbol,
    name: r.name,
    type: r.type,
    inLibrary: Boolean(r.in_library),
  }));
}
