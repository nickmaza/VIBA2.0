import { NextResponse } from "next/server";
import { cleanSymbol, fetchBars } from "@/lib/market";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/bars?symbol=NVDA -> two years of daily OHLCV from Supabase
 * (raw_prices), through the fetch-bars edge function, which refreshes a stale
 * symbol from the market before answering.
 */
export async function GET(req: Request) {
  const symbol = cleanSymbol(new URL(req.url).searchParams.get("symbol") ?? "");
  if (!symbol) return NextResponse.json({ error: "Enter a ticker symbol." }, { status: 400 });
  const r = await fetchBars(symbol);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r.result, {
    headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=600" },
  });
}
