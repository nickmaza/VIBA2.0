import { supabase } from "./supabase";
import { INSTRUMENTS } from "./instruments";
import { num, rows, selectAll } from "./db";
import type {
  RegimeHistoryRow,
  RegimeSnapshotRow,
  SectorRankingRow,
  BacktestCurvePointRow,
  BacktestStatRow,
  RawPriceRow,
  RefreshLogRow,
  RotationStrengthRow,
  TradeSetupRow,
  PipelineStatusRow,
} from "./types";

export interface TerminalData {
  asOf: string | null; // session date of the latest regime score
  fetchedAt: string; // when this page's data was read from Supabase
  errors: string[]; // queries that failed; the affected panels render empty
  snapshot: RegimeSnapshotRow[];
  history: RegimeHistoryRow[];
  sectors: SectorRankingRow[];
  curves: BacktestCurvePointRow[];
  stats: BacktestStatRow[];
  prices: RawPriceRow[]; // latest close per tracked instrument
  refreshLog: RefreshLogRow[]; // recent pipeline runs
  pipeline: PipelineStatusRow[]; // latest run of every job
  rotation: RotationStrengthRow[]; // daily rotation-strength series, oldest first
  setups: TradeSetupRow[]; // current candidate longs with entry/stop/targets
}

function normalizeSnapshot(raw: Record<string, unknown>): RegimeSnapshotRow {
  return {
    index_symbol: String(raw.index_symbol) as RegimeSnapshotRow["index_symbol"],
    score: num(raw.score) ?? 0,
    bucket: String(raw.bucket) as RegimeSnapshotRow["bucket"],
    as_of: String(raw.as_of),
    updated_at: String(raw.updated_at),
    z_trend: num(raw.z_trend),
    z_breadth: num(raw.z_breadth),
    z_vol: num(raw.z_vol),
    z_credit: num(raw.z_credit),
    z_curve: num(raw.z_curve),
  };
}

function normalizeHistory(raw: Record<string, unknown>): RegimeHistoryRow {
  return { d: String(raw.d), spy: num(raw.spy) ?? 0, qqq: num(raw.qqq) ?? 0, iwm: num(raw.iwm) ?? 0 };
}

function normalizeSector(raw: Record<string, unknown>): SectorRankingRow {
  return {
    rank: num(raw.rank) ?? 0,
    ticker: String(raw.ticker),
    name: String(raw.name),
    score: num(raw.score) ?? 0,
    r3: num(raw.r3) ?? 0,
    r6: num(raw.r6) ?? 0,
    r12: num(raw.r12) ?? 0,
    as_of: String(raw.as_of),
  };
}

function normalizeCurve(raw: Record<string, unknown>): BacktestCurvePointRow {
  return { strategy: String(raw.strategy) as BacktestCurvePointRow["strategy"], month: String(raw.month), growth: num(raw.growth) ?? 1 };
}

function normalizeStat(raw: Record<string, unknown>): BacktestStatRow {
  return {
    strategy: String(raw.strategy) as BacktestStatRow["strategy"],
    label: String(raw.label ?? raw.strategy),
    cagr: num(raw.cagr) ?? 0,
    ann_vol: num(raw.ann_vol) ?? 0,
    sharpe: num(raw.sharpe) ?? 0,
    max_dd: num(raw.max_dd) ?? 0,
    total_return: num(raw.total_return) ?? 0,
  };
}

function normalizePrice(raw: Record<string, unknown>): RawPriceRow {
  return {
    symbol: String(raw.symbol),
    date: String(raw.date),
    close: num(raw.close) ?? 0,
    updated_at: String(raw.updated_at),
    prev_close: num(raw.prev_close),
    chg: num(raw.chg),
    chg_pct: num(raw.chg_pct),
    hi_52w: num(raw.hi_52w),
    lo_52w: num(raw.lo_52w),
  };
}

function normalizeRotation(raw: Record<string, unknown>): RotationStrengthRow {
  return {
    d: String(raw.d),
    dispersion: num(raw.dispersion) ?? 0,
    spread: num(raw.spread) ?? 0,
    persistence: num(raw.persistence) ?? 0,
    strength: num(raw.strength) ?? 0,
    state: String(raw.state ?? "weak"),
    leaders: raw.leaders == null ? null : String(raw.leaders),
    laggards: raw.laggards == null ? null : String(raw.laggards),
  };
}

function normalizeSetup(raw: Record<string, unknown>): TradeSetupRow {
  return {
    symbol: String(raw.symbol),
    name: String(raw.name ?? raw.symbol),
    kind: String(raw.kind ?? "stock"),
    sector_etf: raw.sector_etf == null ? null : String(raw.sector_etf),
    sector_name: raw.sector_name == null ? null : String(raw.sector_name),
    sector_rank: num(raw.sector_rank),
    score: num(raw.score) ?? 0,
    strength: num(raw.strength) ?? 0,
    close: num(raw.close) ?? 0,
    atr: num(raw.atr) ?? 0,
    atr_pct: num(raw.atr_pct) ?? 0,
    entry: num(raw.entry) ?? 0,
    buy_zone_low: num(raw.buy_zone_low) ?? 0,
    stop: num(raw.stop) ?? 0,
    t1: num(raw.t1) ?? 0,
    t2: num(raw.t2) ?? 0,
    risk_per_share: num(raw.risk_per_share) ?? 0,
    risk_pct: num(raw.risk_pct),
    rr1: num(raw.rr1) ?? 0,
    rr2: num(raw.rr2) ?? 0,
    t1_atr: num(raw.t1_atr),
    t2_atr: num(raw.t2_atr),
    ext_pct: num(raw.ext_pct),
    trend_ok: Boolean(raw.trend_ok),
    atr_true: Boolean(raw.atr_true),
    r3: num(raw.r3),
    r6: num(raw.r6),
    r12: num(raw.r12),
    as_of: String(raw.as_of),
    note: raw.note == null ? null : String(raw.note),
  };
}

/**
 * Server-side read of everything the terminal renders on first paint, straight
 * from the Supabase tables the pipeline keeps current. There is no fallback
 * dataset: a query that fails is reported in `errors` and its panels render
 * empty, so nothing on screen is ever made up.
 */
export async function getTerminalData(): Promise<TerminalData> {
  const errors: string[] = [];
  async function load<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
    try {
      return await run();
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }
  const [snapshot, history, sectors, curves, stats, prices, refreshLog, rotation, setups, pipeline] = await Promise.all([
    load("regime_snapshot", async () => (await rows(supabase.from("regime_snapshot").select("*").order("index_symbol"))).map(normalizeSnapshot)),
    load("regime_history", async () =>
      (await selectAll<Record<string, unknown>>((a, b) => supabase.from("regime_history").select("d,spy,qqq,iwm").order("d").range(a, b))).map(
        normalizeHistory,
      ),
    ),
    load("sector_rankings", async () => (await rows(supabase.from("sector_rankings").select("*").order("rank"))).map(normalizeSector)),
    load("backtest_curves", async () =>
      (await selectAll<Record<string, unknown>>((a, b) => supabase.from("backtest_curves").select("*").order("month").order("strategy").range(a, b))).map(
        normalizeCurve,
      ),
    ),
    load("backtest_stats", async () => (await rows(supabase.from("backtest_stats").select("*"))).map(normalizeStat)),
    load("latest_prices", async () =>
      (await rows(supabase.from("latest_prices").select("*").in("symbol", INSTRUMENTS.map((i) => i.symbol)).order("symbol"))).map(normalizePrice),
    ),
    load("refresh_log", async () =>
      (await rows(supabase.from("refresh_log").select("*").order("refreshed_at", { ascending: false }).limit(60))) as unknown as RefreshLogRow[],
    ),
    load("rotation_strength", async () =>
      (await selectAll<Record<string, unknown>>((a, b) => supabase.from("rotation_strength").select("*").order("d").range(a, b))).map(normalizeRotation),
    ),
    load("trade_setups", async () =>
      (await rows(supabase.from("trade_setups").select("*").order("strength", { ascending: false }))).map(normalizeSetup),
    ),
    load("pipeline_status", async () =>
      (await rows(supabase.from("pipeline_status").select("*").order("source"))).map((r) => ({
        source: String(r.source),
        refreshed_at: String(r.refreshed_at),
        ok: Boolean(r.ok),
        note: r.note == null ? null : String(r.note),
        runs_24h: num(r.runs_24h) ?? 0,
        failures_24h: num(r.failures_24h) ?? 0,
      })),
    ),
  ]);

  return {
    asOf: snapshot[0]?.as_of ?? null,
    fetchedAt: new Date().toISOString(),
    errors,
    snapshot,
    history,
    sectors,
    curves,
    stats,
    prices,
    refreshLog,
    pipeline,
    rotation,
    setups,
  };
}
