// sync-13f
//
// Hedge-fund positioning from SEC EDGAR 13F-HR filings for a tracked set of
// well-known discretionary managers:
//   1. for each fund, the two most recent 13F-HR filings are read (only new
//      accessions are downloaded) into fund_filings / fund_holdings
//   2. new positions, adds (>= +10% shares), trims (<= -10%) and exits are
//      derived by comparing those two filings, plus a consensus list of names
//      several funds bought or sold, and the whole report is written to
//      smart_money_reports('funds') for the Smart Money tab.
// Option positions (put/call rows) are excluded: they are hedges as often as bets.
//
// Body: wait (optional). Auth: x-refresh-secret. Called by pg_cron daily
// (13Fs arrive quarterly, 45 days after quarter end).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, httpGet, withRetry, readBody, runInBackground, sleep, getConfig } from "../_shared/common.ts";

const TRACKED_FUNDS: { cik: number; name: string; manager: string }[] = [
  { cik: 1067983, name: "Berkshire Hathaway", manager: "Warren Buffett / Greg Abel" },
  { cik: 1336528, name: "Pershing Square", manager: "Bill Ackman" },
  { cik: 1656456, name: "Appaloosa", manager: "David Tepper" },
  { cik: 1536411, name: "Duquesne Family Office", manager: "Stanley Druckenmiller" },
  { cik: 1040273, name: "Third Point", manager: "Dan Loeb" },
  { cik: 1167483, name: "Tiger Global", manager: "Chase Coleman" },
  { cik: 1135730, name: "Coatue", manager: "Philippe Laffont" },
  { cik: 1061165, name: "Lone Pine Capital", manager: "" },
  { cik: 1103804, name: "Viking Global", manager: "Andreas Halvorsen" },
  { cik: 1649339, name: "Scion Asset Management", manager: "Michael Burry" },
  { cik: 1029160, name: "Soros Fund Management", manager: "" },
  { cik: 1061768, name: "Baupost Group", manager: "Seth Klarman" },
];

let UA = "VIBA Terminal research dashboard";
async function sec(url: string) {
  await sleep(150); // well under SEC's 10 req/s
  return httpGet(url, { ua: UA, headers: { Accept: "application/json, application/xml, text/xml, */*" }, timeoutMs: 30000 });
}

// ---------- small XML helpers (13F info tables are flat) ----------
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>\\s*([\\s\\S]*?)\\s*</(?:\\w+:)?${name}>`));
  return m ? m[1].trim() : null;
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

function normName(s: string): string {
  return s
    .toUpperCase()
    .replace(/&AMP;/g, "&")
    .replace(/&/g, " AND ")
    .replace(/[.,/'"()-]/g, " ")
    .replace(/\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|NV|N V|SA|AG|HOLDINGS?|GROUP|THE|CL|CLASS|A|B|C|COM|NEW|DEL|ORD|SHS|ADR|SPONSORED|ETF|TR|TRUST)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Holding {
  cusip: string;
  issuer: string;
  value: number;
  shares: number;
}

async function tickerMap(): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  const r = await sec("https://www.sec.gov/files/company_tickers.json");
  if (r.status === 200) {
    const j = JSON.parse(r.text) as Record<string, { ticker: string; title: string }>;
    for (const t of Object.values(j)) {
      const k = normName(t.title);
      if (k && !byName.has(k)) byName.set(k, t.ticker.toUpperCase().replace(/-/g, "."));
    }
  }
  return byName;
}

async function syncFund(f: { cik: number; name: string; manager: string }, names: Map<string, string>) {
  const sub = await sec(`https://data.sec.gov/submissions/CIK${String(f.cik).padStart(10, "0")}.json`);
  if (sub.status !== 200) throw new Error(`${f.name}: submissions HTTP ${sub.status}`);
  const recent = JSON.parse(sub.text)?.filings?.recent;
  if (!recent) throw new Error(`${f.name}: no filings`);
  const picks: number[] = [];
  for (let i = 0; i < recent.form.length && picks.length < 2; i++) if (recent.form[i] === "13F-HR") picks.push(i);
  let downloaded = 0;
  for (const i of picks) {
    const accession = String(recent.accessionNumber[i]);
    const { data: have } = await sb.from("fund_filings").select("accession").eq("fund_cik", f.cik).eq("accession", accession).maybeSingle();
    if (have) continue;
    const acc = accession.replace(/-/g, "");
    const idx = await sec(`https://www.sec.gov/Archives/edgar/data/${f.cik}/${acc}/index.json`);
    if (idx.status !== 200) continue;
    const items = (JSON.parse(idx.text)?.directory?.item ?? []) as { name: string }[];
    const info = items.find((x) => /\.xml$/i.test(x.name) && !/primary_doc/i.test(x.name));
    if (!info) continue;
    const x = await sec(`https://www.sec.gov/Archives/edgar/data/${f.cik}/${acc}/${info.name}`);
    if (x.status !== 200) continue;
    const map = new Map<string, Holding>();
    for (const b of blocks(x.text, "infoTable")) {
      if (tag(b, "putCall")) continue;
      const cusip = (tag(b, "cusip") ?? "").toUpperCase();
      if (!cusip) continue;
      const h = map.get(cusip) ?? { cusip, issuer: (tag(b, "nameOfIssuer") ?? cusip).replace(/&amp;/gi, "&"), value: 0, shares: 0 };
      h.value += num(tag(b, "value"));
      h.shares += num(tag(tag(b, "shrsOrPrnAmt") ?? "", "sshPrnamt"));
      map.set(cusip, h);
    }
    const holdings = Array.from(map.values());
    const total = holdings.reduce((s, h) => s + h.value, 0);
    const rows = holdings.map((h) => ({
      fund_cik: f.cik,
      accession,
      cusip: h.cusip,
      issuer: h.issuer,
      ticker: names.get(normName(h.issuer)) ?? null,
      value: h.value,
      shares: h.shares,
    }));
    for (let k = 0; k < rows.length; k += 500) {
      const part = rows.slice(k, k + 500);
      await withRetry("fund_holdings upsert", () => sb.from("fund_holdings").upsert(part, { onConflict: "fund_cik,accession,cusip" }));
    }
    await withRetry("fund_filings upsert", () =>
      sb.from("fund_filings").upsert(
        {
          fund_cik: f.cik,
          accession,
          fund: f.name,
          manager: f.manager,
          period: recent.reportDate?.[i] || null,
          filed: recent.filingDate?.[i] || null,
          positions: holdings.length,
          total_value: total,
        },
        { onConflict: "fund_cik,accession" },
      )
    );
    downloaded++;
  }
  return downloaded;
}

interface FundMove {
  fund: string;
  manager: string;
  action: "New" | "Added" | "Trimmed" | "Exited";
  issuer: string;
  ticker: string | null;
  value: number;
  sharesChangePct: number | null;
  portfolioPct: number | null;
}

async function buildReport() {
  const funds: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const agg = new Map<string, { issuer: string; ticker: string | null; buyers: string[]; sellers: string[]; netValue: number }>();
  let latestFiled = "";
  for (const f of TRACKED_FUNDS) {
    const { data: fl } = await sb.from("fund_filings").select("*").eq("fund_cik", f.cik).order("filed", { ascending: false }).limit(2);
    const filings = (fl ?? []) as Record<string, unknown>[];
    if (!filings.length) {
      errors.push(`${f.name}: 13F not available`);
      continue;
    }
    const load = async (acc: string) => {
      const out: { cusip: string; issuer: string; ticker: string | null; value: number; shares: number }[] = [];
      for (let from = 0; from < 20000; from += 1000) {
        const { data } = await sb.from("fund_holdings").select("cusip,issuer,ticker,value,shares").eq("fund_cik", f.cik).eq("accession", acc).range(from, from + 999);
        const rows = (data ?? []) as { cusip: string; issuer: string; ticker: string | null; value: number; shares: number }[];
        out.push(...rows.map((r) => ({ ...r, value: Number(r.value), shares: Number(r.shares) })));
        if (rows.length < 1000) break;
      }
      return out;
    };
    const cur = await load(String(filings[0].accession));
    const prev = filings[1] ? await load(String(filings[1].accession)) : null;
    const total = cur.reduce((s, h) => s + h.value, 0);
    const prevBy = new Map((prev ?? []).map((h) => [h.cusip, h]));
    const curBy = new Map(cur.map((h) => [h.cusip, h]));
    const moves: FundMove[] = [];
    if (prev) {
      for (const h of cur) {
        const p = prevBy.get(h.cusip);
        const pct = total > 0 ? (h.value / total) * 100 : null;
        if (!p) moves.push({ fund: f.name, manager: f.manager, action: "New", issuer: h.issuer, ticker: h.ticker, value: h.value, sharesChangePct: null, portfolioPct: pct });
        else if (p.shares > 0) {
          const ch = (h.shares / p.shares - 1) * 100;
          if (ch >= 10) moves.push({ fund: f.name, manager: f.manager, action: "Added", issuer: h.issuer, ticker: h.ticker, value: h.value, sharesChangePct: ch, portfolioPct: pct });
          else if (ch <= -10) moves.push({ fund: f.name, manager: f.manager, action: "Trimmed", issuer: h.issuer, ticker: h.ticker, value: h.value, sharesChangePct: ch, portfolioPct: pct });
        }
      }
      for (const p of prev) {
        if (!curBy.has(p.cusip)) moves.push({ fund: f.name, manager: f.manager, action: "Exited", issuer: p.issuer, ticker: p.ticker, value: p.value, sharesChangePct: -100, portfolioPct: null });
      }
    }
    moves.sort((a, b) => b.value - a.value);
    for (const m of moves) {
      const key = m.ticker ?? normName(m.issuer);
      const a = agg.get(key) ?? { issuer: m.issuer, ticker: m.ticker, buyers: [], sellers: [], netValue: 0 };
      if (m.action === "New" || m.action === "Added") {
        a.buyers.push(f.name);
        a.netValue += m.value;
      } else {
        a.sellers.push(f.name);
        a.netValue -= m.value;
      }
      agg.set(key, a);
    }
    const filed = String(filings[0].filed ?? "");
    if (filed > latestFiled) latestFiled = filed;
    funds.push({
      fund: f.name,
      manager: f.manager,
      period: String(filings[0].period ?? ""),
      filed,
      positions: cur.length,
      totalValue: total,
      top: [...cur].sort((a, b) => b.value - a.value).slice(0, 5).map((h) => ({ issuer: h.issuer, ticker: h.ticker, value: h.value, pct: total > 0 ? (h.value / total) * 100 : 0 })),
      moves: moves.slice(0, 25),
    });
  }
  const consensus = Array.from(agg.values())
    .filter((a) => a.buyers.length + a.sellers.length >= 2)
    .sort((a, b) => b.buyers.length - b.sellers.length - (a.buyers.length - a.sellers.length) || b.netValue - a.netValue)
    .slice(0, 25);
  const payload = { funds, consensus, errors, source: "SEC EDGAR 13F-HR (fund_filings / fund_holdings)" };
  await withRetry("smart_money_reports upsert", () =>
    sb.from("smart_money_reports").upsert(
      { kind: "funds", as_of: latestFiled || null, generated_at: new Date().toISOString(), payload },
      { onConflict: "kind" },
    )
  );
  return { funds: funds.length, consensus: consensus.length, errors };
}

async function run() {
  const t0 = Date.now();
  UA = await getConfig("sec_user_agent", UA);
  const names = await tickerMap();
  let downloaded = 0;
  const errs: string[] = [];
  for (const f of TRACKED_FUNDS) {
    if (Date.now() - t0 > 100000) break;
    try {
      downloaded += await syncFund(f, names);
    } catch (e) {
      errs.push(e instanceof Error ? e.message : String(e));
    }
  }
  const rep = await buildReport();
  const note = `funds=${rep.funds}/${TRACKED_FUNDS.length} new_filings=${downloaded} consensus=${rep.consensus}${errs.length ? ` errors=[${errs.join("; ")}]` : ""} ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  await logRun("sync-13f", rep.funds > 0, note);
  return { ok: true, note };
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  return runInBackground(async () => {
    try {
      return await run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logRun("sync-13f", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
