import { NextResponse } from "next/server";
import { insiderActivity } from "@/lib/smartmoney/sec";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/smart-money/insiders?symbols=AMD,META -> open-market insider buys and sells (SEC Form 4, last 90 days). */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("symbols") ?? "";
  const symbols = Array.from(new Set(raw.split(",").map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "")).filter(Boolean))).slice(0, 10);
  if (!symbols.length) return NextResponse.json({ error: "Pass ?symbols=AAA,BBB" }, { status: 400 });
  const results = [];
  for (const s of symbols) {
    // sequential per symbol; each call already fans out a few Form 4 fetches
    results.push(await insiderActivity(s).catch((e) => ({ symbol: s, error: e instanceof Error ? e.message : "failed" })));
  }
  return NextResponse.json(
    { results },
    { headers: { "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400" } }
  );
}
