import { supabase, hasSupabase } from "./supabase";
import {
  demoHistory,
  demoSnapshot,
  demoSectors,
  demoCurves,
  demoStats,
  demoPrices,
  demoRefreshLog,
  demoRotation,
  demoSetups,
  DEMO_AS_OF,
} from "./demo-data";
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
} from "./types";

export interface TerminalData {
  isLive: boolean;
  asOf: string;
  snapshot: RegimeSnapshotRow[];
  history: RegimeHistoryRow[];
  sectors: SectorRankingRow[];
  curves: BacktestCurvePointRow[];
  stats: BacktestStatRow[];
  prices: RawPriceRow[]; // latest close per tracked symbol -- "everything we're tracking"
  refreshLog: RefreshLogRow[]; // recent pipeline runs -- proof it's actually live
  rotation: RotationStrengthRow[]; // daily rotation-strength series, oldest first
  setups: TradeSetupRow[]; // current candidate longs with entry/stop/targets
}

// PostgREST serializes `numeric` columns as JSON numbers, but be defensive: a
// view column that arrives as a string would otherwise blow up `.toFixed()`.
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
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
 * Server-side fetch of everything the terminal needs for first paint.
 * Falls back to the bundled demo dataset whenever Supabase isn't configured
 * yet, or a query errors -- the UI marks the difference with a DEMO badge.
 */
export async function getTerminalData(): Promise<TerminalData> {
  const demoFallback: TerminalData = {
    isLive: false,
    asOf: DEMO_AS_OF,
    snapshot: demoSnapshot,
    history: demoHistory,
    sectors: demoSectors,
    curves: demoCurves,
    stats: demoStats,
    prices: demoPrices,
    refreshLog: demoRefreshLog,
    rotation: demoRotation,
    setups: demoSetups,
  };

  if (!hasSupabase || !supabase) {
    return demoFallback;
  }

  try {
    const [snapRes, histRes, secRes, curveRes, statRes, priceRes, logRes, rotRes, setupRes] =
      await Promise.all([
      supabase.from("regime_snapshot").select("*").order("index_symbol"),
      supabase.from("regime_history").select("*").order("d"),
      supabase.from("sector_rankings").select("*").order("rank"),
      supabase.from("backtest_curves").select("*").order("month"),
      supabase.from("backtest_stats").select("*"),
      supabase.from("latest_prices").select("*").order("symbol"),
      supabase.from("refresh_log").select("*").order("refreshed_at", { ascending: false }).limit(40),
      supabase.from("rotation_strength").select("*").order("d"),
      supabase.from("trade_setups").select("*").order("strength", { ascending: false }),
    ]);

    const anyError =
      snapRes.error || histRes.error || secRes.error || curveRes.error || statRes.error;
    if (anyError || !snapRes.data?.length) {
      // Table missing / empty (e.g. schema not applied yet) -- fall back rather than
      // render a blank terminal.
      return demoFallback;
    }

    return {
      isLive: true,
      asOf: snapRes.data[0]?.as_of ?? DEMO_AS_OF,
      snapshot: snapRes.data as RegimeSnapshotRow[],
      history: (histRes.data ?? []) as RegimeHistoryRow[],
      sectors: (secRes.data ?? []) as SectorRankingRow[],
      curves: (curveRes.data ?? []) as BacktestCurvePointRow[],
      stats: (statRes.data ?? []) as BacktestStatRow[],
      // These two are supplementary (tracked-instruments list, pipeline health) --
      // a hiccup fetching them shouldn't blank the whole terminal, so default to [].
      prices: ((priceRes.data ?? []) as Record<string, unknown>[]).map(normalizePrice),
      refreshLog: (logRes.data ?? []) as RefreshLogRow[],
      rotation: ((rotRes.data ?? []) as Record<string, unknown>[]).map(normalizeRotation),
      setups: ((setupRes.data ?? []) as Record<string, unknown>[]).map(normalizeSetup),
    };
  } catch {
    return demoFallback;
  }
}
