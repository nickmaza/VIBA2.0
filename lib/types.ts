export type Bucket =
  | "strong risk-on"
  | "risk-on"
  | "neutral"
  | "risk-off / caution"
  | "elevated risk / crash-warning";

export interface RegimeSnapshotRow {
  index_symbol: "SPY" | "QQQ" | "IWM";
  score: number;
  bucket: Bucket;
  as_of: string; // ISO date
  updated_at: string; // ISO timestamp
  // The five weighted inputs that blend into `score` above (each its own
  // rolling 252-day z-score) -- exposed so the UI can show exactly what's
  // being tracked, not just the final composite.
  z_trend: number | null;
  z_breadth: number | null;
  z_vol: number | null;
  z_credit: number | null;
  z_curve: number | null;
}

export interface RawPriceRow {
  symbol: string;
  date: string; // ISO date, latest close on file for this symbol
  close: number;
  updated_at: string; // ISO timestamp, when this row was last written
  // From the latest_prices view: previous session's close, the change vs it,
  // and the trailing-252-session high/low. Null when there's no prior bar.
  prev_close: number | null;
  chg: number | null;
  chg_pct: number | null;
  hi_52w: number | null;
  lo_52w: number | null;
}

export interface RefreshLogRow {
  id: number;
  refreshed_at: string; // ISO timestamp
  source: string;
  ok: boolean;
  note: string | null;
}

export interface RegimeHistoryRow {
  d: string; // ISO date (weekly)
  spy: number;
  qqq: number;
  iwm: number;
}

export interface SectorRankingRow {
  rank: number;
  ticker: string;
  name: string;
  score: number; // risk-adjusted blended momentum (unitless)
  r3: number; // trailing 3-month total return, in PERCENT (12.9 = +12.9%)
  r6: number; // trailing 6-month total return, in percent
  r12: number; // trailing 12-month total return, in percent
  as_of: string;
}

export interface BacktestCurvePointRow {
  strategy: "baseline" | "top3" | "dual" | "bottom3";
  month: string; // "YYYY-MM"
  growth: number; // growth of $1
}

export interface BacktestStatRow {
  strategy: "baseline" | "top3" | "dual" | "bottom3";
  label: string;
  cagr: number;
  ann_vol: number;
  sharpe: number;
  max_dd: number;
  total_return: number;
}

/**
 * One day's reading of how tradeable the sector rotation actually is.
 * dispersion = cross-sectional stdev of the 11 sector scores (are sectors
 * separating at all); spread = mean(top 3) - mean(bottom 3) (how wide the
 * leader/laggard gap is); persistence = Spearman rank correlation vs 21
 * sessions ago (is the leadership holding still). strength blends the three
 * into 0-100. Wide dispersion with no persistence is churn, not rotation.
 */
export interface RotationStrengthRow {
  d: string;
  dispersion: number;
  spread: number;
  persistence: number; // -1..+1
  strength: number; // 0..100
  state: string; // strong | moderate | weak | churn
  leaders: string | null; // comma-separated tickers
  laggards: string | null;
}

/**
 * One candidate long from the rotation, with mechanically derived levels.
 * Stop is volatility- and structure-aware, capped at 3 ATR; targets sit at
 * fixed 2R / 3R, so rr1/rr2 are 2 and 3 by construction and t1_atr/t2_atr
 * (how many daily ATRs the target is away) is the feasibility check.
 */
export interface TradeSetupRow {
  symbol: string;
  name: string;
  kind: "sector_etf" | "stock" | string;
  sector_etf: string | null;
  sector_name: string | null;
  sector_rank: number | null;
  score: number;
  strength: number; // 0..100 conviction blend
  close: number;
  atr: number;
  atr_pct: number;
  entry: number;
  buy_zone_low: number;
  stop: number;
  t1: number;
  t2: number;
  risk_per_share: number;
  risk_pct: number | null;
  rr1: number;
  rr2: number;
  t1_atr: number | null;
  t2_atr: number | null;
  ext_pct: number | null; // % above the 50-day average
  trend_ok: boolean; // close > 50dma > 100dma
  atr_true: boolean; // ATR built from real highs/lows, not close-only proxy
  r3: number | null;
  r6: number | null;
  r12: number | null;
  as_of: string;
  note: string | null;
}

export interface RefreshMeta {
  last_refreshed_at: string;
  next_refresh_at: string | null;
  source: string;
}
