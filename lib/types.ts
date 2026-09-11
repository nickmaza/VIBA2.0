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

export interface RefreshMeta {
  last_refreshed_at: string;
  next_refresh_at: string | null;
  source: string;
}
