import { NextResponse } from "next/server";
import { cleanSymbol, fetchIntraday, INTRADAY_INTERVALS, INTRADAY_RANGES } from "@/lib/market";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/intraday?symbol=NVDA&interval=5m[&range=5d] -> 1m-1h OHLCV with
 * pre/post-market, through the fetch-intraday edge function (Yahoo chart
 * endpoint, cached 30 s in Supabase while the market is open).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("symbol") ?? "";
  const symbol = raw.startsWith("^") ? "^" + cleanSymbol(raw.slice(1)) : cleanSymbol(raw);
  const interval = url.searchParams.get("interval") ?? "5m";
  const range = url.searchParams.get("range") ?? undefined;
  if (!symbol) return NextResponse.json({ error: "Enter a ticker symbol." }, { status: 400 });
  if (!(INTRADAY_INTERVALS as readonly string[]).includes(interval)) return NextResponse.json({ error: `Unsupported interval ${interval}.` }, { status: 400 });
  if (range && !(INTRADAY_RANGES as readonly string[]).includes(range)) return NextResponse.json({ error: `Unsupported range ${range}.` }, { status: 400 });
  const r = await fetchIntraday(symbol, interval, range);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r.result, { headers: { "Cache-Control": "public, s-maxage=20, stale-while-revalidate=60" } });
}
