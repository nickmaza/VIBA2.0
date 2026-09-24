import { NextResponse } from "next/server";
import { searchSymbols } from "@/lib/market";

export const dynamic = "force-dynamic";

/** GET /api/search?q=costco -> up to 10 US stocks/ETFs matching a ticker or company name. */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 60);
  const results = await searchSymbols(q);
  return NextResponse.json(
    { results },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } }
  );
}
