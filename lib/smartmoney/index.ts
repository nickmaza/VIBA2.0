// Smart money: where money is moving in the market and where the big,
// informed players are positioning. Assembles five kinds of evidence:
//
//   1. Money flow   -- accumulation / distribution from price and volume (live bars)
//   2. Rotation     -- relative strength + flow across sectors, size, bonds, gold, dollar, bitcoin
//   3. Risk appetite-- ratio pairs (junk vs Treasuries, discretionary vs staples, ...)
//   4. Options      -- call vs put premium and volume vs normal (smart_money_feed / snapshot)
//   5. Congress     -- disclosed STOCK Act trades (smart_money_feed / snapshot)
// Insider buying (SEC Form 4) and fund 13F changes load separately from
// lib/smartmoney/sec.ts because they are slower to fetch.
//
// Everything here is descriptive: it shows where volume and positioning are
// leaning, not what prices will do next.
import { getBars, type BarsResult } from "@/lib/market";
import { analyze, isAnalysis, type Analysis } from "@/lib/ta";
import { supabase, hasSupabase } from "@/lib/supabase";
import { moneyFlow, ratioChange, type Flow } from "./flow";
import { FLOW_ASSETS, RISK_PAIRS } from "./universe";
import snapshot from "./snapshot.json";

// ---------- feed (options + congress), refreshed by the scheduled Robinhood task ----------
export interface OptionsRow {
  symbol: string;
  name: string;
  callPremium: number;
  putPremium: number;
  callVol: number;
  putVol: number;
  callVolAvg10: number;
  putVolAvg10: number;
  callOI: number;
  putOI: number;
  callOIAvg10: number;
  putOIAvg10: number;
  marketCap: number | null;
  last: number | null;
}

export interface CongressTrade {
  politician: string;
  party: string;
  side: "BUY" | "SELL";
  amount: string; // disclosed range
  traded: string;
  disclosed: string;
}

export interface CongressSummary {
  symbol: string;
  buys: number;
  sells: number;
  trades: CongressTrade[];
}

export interface Feed {
  asOf: string;
  options: OptionsRow[];
  congress: CongressSummary[];
  congressWindowDays: number;
}

export async function getFeed(): Promise<Feed & { source: "supabase" | "snapshot" }> {
  const snap = snapshot as unknown as Feed;
  if (hasSupabase && supabase) {
    try {
      const { data } = await supabase.from("smart_money_feed").select("kind,as_of,payload");
      const rows = (data ?? []) as { kind: string; as_of: string; payload: unknown }[];
      const opt = rows.find((r) => r.kind === "options");
      const con = rows.find((r) => r.kind === "congress");
      if (opt && Array.isArray(opt.payload)) {
        return {
          asOf: String(opt.as_of),
          options: opt.payload as OptionsRow[],
          congress: con && Array.isArray(con.payload) ? (con.payload as CongressSummary[]) : snap.congress,
          congressWindowDays: snap.congressWindowDays,
          source: "supabase",
        };
      }
    } catch {
      /* fall through to the bundled snapshot */
    }
  }
  return { ...snap, source: "snapshot" };
}

// ---------- options read ----------
export interface OptionsRead {
  skew: number; // call premium / put premium
  callVolRatio: number; // today's call volume / 10-day average
  putVolRatio: number;
  pcVolume: number; // put volume / call volume
  callOIChange: number; // call OI vs 10-day average, %
  score: number; // 0..100
  label: string;
}

export function readOptions(o: OptionsRow): OptionsRead {
  const skew = o.putPremium > 0 ? o.callPremium / o.putPremium : 5;
  const callVolRatio = o.callVolAvg10 > 0 ? o.callVol / o.callVolAvg10 : 1;
  const putVolRatio = o.putVolAvg10 > 0 ? o.putVol / o.putVolAvg10 : 1;
  const pcVolume = o.callVol > 0 ? o.putVol / o.callVol : 1;
  const callOIChange = o.callOIAvg10 > 0 ? (o.callOI / o.callOIAvg10 - 1) * 100 : 0;
  const clampLog = (x: number) => Math.log(Math.max(0.2, Math.min(8, x)));
  const z =
    0.45 * clampLog(skew) +
    0.3 * clampLog(callVolRatio) -
    0.2 * Math.max(0, clampLog(putVolRatio)) +
    0.01 * Math.max(-25, Math.min(25, callOIChange));
  const score = Math.round(50 + 50 * Math.tanh(z));
  const label =
    score >= 75 ? "Heavy call buying" : score >= 60 ? "Bullish tilt" : score > 40 ? "Balanced" : score > 25 ? "Bearish tilt" : "Heavy put buying";
  return { skew, callVolRatio, putVolRatio, pcVolume, callOIChange, score, label };
}

// ---------- payload ----------
export type Quadrant = "Leading" | "Improving" | "Weakening" | "Lagging";

export interface AssetFlow {
  symbol: string;
  name: string;
  group: string;
  flow: Flow;
  rs1m: number | null; // % vs SPY
  rs3m: number | null;
  quadrant: Quadrant | null;
}

export interface RiskPairRead {
  label: string;
  pair: string;
  change: number | null; // ratio % change over 20 sessions
  riskOn: boolean | null;
  read: string;
}

export interface SlimAnalysis {
  ind: Analysis["ind"];
  levels: Analysis["levels"];
  setups: Analysis["setups"];
  primary: Analysis["primary"];
  trend: Analysis["trend"];
  narrative: string[];
  noSetup: string | null;
}

export interface Evidence {
  kind: "flow" | "options" | "strength" | "congress" | "trend";
  label: string;
  detail: string;
  state: "ok" | "pending" | "fail";
}

export interface SmartMoneyPlay {
  symbol: string;
  name: string;
  score: number;
  flow: Flow;
  options: OptionsRead | null;
  optionsRow: OptionsRow | null;
  congress: CongressSummary | null;
  rs3m: number | null;
  evidence: Evidence[];
  thesis: string;
  analysis: SlimAnalysis | null;
  source: string;
  closes: number[];
}

export interface StockFlowRow {
  symbol: string;
  name: string;
  flow: Flow;
  options: OptionsRead | null;
  callPremium: number | null;
  putPremium: number | null;
  score: number;
}

export interface SmartMoneyPayload {
  generatedAt: string;
  barsAsOf: string;
  feedAsOf: string;
  feedSource: "supabase" | "snapshot";
  headline: string[];
  assets: AssetFlow[];
  riskPairs: RiskPairRead[];
  riskOnCount: number;
  riskRead: string;
  optionsMarket: { callPremium: number; putPremium: number; ratio: number; names: number };
  optionsLeaders: { symbol: string; name: string; read: OptionsRead; callPremium: number; putPremium: number }[];
  putHeavy: { symbol: string; name: string; read: OptionsRead; callPremium: number; putPremium: number }[];
  stockFlows: StockFlowRow[];
  plays: SmartMoneyPlay[];
  congress: CongressSummary[];
  congressWindowDays: number;
  sources: Record<string, string>;
}

function slim(a: Analysis): SlimAnalysis {
  return { ind: a.ind, levels: a.levels, setups: a.setups, primary: a.primary, trend: a.trend, narrative: a.narrative, noSetup: a.noSetup };
}

function quadrant(rs1m: number | null, rs3m: number | null): Quadrant | null {
  if (rs1m === null || rs3m === null) return null;
  if (rs3m >= 0 && rs1m >= 0) return "Leading";
  if (rs3m < 0 && rs1m >= 0) return "Improving";
  if (rs3m >= 0 && rs1m < 0) return "Weakening";
  return "Lagging";
}

const fmtMoney = (x: number) =>
  x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(0)}M` : `$${Math.round(x).toLocaleString("en-US")}`;
const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

async function barsFor(symbols: string[]): Promise<Map<string, BarsResult | null>> {
  const uniq = Array.from(new Set(symbols));
  const out = new Map<string, BarsResult | null>();
  // modest concurrency so the upstream providers don't throttle us
  const queue = [...uniq];
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift() as string;
      out.set(s, await getBars(s).catch(() => null));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

export async function getSmartMoney(): Promise<SmartMoneyPayload> {
  const feed = await getFeed();
  const optBy = new Map(feed.options.map((o) => [o.symbol, o]));
  const conBy = new Map(feed.congress.map((c) => [c.symbol, c]));

  // Candidate stocks: the names with the most options money today, plus any with congress activity.
  const candidates = feed.options
    .filter((o) => o.callPremium + o.putPremium >= 10e6)
    .sort((a, b) => b.callPremium + b.putPremium - (a.callPremium + a.putPremium))
    .slice(0, 45)
    .map((o) => o.symbol);
  for (const c of feed.congress) if (!candidates.includes(c.symbol)) candidates.push(c.symbol);

  const bars = await barsFor(["SPY", ...FLOW_ASSETS.map((a) => a.symbol), ...candidates]);
  const spy = bars.get("SPY")?.bars ?? null;
  const spyFlow = spy ? moneyFlow(spy) : null;
  const rsOf = (f: Flow | null) => ({
    rs1m: f && f.r1m !== null && spyFlow?.r1m != null ? f.r1m - spyFlow.r1m : null,
    rs3m: f && f.r3m !== null && spyFlow?.r3m != null ? f.r3m - spyFlow.r3m : null,
  });

  // 1-2. asset flows + rotation quadrants
  const assets: AssetFlow[] = [];
  for (const a of FLOW_ASSETS) {
    const b = bars.get(a.symbol)?.bars;
    const f = b ? moneyFlow(b) : null;
    if (!f) continue;
    const { rs1m, rs3m } = rsOf(f);
    assets.push({ ...a, flow: f, rs1m, rs3m, quadrant: quadrant(rs1m, rs3m) });
  }

  // 3. risk appetite
  const riskPairs: RiskPairRead[] = RISK_PAIRS.map((p) => {
    const A = bars.get(p.a)?.bars, B = bars.get(p.b)?.bars;
    const ch = A && B ? ratioChange(A, B, 20) : null;
    const on = ch === null ? null : ch > 0;
    return {
      label: p.label,
      pair: `${p.a}/${p.b}`,
      change: ch,
      riskOn: on,
      read: ch === null ? "No data" : on ? `Rising: ${p.riskOn}` : `Falling: ${p.riskOff}`,
    };
  });
  const known = riskPairs.filter((r) => r.riskOn !== null);
  const riskOnCount = known.filter((r) => r.riskOn).length;
  const riskRead =
    known.length === 0
      ? "Not enough data."
      : riskOnCount >= Math.ceil(known.length * 0.7)
      ? "Risk-on: money is choosing the riskier side of most pairs."
      : riskOnCount <= Math.floor(known.length * 0.3)
      ? "Risk-off: money is hiding in the defensive side of most pairs."
      : "Mixed: money is rotating, not committing to risk-on or risk-off.";

  // 4. options, market level
  const totalCall = feed.options.reduce((s, o) => s + o.callPremium, 0);
  const totalPut = feed.options.reduce((s, o) => s + o.putPremium, 0);
  const withRead = feed.options.map((o) => ({ symbol: o.symbol, name: o.name, read: readOptions(o), callPremium: o.callPremium, putPremium: o.putPremium }));
  const optionsLeaders = withRead
    .filter((x) => x.callPremium >= 20e6)
    .sort((a, b) => b.read.score - a.read.score || b.callPremium - a.callPremium)
    .slice(0, 12);
  const putHeavy = withRead
    .filter((x) => x.putPremium >= 15e6 && x.putPremium > x.callPremium)
    .sort((a, b) => b.putPremium / b.callPremium - a.putPremium / a.callPremium)
    .slice(0, 8);

  // 5. stock-level flows and plays
  const stockFlows: StockFlowRow[] = [];
  const plays: SmartMoneyPlay[] = [];
  for (const s of candidates) {
    const r = bars.get(s);
    if (!r) continue;
    const f = moneyFlow(r.bars);
    if (!f) continue;
    const o = optBy.get(s) ?? null;
    const oRead = o ? readOptions(o) : null;
    const con = conBy.get(s) ?? null;
    const { rs3m } = rsOf(f);
    const conNet = con ? con.buys - con.sells : 0;
    const rsScore = rs3m === null ? 50 : 50 + 50 * Math.tanh(rs3m / 20);
    const score = Math.round(0.45 * f.score + 0.35 * (oRead?.score ?? 50) + 0.15 * rsScore + 5 * Math.tanh(conNet / 3));
    const name = r.name ?? o?.name ?? s;
    stockFlows.push({ symbol: s, name, flow: f, options: oRead, callPremium: o?.callPremium ?? null, putPremium: o?.putPremium ?? null, score });

    const trendOk = f.above50 && f.above200 !== false;
    // institutional-size names only: at least $20B market cap where the feed knows it
    const bigEnough = (o?.marketCap ?? 0) >= 20e9 || f.dollarVol20 >= 1e9;
    if (f.score < 57 || (oRead?.score ?? 0) < 57 || !trendOk || !bigEnough) continue;
    const a = analyze(r.bars);
    const evidence: Evidence[] = [
      {
        kind: "flow",
        label: `Money flow: ${f.label}`,
        detail: `Chaikin money flow ${f.cmf >= 0 ? "+" : ""}${f.cmf.toFixed(2)}, up-day volume ${f.upDownVol.toFixed(1)}× down-day volume, ${f.accDays} accumulation vs ${f.distDays} distribution days in 5 weeks.`,
        state: f.score >= 57 ? "ok" : "pending",
      },
      {
        kind: "options",
        label: `Options: ${oRead ? oRead.label : "no data"}`,
        detail: o && oRead
          ? `${fmtMoney(o.callPremium)} of calls vs ${fmtMoney(o.putPremium)} of puts traded (${oRead.skew.toFixed(1)}×); call volume ${oRead.callVolRatio.toFixed(1)}× its 10-day average; call open interest ${pct(oRead.callOIChange, 0)} vs 10-day average.`
          : "No options snapshot for this name.",
        state: oRead && oRead.score >= 60 ? "ok" : "pending",
      },
      {
        kind: "strength",
        label: `Relative strength: ${rs3m === null ? "n/a" : pct(rs3m) + " vs SPY (3 months)"}`,
        detail: rs3m === null ? "Not enough history." : rs3m >= 0 ? "Outperforming the market, so the flow is going into a leader." : "Lagging the market; the flow may be early positioning into a laggard.",
        state: rs3m !== null && rs3m >= 0 ? "ok" : "pending",
      },
      {
        kind: "trend",
        label: `Trend: ${f.above200 === null ? "above 50-day" : "above 50- and 200-day averages"}`,
        detail: `1-month ${f.r1m === null ? "n/a" : pct(f.r1m)}, 3-month ${f.r3m === null ? "n/a" : pct(f.r3m)}.`,
        state: "ok",
      },
    ];
    if (con && con.buys + con.sells > 0) {
      evidence.push({
        kind: "congress",
        label: `Congress: ${con.buys} buy${con.buys === 1 ? "" : "s"} / ${con.sells} sell${con.sells === 1 ? "" : "s"} disclosed`,
        detail: `Last ${feed.congressWindowDays} days of STOCK Act disclosures (amounts are ranges; disclosures lag trades by up to 45 days).`,
        state: con.buys > con.sells ? "ok" : con.buys === con.sells ? "pending" : "fail",
      });
    }
    const thesis =
      `${name} is drawing ${f.label.toLowerCase()} on volume` +
      (o && oRead ? ` while options traders put ${fmtMoney(o.callPremium)} into calls, ${oRead.skew.toFixed(1)}× the put premium` : "") +
      `. ` +
      (rs3m !== null ? `It is ${rs3m >= 0 ? "outperforming" : "trailing"} the S&P 500 by ${Math.abs(rs3m).toFixed(1)} points over 3 months. ` : "") +
      (con && con.buys > con.sells ? `Congressional disclosures lean to buying (${con.buys} buys vs ${con.sells} sells). ` : "") +
      `When volume, options positioning and trend line up like this, large buyers are usually building a position rather than trading in and out.`;
    plays.push({
      symbol: s,
      name,
      score,
      flow: f,
      options: oRead,
      optionsRow: o,
      congress: con,
      rs3m,
      evidence,
      thesis,
      analysis: isAnalysis(a) ? slim(a) : null,
      source: r.source,
      closes: r.bars.c.slice(-126),
    });
  }
  plays.sort((a, b) => b.score - a.score);
  stockFlows.sort((a, b) => b.score - a.score);

  // headline
  const byFlow = [...assets].sort((a, b) => b.flow.score - a.flow.score);
  const inflow = byFlow.filter((a) => a.flow.score >= 57).slice(0, 3);
  const outflow = byFlow.filter((a) => a.flow.score <= 43).slice(-3).reverse();
  const leading = assets.filter((a) => a.quadrant === "Leading" && a.flow.score >= 50).map((a) => a.name);
  const headline: string[] = [];
  headline.push(
    inflow.length
      ? `Money is flowing into ${inflow.map((a) => `${a.name} (${a.symbol})`).join(", ")}.`
      : "No sector or asset class is showing clear accumulation right now."
  );
  if (outflow.length) headline.push(`It is leaving ${outflow.map((a) => `${a.name} (${a.symbol})`).join(", ")}.`);
  headline.push(riskRead);
  if (totalPut > 0)
    headline.push(
      `Options: ${fmtMoney(totalCall)} of call premium vs ${fmtMoney(totalPut)} of puts across the ${feed.options.length} most active large caps (${(totalCall / totalPut).toFixed(1)}× calls).`
    );
  if (leading.length) headline.push(`Leading and still attracting flow: ${leading.slice(0, 5).join(", ")}.`);

  const barsAsOf = spy ? spy.t[spy.t.length - 1] : feed.asOf;
  const spySource = bars.get("SPY")?.source ?? "snapshot";
  return {
    generatedAt: new Date().toISOString(),
    barsAsOf,
    feedAsOf: feed.asOf,
    feedSource: feed.source,
    headline,
    assets,
    riskPairs,
    riskOnCount,
    riskRead,
    optionsMarket: { callPremium: totalCall, putPremium: totalPut, ratio: totalPut > 0 ? totalCall / totalPut : 0, names: feed.options.length },
    optionsLeaders,
    putHeavy,
    stockFlows: stockFlows.slice(0, 30),
    plays: plays.slice(0, 6),
    congress: feed.congress,
    congressWindowDays: feed.congressWindowDays,
    sources: {
      bars: spySource,
      options: feed.source === "supabase" ? "Supabase smart_money_feed (Robinhood options data)" : `Bundled snapshot, ${feed.asOf} close (Robinhood options data)`,
      congress: "Tip Ranks STOCK Act disclosures via Robinhood",
    },
  };
}
