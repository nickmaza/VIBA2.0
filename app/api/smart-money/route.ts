import { NextResponse } from "next/server";
import { getSmartMoney } from "@/lib/smartmoney";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/smart-money -> flows, rotation, risk appetite, options, congress and smart money plays. */
export async function GET() {
  try {
    const payload = await getSmartMoney();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Smart money data failed to load." }, { status: 500 });
  }
}
