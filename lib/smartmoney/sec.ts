// SEC EDGAR: insider buying (Form 4) and hedge-fund positioning (13F-HR).
//
// Both come straight from sec.gov, free and keyless. The SEC asks automated
// clients to identify themselves: set SEC_USER_AGENT to something like
// "VIBA Terminal your-name@your-domain.com" in the environment. Responses are
// cached (Next fetch cache) so the terminal stays well inside the SEC's
// 10-requests-per-second fair-access limit.
import { TRACKED_FUNDS } from "./universe";

const UA = process.env.SEC_USER_AGENT || "VIBA Terminal research dashboard (set SEC_USER_AGENT)";
const DAY = 864e5;

async function sec(url: string, revalidate: number): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json, application/xml, text/xml, */*" },
      next: { revalidate },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/** Run async jobs with a small concurrency cap (SEC fair access). */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

// ---------- small XML helpers (EDGAR XML is flat and predictable) ----------
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>\\s*([\\s\\S]*?)\\s*</(?:\\w+:)?${name}>`));
  return m ? m[1].trim() : null;
}
/** Value inside <name><value>..</value></name> (Form 4 style) or a bare <name>..</name>. */
function val(xml: string, name: string): string | null {
  const inner = tag(xml, name);
  if (inner === null) return null;
  const v = tag(inner, "value");
  return (v ?? inner).replace(/<[^>]+>/g, "").trim();
}
function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
const num = (s: string | null) => {
  const n = s === null ? NaN : Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// ---------- ticker <-> CIK ----------
interface TickerRow {
  cik: number;
  ticker: string;
  title: string;
}
let tickerCache: { at: number; rows: TickerRow[] } | null = null;

export async function tickerTable(): Promise<TickerRow[]> {
  if (tickerCache && Date.now() - tickerCache.at < DAY) return tickerCache.rows;
  const res = await sec("https://www.sec.gov/files/company_tickers.json", 86400);
  if (!res) return tickerCache?.rows ?? [];
  const j = (await res.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
  const rows = Object.values(j).map((r) => ({ cik: r.cik_str, ticker: r.ticker.toUpperCase(), title: r.title }));
  tickerCache = { at: Date.now(), rows };
  return rows;
}

function normName(s: string): string {
  return s
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[.,/'"()-]/g, " ")
    .replace(/\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|NV|N V|SA|AG|HOLDINGS?|GROUP|THE|CL|CLASS|A|B|C|COM|NEW|DEL|ORD|SHS|ADR|SPONSORED|ETF|TR|TRUST)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- Form 4: insider transactions ----------
export interface InsiderTrade {
  name: string;
  role: string;
  date: string;
  code: "P" | "S";
  shares: number;
  price: number;
  value: number;
  url: string;
}

export interface InsiderSummary {
  symbol: string;
  windowDays: number;
  filingsChecked: number;
  buys: InsiderTrade[];
  sells: InsiderTrade[];
  buyValue: number;
  sellValue: number;
  error?: string;
}

function roleOf(xml: string): string {
  const rel = tag(xml, "reportingOwnerRelationship") ?? "";
  const parts: string[] = [];
  const t = tag(rel, "officerTitle");
  if (t) parts.push(t);
  if (/<(?:\w+:)?isDirector>\s*(1|true)/i.test(rel)) parts.push("Director");
  if (/<(?:\w+:)?isTenPercentOwner>\s*(1|true)/i.test(rel)) parts.push("10% owner");
  return parts.join(", ") || "Insider";
}

export async function insiderActivity(symbol: string, windowDays = 90, maxFilings = 15): Promise<InsiderSummary> {
  const base: InsiderSummary = { symbol, windowDays, filingsChecked: 0, buys: [], sells: [], buyValue: 0, sellValue: 0 };
  const rows = await tickerTable();
  if (!rows.length) return { ...base, error: "SEC EDGAR did not respond." };
  const hit = rows.find((r) => r.ticker === symbol.toUpperCase().replace(".", "-")) ?? rows.find((r) => r.ticker === symbol.toUpperCase());
  if (!hit) return { ...base, error: "Not an SEC-registered issuer (ETFs and some foreign companies don't file Form 4)." };
  const cik10 = String(hit.cik).padStart(10, "0");
  const subRes = await sec(`https://data.sec.gov/submissions/CIK${cik10}.json`, 21600);
  if (!subRes) return { ...base, error: "SEC EDGAR did not respond." };
  const sub = await subRes.json();
  const r = sub?.filings?.recent;
  if (!r) return { ...base, error: "No filings found." };
  const since = new Date(Date.now() - windowDays * DAY).toISOString().slice(0, 10);
  const idx: number[] = [];
  for (let i = 0; i < r.form.length && idx.length < maxFilings; i++) {
    if (r.form[i] === "4" && r.filingDate[i] >= since) idx.push(i);
  }
  const results = await pool(idx, 4, async (i) => {
    const acc = String(r.accessionNumber[i]).replace(/-/g, "");
    const doc = String(r.primaryDocument[i]).replace(/^xsl[^/]*\//, "");
    const url = `https://www.sec.gov/Archives/edgar/data/${hit.cik}/${acc}/${doc}`;
    const res = await sec(url, 604800); // filings never change once filed
    if (!res) return [] as InsiderTrade[];
    const xml = await res.text();
    const owner = tag(xml, "rptOwnerName") ?? "Insider";
    const role = roleOf(xml);
    const trades: InsiderTrade[] = [];
    for (const t of blocks(xml, "nonDerivativeTransaction")) {
      const code = tag(tag(t, "transactionCoding") ?? "", "transactionCode");
      if (code !== "P" && code !== "S") continue;
      const shares = num(val(t, "transactionShares"));
      const price = num(val(t, "transactionPricePerShare"));
      trades.push({
        name: owner,
        role,
        date: val(t, "transactionDate")?.slice(0, 10) ?? String(r.filingDate[i]),
        code,
        shares,
        price,
        value: shares * price,
        url: `https://www.sec.gov/Archives/edgar/data/${hit.cik}/${acc}/${String(r.primaryDocument[i])}`,
      });
    }
    return trades;
  });
  const all = results.flat();
  const buys = all.filter((t) => t.code === "P").sort((a, b) => b.date.localeCompare(a.date));
  const sells = all.filter((t) => t.code === "S").sort((a, b) => b.date.localeCompare(a.date));
  return {
    ...base,
    filingsChecked: idx.length,
    buys,
    sells,
    buyValue: buys.reduce((s, t) => s + t.value, 0),
    sellValue: sells.reduce((s, t) => s + t.value, 0),
  };
}

// ---------- 13F-HR: tracked fund changes ----------
interface Holding {
  name: string;
  cusip: string;
  value: number;
  shares: number;
  putCall: string | null;
}

async function latest13F(cik: number): Promise<{ period: string; filed: string; holdings: Holding[] }[]> {
  const cik10 = String(cik).padStart(10, "0");
  const subRes = await sec(`https://data.sec.gov/submissions/CIK${cik10}.json`, 43200);
  if (!subRes) return [];
  const sub = await subRes.json();
  const r = sub?.filings?.recent;
  if (!r) return [];
  const picks: number[] = [];
  for (let i = 0; i < r.form.length && picks.length < 2; i++) if (r.form[i] === "13F-HR") picks.push(i);
  const out: { period: string; filed: string; holdings: Holding[] }[] = [];
  for (const i of picks) {
    const acc = String(r.accessionNumber[i]).replace(/-/g, "");
    const idxRes = await sec(`https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/index.json`, 604800);
    if (!idxRes) continue;
    const idx = await idxRes.json();
    const items = (idx?.directory?.item ?? []) as { name: string }[];
    const info = items.find((f) => /\.xml$/i.test(f.name) && !/primary_doc/i.test(f.name));
    if (!info) continue;
    const xRes = await sec(`https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${info.name}`, 604800);
    if (!xRes) continue;
    const xml = await xRes.text();
    const map = new Map<string, Holding>();
    for (const b of blocks(xml, "infoTable")) {
      const putCall = tag(b, "putCall");
      if (putCall) continue; // options positions are hedges as often as bets: leave them out
      const cusip = (tag(b, "cusip") ?? "").toUpperCase();
      const h = map.get(cusip) ?? { name: tag(b, "nameOfIssuer") ?? cusip, cusip, value: 0, shares: 0, putCall: null };
      h.value += num(tag(b, "value"));
      h.shares += num(tag(tag(b, "shrsOrPrnAmt") ?? "", "sshPrnamt"));
      map.set(cusip, h);
    }
    out.push({ period: String(r.reportDate[i] ?? ""), filed: String(r.filingDate[i]), holdings: Array.from(map.values()) });
  }
  return out;
}

export interface FundMove {
  fund: string;
  manager: string;
  action: "New" | "Added" | "Trimmed" | "Exited";
  issuer: string;
  ticker: string | null;
  value: number; // latest-quarter value ($), or prior value for exits
  sharesChangePct: number | null;
  portfolioPct: number | null;
}

export interface FundSummary {
  fund: string;
  manager: string;
  period: string;
  filed: string;
  positions: number;
  totalValue: number;
  top: { issuer: string; ticker: string | null; value: number; pct: number }[];
  moves: FundMove[];
}

export interface FundsPayload {
  funds: FundSummary[];
  consensus: { issuer: string; ticker: string | null; buyers: string[]; sellers: string[]; netValue: number }[];
  errors: string[];
}

export async function fundPositioning(): Promise<FundsPayload> {
  const tickers = await tickerTable();
  const byName = new Map<string, string>();
  for (const t of tickers) {
    const k = normName(t.title);
    if (k && !byName.has(k)) byName.set(k, t.ticker);
  }
  const tickerFor = (issuer: string) => byName.get(normName(issuer)) ?? null;

  const errors: string[] = [];
  const funds: FundSummary[] = [];
  const results = await pool(TRACKED_FUNDS, 3, async (f) => ({ f, filings: await latest13F(f.cik).catch(() => []) }));
  for (const { f, filings } of results) {
    if (filings.length === 0) {
      errors.push(`${f.name}: 13F not available`);
      continue;
    }
    const [cur, prev] = filings;
    const total = cur.holdings.reduce((s, h) => s + h.value, 0);
    const prevBy = new Map((prev?.holdings ?? []).map((h) => [h.cusip, h]));
    const curBy = new Map(cur.holdings.map((h) => [h.cusip, h]));
    const moves: FundMove[] = [];
    if (prev) {
      for (const h of cur.holdings) {
        const p = prevBy.get(h.cusip);
        const pctOfBook = total > 0 ? (h.value / total) * 100 : null;
        if (!p) moves.push({ fund: f.name, manager: f.manager, action: "New", issuer: h.name, ticker: tickerFor(h.name), value: h.value, sharesChangePct: null, portfolioPct: pctOfBook });
        else if (p.shares > 0) {
          const ch = (h.shares / p.shares - 1) * 100;
          if (ch >= 10) moves.push({ fund: f.name, manager: f.manager, action: "Added", issuer: h.name, ticker: tickerFor(h.name), value: h.value, sharesChangePct: ch, portfolioPct: pctOfBook });
          else if (ch <= -10) moves.push({ fund: f.name, manager: f.manager, action: "Trimmed", issuer: h.name, ticker: tickerFor(h.name), value: h.value, sharesChangePct: ch, portfolioPct: pctOfBook });
        }
      }
      for (const p of prev.holdings) {
        if (!curBy.has(p.cusip)) moves.push({ fund: f.name, manager: f.manager, action: "Exited", issuer: p.name, ticker: tickerFor(p.name), value: p.value, sharesChangePct: -100, portfolioPct: null });
      }
    }
    moves.sort((a, b) => b.value - a.value);
    funds.push({
      fund: f.name,
      manager: f.manager,
      period: cur.period,
      filed: cur.filed,
      positions: cur.holdings.length,
      totalValue: total,
      top: [...cur.holdings]
        .sort((a, b) => b.value - a.value)
        .slice(0, 5)
        .map((h) => ({ issuer: h.name, ticker: tickerFor(h.name), value: h.value, pct: total > 0 ? (h.value / total) * 100 : 0 })),
      moves: moves.slice(0, 25),
    });
  }

  // consensus: names several tracked funds bought (new/added) or sold (trimmed/exited)
  const agg = new Map<string, { issuer: string; ticker: string | null; buyers: string[]; sellers: string[]; netValue: number }>();
  for (const fs of funds)
    for (const m of fs.moves) {
      const key = m.ticker ?? normName(m.issuer);
      const a = agg.get(key) ?? { issuer: m.issuer, ticker: m.ticker, buyers: [], sellers: [], netValue: 0 };
      if (m.action === "New" || m.action === "Added") {
        a.buyers.push(fs.fund);
        a.netValue += m.value;
      } else {
        a.sellers.push(fs.fund);
        a.netValue -= m.value;
      }
      agg.set(key, a);
    }
  const consensus = Array.from(agg.values())
    .filter((a) => a.buyers.length + a.sellers.length >= 2)
    .sort((a, b) => b.buyers.length - b.sellers.length - (a.buyers.length - a.sellers.length) || b.netValue - a.netValue)
    .slice(0, 25);
  return { funds, consensus, errors };
}
