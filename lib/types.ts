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
  score: number;
  r3: number;
  r6: number;
  r12: number;
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
