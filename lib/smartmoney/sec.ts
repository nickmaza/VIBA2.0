// Insider trades (SEC Form 4) and hedge-fund positioning (13F filings), read
// from Supabase. Both datasets come straight from SEC EDGAR through edge
// functions on pg_cron:
//   sync-insiders  daily Form 4 index -> every filing for a library stock ->
//                  its open-market purchases (P) and sales (S) -> insider_trades
//   sync-13f       the two latest 13F-HR filings of 12 tracked funds ->
//                  fund_filings / fund_holdings -> the adds / trims / exits
//                  report in smart_money_reports('funds')
import { supabase } from "@/lib/supabase";
import { num, selectAll } from "@/lib/db";

export interface InsiderTrade {
  name: string;
  role: string;
  date: string; // transaction date
  filed: string;
  code: "P" | "S";
  shares: number;
  price: number;
  value: number;
  url: string;
}

export interface InsiderSummary {
  symbol: string;
  windowDays: number;
  filings: number; // Form 4 filings with open-market trades in the window
  buys: InsiderTrade[];
  sells: InsiderTrade[];
  buyValue: number;
  sellValue: number;
  error?: string;
}

export interface InsiderCoverage {
  firstFiled: string | null; // earliest Form 4 filing date parsed so far
  lastFiled: string | null;
  parsed: number;
  pending: number; // filings still queued (the backfill works newest first)
}

export interface InsidersPayload {
  results: InsiderSummary[];
  coverage: InsiderCoverage | null;
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
  source?: string;
  asOf?: string | null; // latest 13F filing date
  generatedAt?: string | null;
}

/** Open-market insider buys and sells for each symbol over the last `windowDays` of Form 4 filings. */
export async function insiderActivity(symbols: string[], windowDays = 90): Promise<InsidersPayload> {
  const since = new Date(Date.now() - windowDays * 864e5).toISOString().slice(0, 10);
  const trades = await selectAll<Record<string, unknown>>((a, b) =>
    supabase
      .from("insider_trades")
      .select("accession,seq,symbol,insider,role,code,traded,filed,shares,price,value,url")
      .in("symbol", symbols)
      .gte("filed", since)
      .order("traded", { ascending: false })
      .order("accession")
      .order("seq")
      .range(a, b),
  );
  const results: InsiderSummary[] = symbols.map((symbol) => {
    const mine = trades.filter((t) => t.symbol === symbol);
    const toTrade = (t: Record<string, unknown>): InsiderTrade => ({
      name: String(t.insider ?? "Insider"),
      role: String(t.role ?? ""),
      date: String(t.traded ?? t.filed ?? ""),
      filed: String(t.filed ?? ""),
      code: t.code === "P" ? "P" : "S",
      shares: num(t.shares) ?? 0,
      price: num(t.price) ?? 0,
      value: num(t.value) ?? 0,
      url: String(t.url ?? ""),
    });
    const buys = mine.filter((t) => t.code === "P").map(toTrade);
    const sells = mine.filter((t) => t.code === "S").map(toTrade);
    return {
      symbol,
      windowDays,
      filings: new Set(mine.map((t) => String(t.accession))).size,
      buys,
      sells,
      buyValue: buys.reduce((s, t) => s + t.value, 0),
      sellValue: sells.reduce((s, t) => s + t.value, 0),
    };
  });

  let coverage: InsiderCoverage | null = null;
  const { data: cov } = await supabase.rpc("insider_coverage");
  const c = (Array.isArray(cov) ? cov[0] : cov) as Record<string, unknown> | null;
  if (c) {
    coverage = {
      firstFiled: c.first_filed ? String(c.first_filed) : null,
      lastFiled: c.last_filed ? String(c.last_filed) : null,
      parsed: num(c.parsed) ?? 0,
      pending: num(c.pending) ?? 0,
    };
  }
  return { results, coverage };
}

/** The latest 13F positioning report (sync-13f). */
export async function fundPositioning(): Promise<FundsPayload> {
  const { data, error } = await supabase
    .from("smart_money_reports")
    .select("as_of,generated_at,payload")
    .eq("kind", "funds")
    .maybeSingle();
  if (error) throw new Error(`smart_money_reports: ${error.message}`);
  const row = data as { as_of: string | null; generated_at: string | null; payload: FundsPayload } | null;
  if (!row?.payload) throw new Error("13F positioning hasn't been computed yet.");
  return { ...row.payload, asOf: row.as_of, generatedAt: row.generated_at };
}
