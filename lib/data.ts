import { supabase, hasSupabase } from "./supabase";
import {
  demoHistory,
  demoSnapshot,
  demoSectors,
  demoCurves,
  demoStats,
  DEMO_AS_OF,
} from "./demo-data";
import type {
  RegimeHistoryRow,
  RegimeSnapshotRow,
  SectorRankingRow,
  BacktestCurvePointRow,
  BacktestStatRow,
} from "./types";

export interface TerminalData {
  isLive: boolean;
  asOf: string;
  snapshot: RegimeSnapshotRow[];
  history: RegimeHistoryRow[];
  sectors: SectorRankingRow[];
  curves: BacktestCurvePointRow[];
  stats: BacktestStatRow[];
}

/**
 * Server-side fetch of everything the terminal needs for first paint.
 * Falls back to the bundled demo dataset whenever Supabase isn't configured
 * yet, or a query errors -- the UI marks the difference with a DEMO badge.
 */
export async function getTerminalData(): Promise<TerminalData> {
  if (!hasSupabase || !supabase) {
    return {
      isLive: false,
      asOf: DEMO_AS_OF,
      snapshot: demoSnapshot,
      history: demoHistory,
      sectors: demoSectors,
      curves: demoCurves,
      stats: demoStats,
    };
  }

  try {
    const [snapRes, histRes, secRes, curveRes, statRes] = await Promise.all([
      supabase.from("regime_snapshot").select("*").order("index_symbol"),
      supabase.from("regime_history").select("*").order("d"),
      supabase.from("sector_rankings").select("*").order("rank"),
      supabase.from("backtest_curves").select("*").order("month"),
      supabase.from("backtest_stats").select("*"),
    ]);

    const anyError =
      snapRes.error || histRes.error || secRes.error || curveRes.error || statRes.error;
    if (anyError || !snapRes.data?.length) {
      // Table missing / empty (e.g. schema not applied yet) -- fall back rather than
      // render a blank terminal.
      return {
        isLive: false,
        asOf: DEMO_AS_OF,
        snapshot: demoSnapshot,
        history: demoHistory,
        sectors: demoSectors,
        curves: demoCurves,
        stats: demoStats,
      };
    }

    return {
      isLive: true,
      asOf: snapRes.data[0]?.as_of ?? DEMO_AS_OF,
      snapshot: snapRes.data as RegimeSnapshotRow[],
      history: (histRes.data ?? []) as RegimeHistoryRow[],
      sectors: (secRes.data ?? []) as SectorRankingRow[],
      curves: (curveRes.data ?? []) as BacktestCurvePointRow[],
      stats: (statRes.data ?? []) as BacktestStatRow[],
    };
  } catch {
    return {
      isLive: false,
      asOf: DEMO_AS_OF,
      snapshot: demoSnapshot,
      history: demoHistory,
      sectors: demoSectors,
      curves: demoCurves,
      stats: demoStats,
    };
  }
}
