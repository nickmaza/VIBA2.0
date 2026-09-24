import { NextResponse } from "next/server";
import { getBars, cleanSymbol } from "@/lib/market";

export const dynamic = "force-dynamic";

/** GET /api/bars?symbol=NVDA -> two years of daily OHLCV plus where it came from. */
export async function GET(req: Request) {
  const symbol = cleanSymbol(new URL(req.url).searchParams.get("symbol") ?? "");
  if (!symbol) return NextResponse.json({ error: "Enter a ticker symbol." }, { status: 400 });
  const result = await getBars(symbol);
  if (!result) {
    return NextResponse.json(
      { error: `No daily price history found for ${symbol}. Check the ticker, or search by company name.` },
      { status: 404 }
    );
  }
  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800" },
  });
}
