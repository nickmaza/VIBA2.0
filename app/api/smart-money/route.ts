import { NextResponse } from "next/server";
import { getSmartMoney } from "@/lib/smartmoney";

export const dynamic = "force-dynamic";

/** GET /api/smart-money -> the latest smart money report computed in Supabase (compute-smart-money). */
export async function GET() {
  try {
    const payload = await getSmartMoney();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Smart money data failed to load." }, { status: 500 });
  }
}
