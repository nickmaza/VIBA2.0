import { NextResponse } from "next/server";
import { insiderActivity } from "@/lib/smartmoney/sec";

export const dynamic = "force-dynamic";

/** GET /api/smart-money/insiders?symbols=AMD,META -> open-market insider buys and sells (SEC Form 4, last 90 days) from Supabase. */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("symbols") ?? "";
  const symbols = Array.from(
    new Set(raw.split(",").map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "")).filter(Boolean))
  ).slice(0, 20);
  if (!symbols.length) return NextResponse.json({ error: "Pass ?symbols=AAA,BBB" }, { status: 400 });
  try {
    const payload = await insiderActivity(symbols);
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Insider data failed to load." }, { status: 500 });
  }
}
