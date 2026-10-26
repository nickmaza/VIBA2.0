// Today's real numbers for the landing page, read from the same Supabase
// tables the terminal uses. Every loader fails soft: a missing number hides
// its sentence instead of breaking the page.
import { supabase } from "./supabase";
import { getPlays } from "./plays";
import { getPredictive } from "./predictive";

export interface RegimePoint {
  d: string;
  v: number;
}

export interface LandingData {
  regime: RegimePoint[]; // SPY composite, ~2 years of sessions
  spy: { score: number; bucket: string; asOf: string } | null;
  sectors: { ticker: string; name: string }[]; // top 3 by risk-adjusted momentum
  plays: { symbol: string; name: string }[];
  predictive: { tailwinds: number; headwinds: number; tracked: number } | null;
  smartMoney: { symbol: string }[];
  newsToday: number | null;
  quotesLive: number | null;
}

const n = (x: unknown) => {
  const v = typeof x === "number" ? x : Number(x);
  return Number.isFinite(v) ? v : null;
};

async function safe<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f();
  } catch {
    return fallback;
  }
}

export async function getLandingData(): Promise<LandingData> {
  const since = new Date(Date.now() - 2 * 366 * 864e5).toISOString().slice(0, 10);
  const startOfDay = new Date(Date.now() - 24 * 3600e3).toISOString();

  const [regime, spy, sectors, plays, predictive, smart, newsToday, quotesLive] = await Promise.all([
    safe(async () => {
      const { data } = await supabase.from("regime_history").select("d,spy").gte("d", since).order("d").limit(1000);
      return ((data ?? []) as { d: string; spy: unknown }[])
        .map((r) => ({ d: String(r.d), v: n(r.spy) }))
        .filter((r): r is RegimePoint => r.v !== null);
    }, [] as RegimePoint[]),
    safe(async () => {
      const { data } = await supabase.from("regime_snapshot").select("score,bucket,as_of").eq("index_symbol", "SPY").maybeSingle();
      const r = data as { score: unknown; bucket: string; as_of: string } | null;
      return r && n(r.score) !== null ? { score: n(r.score) as number, bucket: r.bucket, asOf: r.as_of } : null;
    }, null),
    safe(async () => {
      const { data } = await supabase.from("sector_rankings").select("ticker,name,rank").order("rank").limit(3);
      return ((data ?? []) as { ticker: string; name: string }[]).map((r) => ({ ticker: r.ticker, name: r.name }));
    }, [] as { ticker: string; name: string }[]),
    safe(async () => (await getPlays()).plays.map((p) => ({ symbol: p.symbol, name: p.name })), [] as { symbol: string; name: string }[]),
    safe(async () => {
      const p = await getPredictive();
      return {
        tailwinds: p.plays.filter((x) => x.signal === "tailwind").length,
        headwinds: p.plays.filter((x) => x.signal === "headwind").length,
        tracked: p.plays.length,
      };
    }, null),
    safe(async () => {
      const { data } = await supabase.from("smart_money_reports").select("payload").eq("kind", "smart_money").maybeSingle();
      const plays = ((data as { payload?: { plays?: { symbol?: string }[] } } | null)?.payload?.plays ?? []).slice(0, 4);
      return plays.filter((p) => p.symbol).map((p) => ({ symbol: String(p.symbol) }));
    }, [] as { symbol: string }[]),
    safe(async () => {
      const { count } = await supabase.from("news_items").select("uuid", { count: "exact", head: true }).gte("published_at", startOfDay);
      return count ?? null;
    }, null),
    safe(async () => {
      const { count } = await supabase.from("live_quotes").select("symbol", { count: "exact", head: true });
      return count ?? null;
    }, null),
  ]);

  return { regime, spy, sectors, plays, predictive, smartMoney: smart, newsToday, quotesLive };
}
