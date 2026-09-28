// Smart money: where money is moving in the market and where the big,
// informed players are positioning. The report is computed inside Supabase by
// the compute-smart-money edge function (hourly in the session and after the
// evening sweeps) from the datasets the other functions keep there:
//
//   1. Money flow   -- accumulation / distribution from daily price and volume (raw_prices)
//   2. Rotation     -- relative strength + flow across sectors, size, bonds, gold, dollar, bitcoin
//   3. Risk appetite-- ratio pairs (junk vs Treasuries, discretionary vs staples, ...)
//   4. Options      -- call vs put premium and volume vs normal (options_daily, from CBOE)
//   5. Congress     -- disclosed STOCK Act trades (congress_trades, Senate eFD + House Clerk)
// Insider buying (SEC Form 4) and 13F fund changes are read separately
// (lib/smartmoney/sec.ts).
//
// Everything here is descriptive: it shows where volume and positioning are
// leaning, not what prices will do next.
import type { Analysis } from "@/lib/ta";
import { supabase } from "@/lib/supabase";
import type { Flow } from "./flow";

export interface OptionsRow {
  symbol: string;
  name: string;
  callPremium: number;
  putPremium: number;
  callVol: number;
  putVol: number;
  callVolAvg10: number;
  putVolAvg10: number;
  callOI: number;
  putOI: number;
  callOIAvg10: number;
  putOIAvg10: number;
  marketCap: number | null;
  last: number | null;
  histDays: number; // prior sessions stored for this name (the 10-day averages need them)
}

export interface CongressTrade {
  politician: string;
  party: string;
  side: "BUY" | "SELL";
  amount: string; // disclosed range
  traded: string;
  disclosed: string;
  chamber: string; // "senate" | "house"
  url: string | null; // the filing
}

export interface CongressSummary {
  symbol: string;
  buys: number;
  sells: number;
  trades: CongressTrade[];
}

export interface OptionsRead {
  skew: number; // call premium / put premium
  callVolRatio: number; // today's call volume / 10-day average
  putVolRatio: number;
  pcVolume: number; // put volume / call volume
  callOIChange: number; // call OI vs 10-day average, %
  score: number; // 0..100
  label: string;
}

export type Quadrant = "Leading" | "Improving" | "Weakening" | "Lagging";

export interface AssetFlow {
  symbol: string;
  name: string;
  group: string;
  flow: Flow;
  rs1m: number | null; // % vs SPY
  rs3m: number | null;
  quadrant: Quadrant | null;
}

export interface RiskPairRead {
  label: string;
  pair: string;
  change: number | null; // ratio % change over 20 sessions
  riskOn: boolean | null;
  read: string;
}

export interface SlimAnalysis {
  ind: Analysis["ind"];
  levels: Analysis["levels"];
  setups: Analysis["setups"];
  primary: Analysis["primary"];
  trend: Analysis["trend"];
  narrative: string[];
  noSetup: string | null;
}

export interface Evidence {
  kind: "flow" | "options" | "strength" | "congress" | "trend";
  label: string;
  detail: string;
  state: "ok" | "pending" | "fail";
}

export interface SmartMoneyPlay {
  symbol: string;
  name: string;
  score: number;
  flow: Flow;
  options: OptionsRead | null;
  optionsRow: OptionsRow | null;
  congress: CongressSummary | null;
  rs3m: number | null;
  evidence: Evidence[];
  thesis: string;
  analysis: SlimAnalysis | null;
  source: string;
  closes: number[];
}

export interface StockFlowRow {
  symbol: string;
  name: string;
  flow: Flow;
  options: OptionsRead | null;
  callPremium: number | null;
  putPremium: number | null;
  score: number;
}

export interface SmartMoneyPayload {
  generatedAt: string;
  barsAsOf: string; // last daily bar behind the flows
  feedAsOf: string; // options session
  feedSource: "supabase";
  optionsHistoryDays: number; // sessions of options history behind the 10-day averages
  headline: string[];
  assets: AssetFlow[];
  riskPairs: RiskPairRead[];
  riskOnCount: number;
  riskRead: string;
  optionsMarket: { callPremium: number; putPremium: number; ratio: number; names: number };
  optionsLeaders: { symbol: string; name: string; read: OptionsRead; callPremium: number; putPremium: number }[];
  putHeavy: { symbol: string; name: string; read: OptionsRead; callPremium: number; putPremium: number }[];
  stockFlows: StockFlowRow[];
  plays: SmartMoneyPlay[];
  congress: CongressSummary[];
  congressWindowDays: number;
  sources: Record<string, string>;
}

/** The latest smart money report, as compute-smart-money stored it. */
export async function getSmartMoney(): Promise<SmartMoneyPayload> {
  const { data, error } = await supabase
    .from("smart_money_reports")
    .select("as_of,generated_at,payload")
    .eq("kind", "smart_money")
    .maybeSingle();
  if (error) throw new Error(`smart_money_reports: ${error.message}`);
  const payload = (data as { payload?: SmartMoneyPayload } | null)?.payload;
  if (!payload) throw new Error("The smart money report hasn't been computed yet.");
  return payload;
}
