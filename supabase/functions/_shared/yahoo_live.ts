// Live quotes, intraday bars and news from Yahoo Finance's public endpoints
// (the ones that need no cookie or crumb):
//
//   /v7/finance/spark   batch of <= 20 symbols: regular-session quote fields
//                       in `meta` plus the day's close series (pre/post incl.)
//   /v8/finance/chart   one symbol's OHLCV at 1m..1h with pre/post-market
//   /v1/finance/search  a symbol's recent stories (uuid, publisher, time,
//                       related tickers, thumbnail)
//
// query1 is tried first and query2 on 429/5xx, the same pairing the Yahoo
// web app uses. Nothing here retries in a loop: a rate-limited run gives up
// and the next scheduled run picks the work up.
import { httpGet, sleep, yahooSymbol } from "./common.ts";

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

export class YahooRateLimited extends Error {}

async function getJson(path: string, timeoutMs = 15000): Promise<{ status: number; json: unknown }> {
  let last = { status: -1, text: "" };
  for (let i = 0; i < HOSTS.length; i++) {
    const r = await httpGet(`${HOSTS[i]}${path}`, { headers: { Accept: "application/json" }, timeoutMs });
    last = r;
    if (r.status === 200) {
      try {
        return { status: 200, json: JSON.parse(r.text) };
      } catch {
        return { status: 502, json: null };
      }
    }
    if (!(r.status === 429 || r.status >= 500 || r.status === -1)) break;
    if (i === 0) await sleep(600);
  }
  if (last.status === 429) throw new YahooRateLimited("yahoo 429");
  let json: unknown = null;
  try {
    json = JSON.parse(last.text);
  } catch {
    /* not JSON */
  }
  return { status: last.status, json };
}

const fin = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : Number(x);
  return x !== null && x !== undefined && Number.isFinite(n) ? n : null;
};
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Library form of a Yahoo ticker: share classes use "." (BRK-B -> BRK.B). */
export function librarySymbol(y: string): string {
  return /^[A-Z]{1,5}-[A-Z]$/.test(y) ? y.replace("-", ".") : y;
}

// ---------------------------------------------------------------- quotes
export interface LiveQuote {
  symbol: string;
  name: string | null;
  price: number;
  prev_close: number | null;
  change: number | null;
  change_pct: number | null;
  day_high: number | null;
  day_low: number | null;
  volume: number | null;
  market_state: "PRE" | "REGULAR" | "POST" | "CLOSED";
  ext_price: number | null;
  ext_change: number | null;
  ext_change_pct: number | null;
  ext_time: string | null;
  quote_time: string | null;
}

interface Period {
  start: number;
  end: number;
}

// deno-lint-ignore no-explicit-any
function toQuote(symbol: string, res: any, nowSec = Math.floor(Date.now() / 1000)): LiveQuote | null {
  const m = res?.meta;
  const price = fin(m?.regularMarketPrice);
  if (!m || price === null || price <= 0) return null;

  const pctMeta = fin(m.regularMarketChangePercent);
  const prevMeta = fin(m.previousClose) ?? fin(m.chartPreviousClose);
  let change: number | null = null;
  let pct: number | null = null;
  if (pctMeta !== null) {
    pct = pctMeta;
    change = price - price / (1 + pctMeta / 100);
  } else if (prevMeta) {
    change = price - prevMeta;
    pct = (price / prevMeta - 1) * 100;
  }
  const prev = change !== null ? price - change : prevMeta;

  const ctp = m.currentTradingPeriod ?? {};
  const pre: Period | null = ctp.pre ? { start: ctp.pre.start, end: ctp.pre.end } : null;
  const reg: Period | null = ctp.regular ? { start: ctp.regular.start, end: ctp.regular.end } : null;
  const post: Period | null = ctp.post ? { start: ctp.post.start, end: ctp.post.end } : null;
  const inP = (p: Period | null) => !!p && nowSec >= p.start && nowSec < p.end;
  const state: LiveQuote["market_state"] = inP(reg) ? "REGULAR" : inP(pre) ? "PRE" : inP(post) ? "POST" : "CLOSED";

  // latest pre/post print: the last close in the series outside the regular session
  const ts: number[] = res.timestamp ?? [];
  const closes: (number | null)[] = res.indicators?.quote?.[0]?.close ?? [];
  let extPrice: number | null = null;
  let extTime: number | null = null;
  if (reg && state !== "REGULAR") {
    for (let i = ts.length - 1; i >= 0; i--) {
      const c = fin(closes[i]);
      if (c === null) continue;
      if (ts[i] >= reg.end || ts[i] < reg.start) {
        extPrice = c;
        extTime = ts[i];
      }
      break;
    }
  }
  const extChange = extPrice !== null ? extPrice - price : null;

  const qt = fin(m.regularMarketTime);
  return {
    symbol,
    name: (m.shortName as string) || (m.longName as string) || null,
    price: r4(price),
    prev_close: prev !== null ? r4(prev) : null,
    change: change !== null ? r4(change) : null,
    change_pct: pct !== null ? Math.round(pct * 1000) / 1000 : null,
    day_high: fin(m.regularMarketDayHigh),
    day_low: fin(m.regularMarketDayLow),
    volume: fin(m.regularMarketVolume) !== null ? Math.round(fin(m.regularMarketVolume)!) : null,
    market_state: state,
    ext_price: extPrice !== null ? r4(extPrice) : null,
    ext_change: extChange !== null ? r4(extChange) : null,
    ext_change_pct: extPrice !== null ? Math.round((extPrice / price - 1) * 100000) / 1000 : null,
    ext_time: extTime !== null ? new Date(extTime * 1000).toISOString() : null,
    quote_time: qt !== null ? new Date(qt * 1000).toISOString() : null,
  };
}

/**
 * Quotes for up to 20 library symbols in one spark request. Symbols Yahoo
 * doesn't answer for are listed in `missing`.
 */
export async function sparkQuotes(symbols: string[]): Promise<{ quotes: LiveQuote[]; missing: string[]; error?: string }> {
  const back = new Map(symbols.map((s) => [yahooSymbol(s), s]));
  const ys = Array.from(back.keys()).slice(0, 20);
  const path = `/v7/finance/spark?symbols=${encodeURIComponent(ys.join(","))}&range=1d&interval=5m&includePrePost=true`;
  const { status, json } = await getJson(path);
  if (status !== 200) {
    // deno-lint-ignore no-explicit-any
    const desc = (json as any)?.spark?.error?.description;
    return { quotes: [], missing: symbols, error: `spark HTTP ${status}${desc ? `: ${desc}` : ""}` };
  }
  // deno-lint-ignore no-explicit-any
  const results: any[] = (json as any)?.spark?.result ?? [];
  const quotes: LiveQuote[] = [];
  const got = new Set<string>();
  for (const r of results) {
    const lib = back.get(String(r?.symbol ?? "")) ?? librarySymbol(String(r?.symbol ?? ""));
    const q = toQuote(lib, r?.response?.[0]);
    if (q) {
      quotes.push(q);
      got.add(lib);
    }
  }
  return { quotes, missing: symbols.filter((s) => !got.has(s)) };
}

/** One symbol's quote through the chart endpoint (fallback for spark misses). */
export async function chartQuote(symbol: string): Promise<LiveQuote | null> {
  const path = `/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?range=1d&interval=5m&includePrePost=true`;
  const { status, json } = await getJson(path);
  if (status !== 200) return null;
  // deno-lint-ignore no-explicit-any
  return toQuote(symbol, (json as any)?.chart?.result?.[0]);
}

// ---------------------------------------------------------------- intraday bars
export const INTRADAY: Record<string, { ranges: string[]; def: string }> = {
  // Yahoo's own windows: <= 7 days of 1m, <= 60 days below 1h, ~2 years of 1h
  "1m": { ranges: ["1d", "5d"], def: "1d" },
  "2m": { ranges: ["1d", "5d"], def: "1d" },
  "5m": { ranges: ["1d", "5d", "1mo"], def: "5d" },
  "15m": { ranges: ["1d", "5d", "1mo"], def: "5d" },
  "30m": { ranges: ["5d", "1mo"], def: "1mo" },
  "60m": { ranges: ["5d", "1mo", "3mo", "6mo", "1y"], def: "3mo" },
};

export interface IntradayBars {
  symbol: string;
  interval: string;
  range: string;
  gmtoffset: number; // seconds; add to t for exchange-local display
  prevClose: number | null;
  regular: { start: number; end: number } | null; // today's regular session (unix s)
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

export async function intradayBars(symbol: string, interval: string, range: string): Promise<IntradayBars> {
  const path =
    `/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?range=${range}&interval=${interval}` +
    `&includePrePost=true&events=div%7Csplit`;
  const { status, json } = await getJson(path, 20000);
  // deno-lint-ignore no-explicit-any
  const res = (json as any)?.chart?.result?.[0];
  if (status !== 200 || !res) {
    // deno-lint-ignore no-explicit-any
    throw new Error(`yahoo chart ${status}: ${(json as any)?.chart?.error?.description ?? "no result"}`);
  }
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};
  const out: IntradayBars = {
    symbol,
    interval,
    range,
    gmtoffset: fin(res.meta?.gmtoffset) ?? -14400,
    prevClose: fin(res.meta?.chartPreviousClose) ?? fin(res.meta?.previousClose),
    regular: res.meta?.currentTradingPeriod?.regular
      ? { start: res.meta.currentTradingPeriod.regular.start, end: res.meta.currentTradingPeriod.regular.end }
      : null,
    t: [],
    o: [],
    h: [],
    l: [],
    c: [],
    v: [],
  };
  for (let i = 0; i < ts.length; i++) {
    const c = fin(q.close?.[i]);
    if (c === null) continue;
    const o = fin(q.open?.[i]) ?? c;
    out.t.push(ts[i]);
    out.o.push(r4(o));
    out.h.push(r4(Math.max(fin(q.high?.[i]) ?? c, o, c)));
    out.l.push(r4(Math.min(fin(q.low?.[i]) ?? c, o, c)));
    out.c.push(r4(c));
    out.v.push(Math.round(fin(q.volume?.[i]) ?? 0));
  }
  return out;
}

// ---------------------------------------------------------------- news
export interface NewsRow {
  uuid: string;
  title: string;
  publisher: string | null;
  link: string;
  kind: "STORY" | "VIDEO" | "PRESS";
  published_at: string;
  tickers: string[];
  thumb: string | null;
}

// wire services: Yahoo files their stories under the "Press Releases" tab
const WIRES = /business ?wire|pr ?newswire|globe ?newswire|accesswire|newsfile|cnw|globenewswire|prweb|ein presswire|newsdirect|issuer direct/i;

/** A symbol's latest stories (or the market's, for ^GSPC / ^IXIC / ^DJI). */
export async function symbolNews(symbol: string, count = 20): Promise<NewsRow[]> {
  const path =
    `/v1/finance/search?q=${encodeURIComponent(yahooSymbol(symbol))}` +
    `&quotesCount=0&newsCount=${count}&enableFuzzyQuery=false&listsCount=0&enableNavLinks=false&enableResearchReports=false`;
  const { status, json } = await getJson(path);
  if (status !== 200) throw new Error(`yahoo search HTTP ${status}`);
  // deno-lint-ignore no-explicit-any
  const items: any[] = (json as any)?.news ?? [];
  const out: NewsRow[] = [];
  for (const n of items) {
    const uuid = String(n?.uuid ?? "");
    const title = String(n?.title ?? "").trim();
    const link = String(n?.link ?? "");
    const t = fin(n?.providerPublishTime);
    if (!uuid || !title || !/^https?:\/\//.test(link) || t === null) continue;
    const publisher = n?.publisher ? String(n.publisher) : null;
    const related = (Array.isArray(n?.relatedTickers) ? n.relatedTickers : []).map((x: unknown) => librarySymbol(String(x)));
    const tickers = Array.from(new Set([symbol, ...related])).filter((x) => /^[A-Z^][A-Z0-9.\-=^]{0,14}$/.test(x)).slice(0, 25);
    // deno-lint-ignore no-explicit-any
    const res: any[] = n?.thumbnail?.resolutions ?? [];
    const thumb = (res.find((r) => r?.tag === "140x140") ?? res[res.length - 1])?.url ?? null;
    out.push({
      uuid,
      title: title.slice(0, 400),
      publisher,
      link,
      kind: n?.type === "VIDEO" ? "VIDEO" : publisher && WIRES.test(publisher) ? "PRESS" : "STORY",
      published_at: new Date(t * 1000).toISOString(),
      tickers,
      thumb: typeof thumb === "string" ? thumb : null,
    });
  }
  return out;
}
