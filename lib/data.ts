import { supabase, hasSupabase } from "./supabase";
import {
  demoHistory,
  demoSnapshot,
  demoSectors,
  demoCurves,
  demoStats,
  demoPrices,
  demoRefreshLog,
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
  };

  if (!hasSupabase || !supabase) {
    return demoFallback;
  }

  try {
    const [snapRes, histRes, secRes, curveRes, statRes, priceRes, logRes] = await Promise.all([
      supabase.from("regime_snapshot").select("*").order("index_symbol"),
      supabase.from("regime_history").select("*").order("d"),
      supabase.from("sector_rankings").select("*").order("rank"),
      supabase.from("backtest_curves").select("*").order("month"),
      supabase.from("backtest_stats").select("*"),
      supabase.from("latest_prices").select("*").order("symbol"),
      supabase.from("refresh_log").select("*").order("refreshed_at", { ascending: false }).limit(12),
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
      prices: (priceRes.data ?? []) as RawPriceRow[],
      refreshLog: (logRes.data ?? []) as RefreshLogRow[],
    };
  } catch {
    return demoFallback;
  }
}
