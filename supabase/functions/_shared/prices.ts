// Daily OHLCV from Yahoo Finance's public chart API, with Nasdaq's
// historical-quotes API as the fallback, plus the write path into raw_prices.
// Shared by sync-prices (scheduled, whole library) and fetch-bars (on demand).
import { sb, httpGet, withRetry, sleep, yahooSymbol } from "./common.ts";

export const LONG_KINDS = new Set(["index", "input", "sector_etf"]);
const LONG_START = Date.UTC(2010, 0, 1) / 1000;
const STOCK_DAYS = 800;
const INCREMENTAL_OVERLAP_DAYS = 12;
const NASDAQ_HEADERS = {
  Accept: "application/json, text/plain, */*",
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
};

export interface Meta {
  symbol: string;
  kind: string;
  first_bar: string | null;
  last_bar: string | null;
  bar_count: number | null;
  last_event_ts: number | null;
  price_source: string | null;
}
export const META_COLS = "symbol,kind,first_bar,last_bar,bar_count,last_event_ts,price_source";

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adj: number | null;
  volume: number | null;
}

export interface Pulled {
  bars: Bar[];
  maxEventTs: number;
  source: "yahoo" | "nasdaq";
  name: string | null;
  full: boolean;
}

const fin = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
};
// Yahoo serves float32-ish values (771.3499755859375); store clean 4-dp prices
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

function clean(bars: Bar[]): Bar[] {
  const byDate = new Map<string, Bar>();
  for (const b of bars) {
    if (!(b.close > 0)) continue;
    const o = b.open > 0 ? b.open : b.close;
    byDate.set(b.date, {
      ...b,
      open: o,
      high: Math.max(b.high > 0 ? b.high : b.close, o, b.close),
      low: Math.min(b.low > 0 ? b.low : b.close, o, b.close),
    });
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export class RateLimited extends Error {}

async function fromYahoo(symbol: string, p1: number, p2: number) {
  const path = `/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit&includePrePost=false`;
  let r = await httpGet(`https://query1.finance.yahoo.com${path}`, { headers: { Accept: "application/json" }, timeoutMs: 20000 });
  if (r.status === 429 || r.status >= 500 || r.status === -1) {
    await sleep(800);
    r = await httpGet(`https://query2.finance.yahoo.com${path}`, { headers: { Accept: "application/json" }, timeoutMs: 20000 });
  }
  if (r.status === 429) throw new RateLimited("yahoo 429");
  if (r.status !== 200) throw new Error(`yahoo HTTP ${r.status}`);
  const j = JSON.parse(r.text);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`yahoo: ${j?.chart?.error?.description ?? "no result"}`);
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] = res.indicators?.adjclose?.[0]?.adjclose ?? [];
  const off = fin(res.meta?.gmtoffset) ?? -14400;
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = fin(q.close?.[i]);
    if (c === null) continue;
    bars.push({
      date: new Date((ts[i] + off) * 1000).toISOString().slice(0, 10),
      open: fin(q.open?.[i]) ?? c,
      high: fin(q.high?.[i]) ?? c,
      low: fin(q.low?.[i]) ?? c,
      close: c,
      adj: fin(adj[i]),
      volume: fin(q.volume?.[i]),
    });
  }
  let maxEventTs = 0;
  for (const e of [...Object.values(res.events?.splits ?? {}), ...Object.values(res.events?.dividends ?? {})] as { date?: number }[]) {
    if (typeof e?.date === "number" && e.date > maxEventTs) maxEventTs = e.date;
  }
  const name = (res.meta?.longName as string) || (res.meta?.shortName as string) || null;
  return { bars: clean(bars), maxEventTs, source: "yahoo" as const, name };
}

function nasdaqDate(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

async function fromNasdaq(symbol: string, fromIso: string, toIso: string) {
  for (const cls of ["stocks", "etf"]) {
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${cls}&fromdate=${fromIso}&limit=9999&todate=${toIso}`;
    const r = await httpGet(url, { headers: NASDAQ_HEADERS, timeoutMs: 20000 });
    if (r.status !== 200) continue;
    let rows: Record<string, string>[] = [];
    try {
      rows = JSON.parse(r.text)?.data?.tradesTable?.rows ?? [];
    } catch {
      rows = [];
    }
    if (!rows.length) continue;
    const num = (s: string) => fin(String(s ?? "").replace(/[$,]/g, ""));
    const bars: Bar[] = [];
    for (const x of rows) {
      const d = nasdaqDate(String(x.date ?? ""));
      const c = num(x.close);
      if (!d || c === null) continue;
      bars.push({ date: d, open: num(x.open) ?? c, high: num(x.high) ?? c, low: num(x.low) ?? c, close: c, adj: null, volume: num(x.volume) });
    }
    if (bars.length) return { bars: clean(bars), maxEventTs: 0, source: "nasdaq" as const, name: null };
  }
  throw new Error("nasdaq: no data");
}

/**
 * Pull the bars a symbol needs: the full history window on first sync (or
 * after a split/dividend we haven't absorbed), otherwise the last few weeks.
 */
export async function pull(m: Meta, forceFull = false): Promise<Pulled> {
  const now = Math.floor(Date.now() / 1000);
  const fullStart = LONG_KINDS.has(m.kind) ? LONG_START : now - STOCK_DAYS * 86400;
  const needFull = forceFull || !m.last_bar || (m.bar_count ?? 0) < 30 || m.price_source !== "yahoo";
  const p1 = needFull ? fullStart : Math.floor(Date.parse(`${m.last_bar}T00:00:00Z`) / 1000) - INCREMENTAL_OVERLAP_DAYS * 86400;
  const p2 = now + 86400;
  try {
    let got = await fromYahoo(m.symbol, p1, p2);
    let full = needFull;
    if (!full && got.maxEventTs > (m.last_event_ts ?? 0)) {
      got = await fromYahoo(m.symbol, fullStart, p2);
      full = true;
    }
    if (!got.bars.length) throw new Error("yahoo: empty history");
    return { ...got, full };
  } catch (e) {
    if (e instanceof RateLimited) throw e;
    const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
    const got = await fromNasdaq(m.symbol, iso(needFull ? fullStart : p1), iso(p2));
    return { ...got, full: needFull };
  }
}

/** Upsert pulled bars; on a full refetch drop whatever the new window didn't return. */
export async function writeBars(symbol: string, got: Pulled, runStart: string): Promise<number> {
  const payload = got.bars.map((b) => ({
    symbol,
    date: b.date,
    open: r4(b.open),
    high: r4(b.high),
    low: r4(b.low),
    close: r4(b.close),
    adj_close: b.adj === null ? null : r4(b.adj),
    volume: b.volume === null ? null : Math.round(b.volume),
    source: got.source,
    updated_at: runStart,
  }));
  for (let i = 0; i < payload.length; i += 1000) {
    const part = payload.slice(i, i + 1000);
    await withRetry(`raw_prices upsert ${symbol}`, () => sb.from("raw_prices").upsert(part, { onConflict: "symbol,date" }));
  }
  if (got.full) {
    await withRetry(`raw_prices prune ${symbol}`, () => sb.from("raw_prices").delete().eq("symbol", symbol).lt("updated_at", runStart));
  }
  return payload.length;
}
