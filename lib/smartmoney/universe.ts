// What the Smart Money tab watches.

export interface FlowAsset {
  symbol: string;
  name: string;
  group: "Sectors" | "Industries" | "Size & style" | "Macro & safe havens";
}

export const FLOW_ASSETS: FlowAsset[] = [
  { symbol: "XLK", name: "Technology", group: "Sectors" },
  { symbol: "XLF", name: "Financials", group: "Sectors" },
  { symbol: "XLE", name: "Energy", group: "Sectors" },
  { symbol: "XLV", name: "Health Care", group: "Sectors" },
  { symbol: "XLY", name: "Consumer Discretionary", group: "Sectors" },
  { symbol: "XLP", name: "Consumer Staples", group: "Sectors" },
  { symbol: "XLI", name: "Industrials", group: "Sectors" },
  { symbol: "XLB", name: "Materials", group: "Sectors" },
  { symbol: "XLU", name: "Utilities", group: "Sectors" },
  { symbol: "XLRE", name: "Real Estate", group: "Sectors" },
  { symbol: "XLC", name: "Communication Services", group: "Sectors" },
  { symbol: "SMH", name: "Semiconductors", group: "Industries" },
  { symbol: "KRE", name: "Regional Banks", group: "Industries" },
  { symbol: "XBI", name: "Biotech", group: "Industries" },
  { symbol: "ITB", name: "Homebuilders", group: "Industries" },
  { symbol: "QQQ", name: "Nasdaq-100 (growth)", group: "Size & style" },
  { symbol: "IWM", name: "Russell 2000 (small caps)", group: "Size & style" },
  { symbol: "RSP", name: "S&P 500 equal weight", group: "Size & style" },
  { symbol: "GLD", name: "Gold", group: "Macro & safe havens" },
  { symbol: "SLV", name: "Silver", group: "Macro & safe havens" },
  { symbol: "TLT", name: "Long Treasuries (20y+)", group: "Macro & safe havens" },
  { symbol: "IEF", name: "7-10y Treasuries", group: "Macro & safe havens" },
  { symbol: "HYG", name: "High-yield credit", group: "Macro & safe havens" },
  { symbol: "LQD", name: "Investment-grade credit", group: "Macro & safe havens" },
  { symbol: "UUP", name: "US dollar", group: "Macro & safe havens" },
  { symbol: "USO", name: "Crude oil", group: "Macro & safe havens" },
  { symbol: "IBIT", name: "Bitcoin", group: "Macro & safe havens" },
];

/** Ratio pairs that show risk appetite: rising = money choosing the riskier side. */
export const RISK_PAIRS: { a: string; b: string; label: string; riskOn: string; riskOff: string }[] = [
  { a: "XLY", b: "XLP", label: "Discretionary vs Staples", riskOn: "consumers' wants over needs", riskOff: "defensive consumer names" },
  { a: "HYG", b: "IEF", label: "Junk bonds vs Treasuries", riskOn: "credit risk being bought", riskOff: "a flight to Treasuries" },
  { a: "IWM", b: "SPY", label: "Small caps vs S&P 500", riskOn: "broadening into small caps", riskOff: "a retreat to mega caps" },
  { a: "RSP", b: "SPY", label: "Equal weight vs cap weight", riskOn: "broad participation", riskOff: "narrow, top-heavy leadership" },
  { a: "SMH", b: "SPY", label: "Semis vs S&P 500", riskOn: "appetite for high-beta tech", riskOff: "semis lagging the market" },
  { a: "SPY", b: "TLT", label: "Stocks vs long bonds", riskOn: "equities over duration", riskOff: "bonds outperforming stocks" },
  { a: "SPY", b: "GLD", label: "Stocks vs gold", riskOn: "equities over hard assets", riskOff: "gold outperforming stocks" },
];

/**
 * Well-known discretionary managers whose 13F filings are tracked for adds,
 * new positions and exits. CIKs are SEC identifiers.
 */
export const TRACKED_FUNDS: { cik: number; name: string; manager: string }[] = [
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
