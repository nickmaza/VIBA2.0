// sync-directory
//
// The US symbol directory behind search, plus reference data for the library:
//   * Nasdaq's public screener API: every US-listed stock (name, sector,
//     industry, market cap) and every US-listed ETF  -> symbol_directory
//   * market cap / industry copied onto the library (symbol_meta)
//   * SEC company_tickers.json: CIK for every library stock, so Form 4
//     filings can be matched to it (sync-insiders)
//
// Runs weekly from pg_cron. Auth: x-refresh-secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  sb,
  authorized,
  json,
  logRun,
  httpGet,
  upsertChunks,
  withRetry,
  getConfig,
  readBody,
  runInBackground,
} from "../_shared/common.ts";

const NASDAQ_HEADERS = {
  Accept: "application/json, text/plain, */*",
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
};
const SYMBOL_RE = /^[A-Z]{1,5}([./][A-Z]{1,2})?$/;

function cleanName(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .replace(
      /\s*(Class [A-Z] )?(Common Stock|Ordinary Shares|Common Shares|American Depositary Shares|American Depository Shares|Depositary Shares|Shares of Beneficial Interest|Common Units|Units?)\b.*$/i,
      "",
    )
    .trim();
}

function money(s: unknown): number | null {
  const n = Number(String(s ?? "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function run() {
  const t0 = Date.now();
  const rows = new Map<string, Record<string, unknown>>();
  const now = new Date().toISOString();

  // ---- stocks ----
  const st = await httpGet("https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true", {
    headers: NASDAQ_HEADERS,
    timeoutMs: 30000,
  });
  if (st.status !== 200) throw new Error(`nasdaq stock screener HTTP ${st.status}`);
  const stocks = (JSON.parse(st.text)?.data?.rows ?? []) as Record<string, string>[];
  for (const r of stocks) {
    const sym = String(r.symbol ?? "").trim().toUpperCase();
    if (!SYMBOL_RE.test(sym)) continue;
    const symbol = sym.replace("/", ".");
    rows.set(symbol, {
      symbol,
      name: cleanName(String(r.name ?? symbol)) || symbol,
      type: "Stock",
      sector: r.sector || null,
      industry: r.industry || null,
      country: r.country || null,
      market_cap: money(r.marketCap),
      updated_at: now,
    });
  }

  // ---- ETFs ----
  const et = await httpGet("https://api.nasdaq.com/api/screener/etf?tableonly=true&download=true", {
    headers: NASDAQ_HEADERS,
    timeoutMs: 30000,
  });
  let etfCount = 0;
  if (et.status === 200) {
    const j = JSON.parse(et.text);
    const etfs = (j?.data?.data?.rows ?? j?.data?.rows ?? []) as Record<string, string>[];
    for (const r of etfs) {
      const sym = String(r.symbol ?? "").trim().toUpperCase();
      if (!SYMBOL_RE.test(sym) || rows.has(sym)) continue;
      rows.set(sym, {
        symbol: sym,
        name: String(r.companyName ?? sym).trim() || sym,
        type: "ETF",
        sector: null,
        industry: null,
        country: null,
        market_cap: null,
        updated_at: now,
      });
      etfCount++;
    }
  }

  const all = Array.from(rows.values());
  if (all.length < 3000) throw new Error(`directory looks truncated (${all.length} rows); not writing`);
  await upsertChunks("symbol_directory", all, "symbol", 1000);
  const applied = (await withRetry("apply_directory_to_library", () => sb.rpc("apply_directory_to_library"))) as number | null;

  // ---- SEC CIKs for the library ----
  const ua = await getConfig("sec_user_agent", "VIBA Terminal research dashboard");
  const sec = await httpGet("https://www.sec.gov/files/company_tickers.json", { ua, timeoutMs: 30000 });
  let ciks = 0;
  let secNote = "";
  if (sec.status === 200) {
    const j = JSON.parse(sec.text) as Record<string, { cik_str: number; ticker: string }>;
    const list = Object.values(j).map((r) => ({ symbol: String(r.ticker).toUpperCase().replace(/-/g, "."), cik: r.cik_str }));
    // first CIK wins for a ticker (the file lists primary share classes first)
    const seen = new Set<string>();
    const uniq = list.filter((r) => (seen.has(r.symbol) ? false : (seen.add(r.symbol), true)));
    ciks = ((await withRetry("set_ciks", () => sb.rpc("set_ciks", { p_rows: uniq }))) as number | null) ?? 0;
  } else {
    secNote = ` · SEC tickers HTTP ${sec.status} (check pipeline_config.sec_user_agent)`;
  }

  const note = `directory=${all.length} (stocks=${all.length - etfCount}, etfs=${etfCount}) library_updated=${applied ?? 0} ciks_set=${ciks}${secNote} ${(
    (Date.now() - t0) / 1000
  ).toFixed(1)}s`;
  await logRun("sync-directory", sec.status === 200, note);
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
      await logRun("sync-directory", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
