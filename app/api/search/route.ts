import { NextResponse } from "next/server";
import { searchSymbols } from "@/lib/market";

export const dynamic = "force-dynamic";

/** GET /api/search?q=costco -> up to 10 US stocks/ETFs matching a ticker or company name (Supabase search_symbols). */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 60);
  try {
    const results = await searchSymbols(q);
    return NextResponse.json(
      { results },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } }
    );
  } catch (e) {
    return NextResponse.json({ results: [], error: e instanceof Error ? e.message : "Search failed." }, { status: 502 });
  }
}
