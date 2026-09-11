// Every ticker the pipeline reads, with the role it plays in the math. Single
// source of truth for the quote cards, the positions-style table, the bottom
// ticker strip, and the "N/19 reporting" counters.
export type InstrumentRole = "index" | "input" | "sector";

export interface Instrument {
  symbol: string;
  name: string; // fund name, as a quote card would show it
  role: InstrumentRole;
  usage: string; // what the formulas do with it
}

export const INSTRUMENTS: Instrument[] = [
  // --- regime indices: a composite regime score is computed for each ---
  { symbol: "SPY", name: "SPDR S&P 500 ETF", role: "index", usage: "Composite regime score · trend leg" },
  { symbol: "QQQ", name: "Invesco QQQ (Nasdaq-100)", role: "index", usage: "Composite regime score · trend leg" },
  { symbol: "IWM", name: "iShares Russell 2000", role: "index", usage: "Composite regime score · trend leg" },
  // --- regime inputs: market-wide legs shared by all three composites ---
  { symbol: "RSP", name: "Invesco S&P 500 Equal Weight", role: "input", usage: "Breadth leg · RSP/SPY ratio (25%)" },
  { symbol: "VIXY", name: "ProShares VIX Short-Term Futures", role: "input", usage: "Volatility leg · 10d/60d avg (20%)" },
  { symbol: "HYG", name: "iShares iBoxx High Yield Corp", role: "input", usage: "Credit leg · HYG/IEF ratio (20%)" },
  { symbol: "IEF", name: "iShares 7-10 Year Treasury", role: "input", usage: "Credit + rate-curve legs" },
  { symbol: "SHY", name: "iShares 1-3 Year Treasury", role: "input", usage: "Rate-curve leg · IEF/SHY ratio (10%)" },
  // --- sector ETFs: ranked by risk-adjusted 3/6/12-month momentum ---
  { symbol: "XLK", name: "Technology Select Sector SPDR", role: "sector", usage: "Sector rotation ranking" },
  { symbol: "XLF", name: "Financial Select Sector SPDR", role: "sector", usage: "Sector rotation ranking" },
  { symbol: "XLE", name: "Energy Select Sector SPDR", role: "sector", usage: "Sector rotation ranking" },
  { symbol: "XLV", name: "Health Care Select Sector SPDR", role: "sector", usage: "Sector rotation ranking" },
  { symbol: "XLY", name: "Consumer Discretionary SPDR", role: "sector", usage: "Sector rotation ranking" },
  { symbol: "XLP", name: "Consumer Staples SPDR", role: "sector", usage: "Sector rotation ranking" },
  { symbol: "XLI", name: "Industrial Select Sector SPDR", role: "sector", usage: "Sector rotation ranking" },
  { symbol: "XLB", name: "Materials Select Sector SPDR", role: "sector", usage: "Sector rotation ranking" },
  { symbol: "XLU", name: "Utilities Select Sector SPDR", role: "sector", usage: "Sector rotation ranking" },
  { symbol: "XLRE", name: "Real Estate Select Sector SPDR", role: "sector", usage: "Sector rotation ranking" },
  { symbol: "XLC", name: "Communication Services SPDR", role: "sector", usage: "Sector rotation ranking" },
];

export const ROLE_LABEL: Record<InstrumentRole, string> = {
  index: "Index",
  input: "Input",
  sector: "Sector",
};

export const INSTRUMENT_BY_SYMBOL = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

// The five legs of the composite regime score, in formula order.
export const REGIME_LEGS: {
  key: "z_trend" | "z_breadth" | "z_vol" | "z_credit" | "z_curve";
  leg: number;
  label: string;
  inputs: string;
  weight: number;
  perIndex: boolean; // true = differs per index; false = market-wide, shared
}[] = [
  { key: "z_trend", leg: 1, label: "Trend", inputs: "px vs 50d & 200d avg", weight: 0.25, perIndex: true },
  { key: "z_breadth", leg: 2, label: "Breadth", inputs: "RSP / SPY · 20d chg", weight: 0.25, perIndex: false },
  { key: "z_vol", leg: 3, label: "Volatility", inputs: "VIXY 10d / 60d avg (inv.)", weight: 0.2, perIndex: false },
  { key: "z_credit", leg: 4, label: "Credit", inputs: "HYG / IEF · 20d chg", weight: 0.2, perIndex: false },
  { key: "z_curve", leg: 5, label: "Rate curve", inputs: "IEF / SHY · 20d chg", weight: 0.1, perIndex: false },
];

// The pg_cron schedules from supabase/schema.sql, so the UI can show when the
// next automated compute is due. Hours are UTC (14-20 = 10am-4pm ET).
export const CRON_JOBS = [
  { name: "compute-regime-score", minute: 10, hours: [14, 15, 16, 17, 18, 19, 20], weekdaysOnly: true },
  { name: "compute-sector-rotation", minute: 12, hours: [14, 15, 16, 17, 18, 19, 20], weekdaysOnly: true },
];
