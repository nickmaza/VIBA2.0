import { NextResponse } from "next/server";
import { fundPositioning } from "@/lib/smartmoney/sec";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/smart-money/funds -> latest 13F adds / new positions / exits for the tracked funds. */
export async function GET() {
  try {
    const payload = await fundPositioning();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=43200, stale-while-revalidate=172800" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "13F data failed to load." }, { status: 500 });
  }
}
