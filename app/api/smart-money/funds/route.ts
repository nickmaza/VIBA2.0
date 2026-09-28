import { NextResponse } from "next/server";
import { fundPositioning } from "@/lib/smartmoney/sec";

export const dynamic = "force-dynamic";

/** GET /api/smart-money/funds -> latest 13F adds / new positions / exits for the tracked funds (Supabase, sync-13f). */
export async function GET() {
  try {
    const payload = await fundPositioning();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=86400" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "13F data failed to load." }, { status: 500 });
  }
}
