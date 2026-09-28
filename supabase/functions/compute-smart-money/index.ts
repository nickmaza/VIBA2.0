// compute-smart-money
//
// Where money is moving and where informed players are positioning, computed
// from the real datasets the other functions keep in Supabase:
//   1. Money flow    accumulation / distribution from daily price + volume (raw_prices)
//   2. Rotation      relative strength + flow across sectors, size, bonds, gold, dollar, bitcoin
//   3. Risk appetite ratio pairs (junk vs Treasuries, discretionary vs staples, ...)
//   4. Options       call vs put premium and volume vs normal (options_daily, CBOE)
//   5. Congress      disclosed STOCK Act trades (congress_trades, Senate eFD + House Clerk)
// plus Smart Money plays where volume, options and trend agree. The payload is
// stored in smart_money_reports('smart_money'); the app reads it as-is.
// Insider (Form 4) and 13F data live in their own tables and load separately.
//
// Everything here is descriptive: it shows where volume and positioning lean,
// not what prices will do next.
//
// Auth: x-refresh-secret. Called by pg_cron after the price/options syncs.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry } from "../_shared/common.ts";
import { analyze, isAnalysis, type Analysis, type Bars } from "../_shared/ta.ts";
import { moneyFlow, ratioChange, type Flow } from "../_shared/flow.ts";

const CONGRESS_WINDOW_DAYS = 90;

const FLOW_ASSETS: { symbol: string; name: string; group: string }[] = [
  { symbol: "XLK", name: "Technology", group: "Sectors" },
  { symbol: "XLF", name: "Financials", group: "Sectors" },
  { symbol: "XLE", name: "Energy", group: "Sectors" },
  { symbol: "XLV", name: "Health Care", group: "Sectors" },
  { symbol: "XLY", name: "Consumer Discretionary", group: "Sectors" },
  { symbol: "XLP", name: "Consumer Staples", group: "Sectors" },
  { symbol: "XLI", name: "Industrials", group: "Sectors" },
  { symbol: "XLB", name: "Materials", group: "Sectors" },
  { symbol: "XLU", name: "Utilities", group: "Sectors" },
  { symbol: "XLRE", name: "Real Estate", group: "Sectors" },
  { symbol: "XLC", name: "Communication Services", group: "Sectors" },
  { symbol: "SMH", name: "Semiconductors", group: "Industries" },
  { symbol: "KRE", name: "Regional Banks", group: "Industries" },
  { symbol: "XBI", name: "Biotech", group: "Industries" },
  { symbol: "ITB", name: "Homebuilders", group: "Industries" },
  { symbol: "QQQ", name: "Nasdaq-100 (growth)", group: "Size & style" },
  { symbol: "IWM", name: "Russell 2000 (small caps)", group: "Size & style" },
  { symbol: "RSP", name: "S&P 500 equal weight", group: "Size & style" },
  { symbol: "GLD", name: "Gold", group: "Macro & safe havens" },
  { symbol: "SLV", name: "Silver", group: "Macro & safe havens" },
  { symbol: "TLT", name: "Long Treasuries (20y+)", group: "Macro & safe havens" },
  { symbol: "IEF", name: "7-10y Treasuries", group: "Macro & safe havens" },
  { symbol: "HYG", name: "High-yield credit", group: "Macro & safe havens" },
  { symbol: "LQD", name: "Investment-grade credit", group: "Macro & safe havens" },
  { symbol: "UUP", name: "US dollar", group: "Macro & safe havens" },
  { symbol: "USO", name: "Crude oil", group: "Macro & safe havens" },
  { symbol: "IBIT", name: "Bitcoin", group: "Macro & safe havens" },
];

const RISK_PAIRS: { a: string; b: string; label: string; riskOn: string; riskOff: string }[] = [
  { a: "XLY", b: "XLP", label: "Discretionary vs Staples", riskOn: "consumers' wants over needs", riskOff: "defensive consumer names" },
  { a: "HYG", b: "IEF", label: "Junk bonds vs Treasuries", riskOn: "credit risk being bought", riskOff: "a flight to Treasuries" },
  { a: "IWM", b: "SPY", label: "Small caps vs S&P 500", riskOn: "broadening into small caps", riskOff: "a retreat to mega caps" },
  { a: "RSP", b: "SPY", label: "Equal weight vs cap weight", riskOn: "broad participation", riskOff: "narrow, top-heavy leadership" },
  { a: "SMH", b: "SPY", label: "Semis vs S&P 500", riskOn: "appetite for high-beta tech", riskOff: "semis lagging the market" },
  { a: "SPY", b: "TLT", label: "Stocks vs long bonds", riskOn: "equities over duration", riskOff: "bonds outperforming stocks" },
  { a: "SPY", b: "GLD", label: "Stocks vs gold", riskOn: "equities over hard assets", riskOff: "gold outperforming stocks" },
];

// ---------------- types (mirrored in the app's lib/smartmoney) ----------------
interface OptionsRow {
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
  histDays: number;
}
interface CongressTrade {
  politician: string;
  party: string;
  side: "BUY" | "SELL";
  amount: string;
  traded: string;
  disclosed: string;
  chamber: string;
  url: string | null;
}
interface CongressSummary {
  symbol: string;
  buys: number;
  sells: number;
  trades: CongressTrade[];
}
interface OptionsRead {
  skew: number;
  callVolRatio: number;
  putVolRatio: number;
  pcVolume: number;
  callOIChange: number;
  score: number;
  label: string;
}

function readOptions(o: OptionsRow): OptionsRead {
  const skew = o.putPremium > 0 ? o.callPremium / o.putPremium : 5;
  const callVolRatio = o.callVolAvg10 > 0 ? o.callVol / o.callVolAvg10 : 1;
  const putVolRatio = o.putVolAvg10 > 0 ? o.putVol / o.putVolAvg10 : 1;
  const pcVolume = o.callVol > 0 ? o.putVol / o.callVol : 1;
  const callOIChange = o.callOIAvg10 > 0 ? (o.callOI / o.callOIAvg10 - 1) * 100 : 0;
  const clampLog = (x: number) => Math.log(Math.max(0.2, Math.min(8, x)));
  const z = 0.45 * clampLog(skew) + 0.3 * clampLog(callVolRatio) - 0.2 * Math.max(0, clampLog(putVolRatio)) + 0.01 * Math.max(-25, Math.min(25, callOIChange));
  const score = Math.round(50 + 50 * Math.tanh(z));
  const label = score >= 75 ? "Heavy call buying" : score >= 60 ? "Bullish tilt" : score > 40 ? "Balanced" : score > 25 ? "Bearish tilt" : "Heavy put buying";
  return { skew, callVolRatio, putVolRatio, pcVolume, callOIChange, score, label };
}

type Quadrant = "Leading" | "Improving" | "Weakening" | "Lagging";
function quadrant(rs1m: number | null, rs3m: number | null): Quadrant | null {
  if (rs1m === null || rs3m === null) return null;
  if (rs3m >= 0 && rs1m >= 0) return "Leading";
  if (rs3m < 0 && rs1m >= 0) return "Improving";
  if (rs3m >= 0 && rs1m < 0) return "Weakening";
  return "Lagging";
}
function slim(a: Analysis) {
  return { ind: a.ind, levels: a.levels, setups: a.setups, primary: a.primary, trend: a.trend, narrative: a.narrative, noSetup: a.noSetup };
}
const fmtMoney = (x: number) =>
  x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(0)}M` : `$${Math.round(x).toLocaleString("en-US")}`;
const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

async function selectAll<T>(label: string, build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const out: T[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const rows = ((await withRetry(label, () => build(from, from + 999) as PromiseLike<{ data: T[] | null; error: { message: string } | null }>)) ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function loadBars(symbols: string[]): Promise<Map<string, Bars>> {
  const since = new Date(Date.now() - 800 * 86400e3).toISOString().slice(0, 10);
  const out = new Map<string, Bars>();
  const uniq = Array.from(new Set(symbols));
  for (let i = 0; i < uniq.length; i += 40) {
    const part = uniq.slice(i, i + 40);
    const j = (await withRetry("bars_json_many", () => sb.rpc("bars_json_many", { p_symbols: part, p_since: since }))) as Record<string, Bars> | null;
    for (const s of part) {
      const b = j?.[s];
      if (b && b.t?.length) out.set(s, { t: b.t, o: b.o.map(Number), h: b.h.map(Number), l: b.l.map(Number), c: b.c.map(Number), v: b.v.map(Number) });
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const t0 = Date.now();
  try {
    // ---------- library names / market caps ----------
    const meta = await selectAll<{ symbol: string; name: string; kind: string; market_cap: number | null }>("symbol_meta", (a, b) =>
      sb.from("symbol_meta").select("symbol,name,kind,market_cap").in("kind", ["stock", "adhoc"]).order("symbol").range(a, b)
    );
    const metaBy = new Map(meta.map((m) => [m.symbol, m]));
    const stockSet = new Set(meta.filter((m) => m.kind === "stock").map((m) => m.symbol));

    // ---------- options: latest session, library stocks ----------
    const optRows = await selectAll<Record<string, unknown>>("options_latest", (a, b) =>
      sb.from("options_latest").select("*").order("symbol").range(a, b)
    );
    const stockOpts = optRows.filter((r) => stockSet.has(String(r.symbol)));
    const session = stockOpts.reduce((m, r) => (String(r.d) > m ? String(r.d) : m), "");
    const n = (x: unknown) => (x === null || x === undefined ? 0 : Number(x));
    const options: OptionsRow[] = stockOpts
      .filter((r) => String(r.d) === session)
      .map((r) => {
        const s = String(r.symbol);
        const m = metaBy.get(s);
        return {
          symbol: s,
          name: m?.name ?? s,
          callPremium: n(r.call_premium),
          putPremium: n(r.put_premium),
          callVol: n(r.call_volume),
          putVol: n(r.put_volume),
          callVolAvg10: n(r.call_vol_avg10),
          putVolAvg10: n(r.put_vol_avg10),
          callOI: n(r.call_oi),
          putOI: n(r.put_oi),
          callOIAvg10: n(r.call_oi_avg10),
          putOIAvg10: n(r.put_oi_avg10),
          marketCap: m?.market_cap === null || m?.market_cap === undefined ? null : Number(m.market_cap),
          last: r.underlying === null ? null : n(r.underlying),
          histDays: n(r.hist_days),
        };
      });
    const optBy = new Map(options.map((o) => [o.symbol, o]));
    const histDays = options.length ? Math.round(options.reduce((s, o) => s + o.histDays, 0) / options.length) : 0;

    // ---------- congress: last 90 days of disclosures ----------
    const since = new Date(Date.now() - CONGRESS_WINDOW_DAYS * 86400e3).toISOString().slice(0, 10);
    const ctr = await selectAll<Record<string, unknown>>("congress_trades", (a, b) =>
      sb.from("congress_trades").select("symbol,politician,party,side,amount,traded,disclosed,chamber,source_url").gte("disclosed", since).order("disclosed", { ascending: false }).range(a, b)
    );
    const conMap = new Map<string, CongressSummary>();
    for (const t of ctr) {
      const s = String(t.symbol);
      const c = conMap.get(s) ?? { symbol: s, buys: 0, sells: 0, trades: [] };
      if (t.side === "BUY") c.buys++;
      else c.sells++;
      c.trades.push({
        politician: String(t.politician),
        party: String(t.party ?? ""),
        side: t.side as "BUY" | "SELL",
        amount: String(t.amount ?? ""),
        traded: String(t.traded ?? ""),
        disclosed: String(t.disclosed ?? ""),
        chamber: String(t.chamber ?? ""),
        url: t.source_url ? String(t.source_url) : null,
      });
      conMap.set(s, c);
    }
    const congress = Array.from(conMap.values()).sort((a, b) => b.trades.length - a.trades.length).slice(0, 80);
    const conBy = new Map(congress.map((c) => [c.symbol, c]));

    // ---------- candidates: most options money today + congress names in the library ----------
    const candidates = options
      .filter((o) => o.callPremium + o.putPremium >= 10e6)
      .sort((a, b) => b.callPremium + b.putPremium - (a.callPremium + a.putPremium))
      .slice(0, 45)
      .map((o) => o.symbol);
    for (const c of congress) if (stockSet.has(c.symbol) && !candidates.includes(c.symbol)) candidates.push(c.symbol);

    const bars = await loadBars(["SPY", ...FLOW_ASSETS.map((a) => a.symbol), ...candidates]);
    const spy = bars.get("SPY") ?? null;
    const spyFlow = spy ? moneyFlow(spy) : null;
    const rsOf = (f: Flow | null) => ({
      rs1m: f && f.r1m !== null && spyFlow?.r1m != null ? f.r1m - spyFlow.r1m : null,
      rs3m: f && f.r3m !== null && spyFlow?.r3m != null ? f.r3m - spyFlow.r3m : null,
    });

    // 1-2. asset flows + rotation quadrants
    const assets = [];
    for (const a of FLOW_ASSETS) {
      const b = bars.get(a.symbol);
      const f = b ? moneyFlow(b) : null;
      if (!f) continue;
      const { rs1m, rs3m } = rsOf(f);
      assets.push({ ...a, flow: f, rs1m, rs3m, quadrant: quadrant(rs1m, rs3m) });
    }

    // 3. risk appetite
    const riskPairs = RISK_PAIRS.map((p) => {
      const A = bars.get(p.a), B = bars.get(p.b);
      const ch = A && B ? ratioChange(A, B, 20) : null;
      const on = ch === null ? null : ch > 0;
      return { label: p.label, pair: `${p.a}/${p.b}`, change: ch, riskOn: on, read: ch === null ? "No data" : on ? `Rising: ${p.riskOn}` : `Falling: ${p.riskOff}` };
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
    const totalCall = options.reduce((s, o) => s + o.callPremium, 0);
    const totalPut = options.reduce((s, o) => s + o.putPremium, 0);
    const withRead = options.map((o) => ({ symbol: o.symbol, name: o.name, read: readOptions(o), callPremium: o.callPremium, putPremium: o.putPremium }));
    const optionsLeaders = withRead
      .filter((x) => x.callPremium >= 20e6)
      .sort((a, b) => b.read.score - a.read.score || b.callPremium - a.callPremium)
      .slice(0, 12);
    const putHeavy = withRead
      .filter((x) => x.putPremium >= 15e6 && x.putPremium > x.callPremium)
      .sort((a, b) => b.putPremium / b.callPremium - a.putPremium / a.callPremium)
      .slice(0, 8);

    // 5. stock-level flows and plays
    const stockFlows = [];
    const plays = [];
    for (const s of candidates) {
      const b = bars.get(s);
      if (!b) continue;
      const f = moneyFlow(b);
      if (!f) continue;
      const o = optBy.get(s) ?? null;
      const oRead = o ? readOptions(o) : null;
      const con = conBy.get(s) ?? null;
      const { rs3m } = rsOf(f);
      const conNet = con ? con.buys - con.sells : 0;
      const rsScore = rs3m === null ? 50 : 50 + 50 * Math.tanh(rs3m / 20);
      const score = Math.round(0.45 * f.score + 0.35 * (oRead?.score ?? 50) + 0.15 * rsScore + 5 * Math.tanh(conNet / 3));
      const name = metaBy.get(s)?.name ?? o?.name ?? s;
      stockFlows.push({ symbol: s, name, flow: f, options: oRead, callPremium: o?.callPremium ?? null, putPremium: o?.putPremium ?? null, score });

      const trendOk = f.above50 && f.above200 !== false;
      const bigEnough = (o?.marketCap ?? metaBy.get(s)?.market_cap ?? 0) >= 20e9 || f.dollarVol20 >= 1e9;
      if (f.score < 57 || (oRead?.score ?? 0) < 57 || !trendOk || !bigEnough) continue;
      const a = analyze(b);
      const avgNote = o && o.histDays >= 5 ? `call volume ${oRead!.callVolRatio.toFixed(1)}× its ${Math.min(10, o.histDays)}-session average; call open interest ${pct(oRead!.callOIChange, 0)} vs that average.` : `volume averages are still building (${o?.histDays ?? 0} prior sessions stored).`;
      const evidence = [
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
            ? `${fmtMoney(o.callPremium)} of calls vs ${fmtMoney(o.putPremium)} of puts traded on ${session} (${oRead.skew.toFixed(1)}×); ${avgNote}`
            : "No listed options activity for this name.",
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
          detail: `Last ${CONGRESS_WINDOW_DAYS} days of STOCK Act disclosures (amounts are ranges; disclosures lag trades by up to 45 days).`,
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
        source: "supabase",
        closes: b.c.slice(-126),
      });
    }
    plays.sort((a, b) => b.score - a.score);
    stockFlows.sort((a, b) => b.score - a.score);

    // ---------- headline ----------
    const byFlow = [...assets].sort((a, b) => b.flow.score - a.flow.score);
    const inflow = byFlow.filter((a) => a.flow.score >= 57).slice(0, 3);
    const outflow = byFlow.filter((a) => a.flow.score <= 43).slice(-3).reverse();
    const leading = assets.filter((a) => a.quadrant === "Leading" && a.flow.score >= 50).map((a) => a.name);
    const headline: string[] = [];
    headline.push(
      inflow.length ? `Money is flowing into ${inflow.map((a) => `${a.name} (${a.symbol})`).join(", ")}.` : "No sector or asset class is showing clear accumulation right now.",
    );
    if (outflow.length) headline.push(`It is leaving ${outflow.map((a) => `${a.name} (${a.symbol})`).join(", ")}.`);
    headline.push(riskRead);
    if (totalPut > 0)
      headline.push(
        `Options: ${fmtMoney(totalCall)} of call premium vs ${fmtMoney(totalPut)} of puts across ${options.length} optionable library stocks on ${session} (${(totalCall / totalPut).toFixed(1)}× calls).`,
      );
    if (leading.length) headline.push(`Leading and still attracting flow: ${leading.slice(0, 5).join(", ")}.`);

    const barsAsOf = spy ? spy.t[spy.t.length - 1] : "";
    const payload = {
      generatedAt: new Date().toISOString(),
      barsAsOf,
      feedAsOf: session || barsAsOf,
      feedSource: "supabase",
      optionsHistoryDays: histDays,
      headline,
      assets,
      riskPairs,
      riskOnCount,
      riskRead,
      optionsMarket: { callPremium: totalCall, putPremium: totalPut, ratio: totalPut > 0 ? totalCall / totalPut : 0, names: options.length },
      optionsLeaders,
      putHeavy,
      stockFlows: stockFlows.slice(0, 30),
      plays: plays.slice(0, 6),
      congress,
      congressWindowDays: CONGRESS_WINDOW_DAYS,
      sources: {
        bars: "Yahoo Finance daily bars (raw_prices)",
        options: `CBOE delayed option chains, session ${session || "n/a"} (options_daily)`,
        congress: "Senate eFD + House Clerk STOCK Act filings (congress_trades)",
      },
    };

    await withRetry("smart_money_reports upsert", () =>
      sb.from("smart_money_reports").upsert({ kind: "smart_money", as_of: barsAsOf || null, generated_at: payload.generatedAt, payload }, { onConflict: "kind" })
    );
    const note = `bars=${barsAsOf} options_session=${session || "-"} option_names=${options.length} congress_names=${congress.length} candidates=${candidates.length} plays=${Math.min(6, plays.length)} ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    await logRun("compute-smart-money", true, note);
    return json({ ok: true, note });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logRun("compute-smart-money", false, message);
    return json({ ok: false, error: message }, 500);
  }
});
