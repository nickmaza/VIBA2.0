// The VIBA stock plays. They are picked and written up inside Supabase by the
// compute-plays edge function (every 30 minutes in the session, and again
// after the evening library sync) and read from the stock_plays table:
//   * sectors are ranked by risk-adjusted momentum (compute-sector-rotation)
//   * inside the top 3 sectors, library stocks above their 50- and 200-day
//     averages that trade at least $50M a day are ranked by the average of
//     their 3/6/12-month returns divided by 63-day volatility
//   * the top two per sector are plays; the next name per sector is on watch
// The written case comes from each stock's own numbers. The technical setup
// on each card (entry / stop / targets and the checklist) is recomputed on the
// page from the latest bars by lib/ta.ts.
//
// Rule: no index products as plays (SPY, QQQ, IWM, DIA or their leveraged
// versions). The screen only considers single stocks.
import { supabase } from "./supabase";

export interface Play {
  symbol: string;
  name: string;
  kind: "stock";
  sector: string; // "Technology · Semiconductors"
  sectorEtf: string;
  sectorRank: number | null;
  score: number; // average 3/6/12-month return per unit of 63-day volatility
  vol: number; // 63-day annualized volatility, percent
  r3m: number | null;
  r6m: number | null;
  r12m: number | null;
  marketCap: number | null;
  thesis: string;
  chartRead: string;
  risk: string;
  asOf: string; // session the case was written from
}

export interface WatchItem {
  symbol: string;
  name: string;
  kind: "stock";
  note: string;
  score: number;
  asOf: string;
}

export interface PlaysData {
  asOf: string | null; // latest session behind the plays
  generatedAt: string | null; // when compute-plays last ran
  plays: Play[];
  watchlist: WatchItem[];
  error: string | null;
}

export const EXCLUDED_INDEX_PRODUCTS = ["SPY", "QQQ", "IWM", "DIA", "TQQQ", "UPRO", "SPXL", "SSO", "QLD", "TNA", "UDOW"];

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

export async function getPlays(): Promise<PlaysData> {
  const { data, error } = await supabase.from("stock_plays").select("*").order("rank");
  if (error) return { asOf: null, generatedAt: null, plays: [], watchlist: [], error: `stock_plays: ${error.message}` };
  const rows = (data ?? []) as Record<string, unknown>[];
  const plays: Play[] = [];
  const watchlist: WatchItem[] = [];
  let asOf: string | null = null;
  let generatedAt: string | null = null;
  for (const r of rows) {
    const d = String(r.as_of ?? "");
    if (d && (!asOf || d > asOf)) asOf = d;
    const g = r.generated_at ? String(r.generated_at) : null;
    if (g && (!generatedAt || g > generatedAt)) generatedAt = g;
    if (r.list === "watch") {
      watchlist.push({
        symbol: String(r.symbol),
        name: String(r.name ?? r.symbol),
        kind: "stock",
        note: String(r.note ?? ""),
        score: n(r.score) ?? 0,
        asOf: d,
      });
    } else {
      plays.push({
        symbol: String(r.symbol),
        name: String(r.name ?? r.symbol),
        kind: "stock",
        sector: String(r.sector ?? ""),
        sectorEtf: String(r.sector_etf ?? ""),
        sectorRank: n(r.sector_rank),
        score: n(r.score) ?? 0,
        vol: n(r.vol) ?? 0,
        r3m: n(r.r3m),
        r6m: n(r.r6m),
        r12m: n(r.r12m),
        marketCap: n(r.market_cap),
        thesis: String(r.thesis ?? ""),
        chartRead: String(r.chart_read ?? ""),
        risk: String(r.risk ?? ""),
        asOf: d,
      });
    }
  }
  return { asOf, generatedAt, plays, watchlist, error: null };
}
