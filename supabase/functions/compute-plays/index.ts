// compute-plays
//
// The VIBA stock plays, recomputed from real data after every price sync:
//   1. sectors come ranked from compute-sector-rotation (sector_rankings)
//   2. inside the top 3 sectors, library stocks that are above their 50- and
//      200-day averages and liquid (>= $50M a day) are ranked by risk-adjusted
//      momentum = average of the 3/6/12-month returns / 63-day annualized vol
//   3. the top two per sector are the plays (6), the next name in each
//      sector goes on the watchlist (3)
//   4. every word of each play's case is generated from its own numbers, and
//      the chart read comes from the technical engine (_shared/ta.ts -- the
//      same code the app runs in the browser)
// Rule: no index products (plays are single stocks only).
//
// Writes stock_plays (replaced each run). Auth: x-refresh-secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry } from "../_shared/common.ts";
import { analyze, isAnalysis, money, type Analysis, type Bars } from "../_shared/ta.ts";

const TOP_SECTORS = 3;
const PER_SECTOR = 2;
const MIN_DOLLAR_VOL = 50e6;

interface Cand {
  symbol: string;
  name: string;
  sector_etf: string;
  industry: string | null;
  market_cap: number | null;
  close: number;
  r3m: number;
  r6m: number;
  r12m: number;
  vol63: number;
  dma50: number;
  dma200: number;
  hi52: number;
  score: number;
}

const pct = (x: number, d = 0) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}%`;
const fmtCap = (x: number) => (x >= 1e12 ? `$${(x / 1e12).toFixed(1)} trillion` : x >= 1e9 ? `$${Math.round(x / 1e9)} billion` : `$${Math.round(x / 1e6)} million`);
const short = (n: string) => n.replace(/,? (Inc\.?|Corporation|Corp\.?|Company|Co\.|Holdings?,? Inc\.?|plc|Ltd\.?|N\.V\.|S\.A\.)$/i, "").trim();

function thesisFor(c: Cand, k: number, sec: { name: string; rank: number }) {
  const offHi = (c.close / c.hi52 - 1) * 100;
  const above200 = (c.close / c.dma200 - 1) * 100;
  return (
    `${short(c.name)} is the #${k} momentum name in ${sec.name}, which ranks #${sec.rank} of 11 sectors on risk-adjusted momentum. ` +
    `The stock is ${pct(c.r3m)} over 3 months, ${pct(c.r6m)} over 6 months and ${pct(c.r12m)} over 12 months` +
    (c.market_cap ? `, and is a ${fmtCap(c.market_cap)} company` : "") +
    `. Its 63-day volatility is ${Math.round(c.vol63 * 100)}% annualized, which puts its momentum score (average return per unit of volatility) at ${c.score.toFixed(2)}. ` +
    `It trades ${offHi > -1 ? "at its 52-week high" : `${Math.abs(offHi).toFixed(1)}% below its 52-week high of ${money(c.hi52)}`} and ${above200.toFixed(0)}% above its 200-day average.`
  );
}

function chartReadFor(a: Analysis) {
  const s = a.primary;
  const status = s ? (s.status === "confirmed" ? "confirmed" : s.status === "pending" ? "needs confirmation" : "waiting for price") : "";
  return (
    `${a.narrative[0]} ` +
    (s
      ? `The engine's primary setup is ${s.name.replace(/ \(.*\)$/, "").toLowerCase()} (${status}): entry ${money(s.entry)}, stop ${money(s.stop)}, first target ${money(s.tp1)}. ${s.why}`
      : a.noSetup ?? "")
  ).trim();
}

function riskFor(c: Cand, a: Analysis | null, peer: Cand | null) {
  const vol = Math.round(c.vol63 * 100);
  const ext50 = (c.close / c.dma50 - 1) * 100;
  const parts: string[] = [];
  if (vol >= 60) parts.push(`High volatility (${vol}% annualized): daily moves of ${a ? a.ind.atrPct.toFixed(1) : "several"}% are normal, so size small.`);
  else if (a && a.ind.rsi >= 75) parts.push(`RSI ${a.ind.rsi.toFixed(0)} is overbought; entries are better on a pullback toward the 21-day EMA${a.ind.ema21 ? ` (${money(a.ind.ema21)})` : ""}.`);
  else if (ext50 > 15) parts.push(`Extended ${ext50.toFixed(0)}% above the 50-day average; pullbacks toward it are common after runs like this.`);
  if (peer) parts.push(`Moves with ${peer.symbol} (same industry): treat the two as one position at half size each.`);
  if (!parts.length) parts.push(`A daily close below the 50-day average (${money(c.dma50)}) would break the trend.`);
  return parts.join(" ");
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const t0 = Date.now();
  try {
    const { data: secData } = await sb.from("sector_rankings").select("ticker,name,rank,as_of").order("rank");
    const sectors = (secData ?? []) as { ticker: string; name: string; rank: number; as_of: string }[];
    if (sectors.length < TOP_SECTORS) throw new Error("sector_rankings is empty -- run compute-sector-rotation first");
    const lead = sectors.slice(0, TOP_SECTORS);

    const rows: Record<string, unknown>[] = [];
    for (let from = 0; from < 10000; from += 1000) {
      const { data, error } = await sb
        .from("library_stats")
        .select("symbol,name,sector_etf,industry,market_cap,close,r3m,r6m,r12m,vol63,dma50,dma200,hi52,dollar_vol20,bars,d")
        .eq("active", true)
        .eq("kind", "stock")
        .in("sector_etf", lead.map((s) => s.ticker))
        .order("symbol")
        .range(from, from + 999);
      if (error) throw new Error(`library_stats: ${error.message}`);
      rows.push(...((data ?? []) as Record<string, unknown>[]));
      if ((data ?? []).length < 1000) break;
    }
    const num = (x: unknown) => (x === null || x === undefined ? NaN : Number(x));
    const cands: Cand[] = [];
    for (const r of rows) {
      const c = {
        symbol: String(r.symbol),
        name: String(r.name ?? r.symbol),
        sector_etf: String(r.sector_etf),
        industry: r.industry ? String(r.industry) : null,
        market_cap: r.market_cap === null ? null : num(r.market_cap),
        close: num(r.close),
        r3m: num(r.r3m),
        r6m: num(r.r6m),
        r12m: num(r.r12m),
        vol63: num(r.vol63),
        dma50: num(r.dma50),
        dma200: num(r.dma200),
        hi52: num(r.hi52),
        score: 0,
      };
      if (num(r.bars) < 253 || ![c.close, c.r3m, c.r6m, c.r12m, c.vol63, c.dma50, c.dma200, c.hi52].every(Number.isFinite)) continue;
      if (num(r.dollar_vol20) < MIN_DOLLAR_VOL) continue;
      if (!(c.close > c.dma50 && c.close > c.dma200) || c.vol63 <= 0) continue;
      c.score = (c.r3m + c.r6m + c.r12m) / 3 / (c.vol63 * 100);
      cands.push(c);
    }

    const picks: { c: Cand; k: number; sec: (typeof lead)[number]; list: "play" | "watch" }[] = [];
    for (const sec of lead) {
      const inSector = cands.filter((c) => c.sector_etf === sec.ticker).sort((a, b) => b.score - a.score);
      inSector.slice(0, PER_SECTOR).forEach((c, i) => picks.push({ c, k: i + 1, sec, list: "play" }));
      if (inSector[PER_SECTOR]) picks.push({ c: inSector[PER_SECTOR], k: PER_SECTOR + 1, sec, list: "watch" });
    }
    if (!picks.some((p) => p.list === "play")) throw new Error("no stock passed the trend + liquidity screen in the leading sectors");

    const since = new Date(Date.now() - 800 * 86400e3).toISOString().slice(0, 10);
    const barsJ = (await withRetry("bars_json_many", () =>
      sb.rpc("bars_json_many", { p_symbols: picks.map((p) => p.c.symbol), p_since: since })
    )) as Record<string, Bars> | null;

    const out: Record<string, unknown>[] = [];
    let rank = 0;
    for (const p of picks) {
      const b = barsJ?.[p.c.symbol];
      const bars: Bars | null = b ? { t: b.t, o: b.o.map(Number), h: b.h.map(Number), l: b.l.map(Number), c: b.c.map(Number), v: b.v.map(Number) } : null;
      const res = bars ? analyze(bars) : null;
      const a = res && isAnalysis(res) ? res : null;
      const peer =
        p.list === "play"
          ? picks.find((q) => q !== p && q.list === "play" && q.sec.ticker === p.sec.ticker && q.c.industry && q.c.industry === p.c.industry)?.c ?? null
          : null;
      const sectorLabel = p.c.industry ? `${p.sec.name} · ${p.c.industry}` : p.sec.name;
      out.push({
        symbol: p.c.symbol,
        list: p.list,
        rank: ++rank,
        name: p.c.name,
        sector: sectorLabel,
        sector_etf: p.sec.ticker,
        sector_rank: p.sec.rank,
        score: Math.round(p.c.score * 100) / 100,
        vol: Math.round(p.c.vol63 * 100),
        r3m: Math.round(p.c.r3m * 10) / 10,
        r6m: Math.round(p.c.r6m * 10) / 10,
        r12m: Math.round(p.c.r12m * 10) / 10,
        market_cap: p.c.market_cap,
        thesis: thesisFor(p.c, p.k, p.sec),
        chart_read: a ? chartReadFor(a) : "Price history is too short for a full technical read.",
        risk: riskFor(p.c, a, peer),
        note:
          p.list === "watch"
            ? `Next in line in ${p.sec.name} (momentum score ${p.c.score.toFixed(2)}, ${pct(p.c.r3m)} over 3 months); held back to keep two names per sector.`
            : null,
        as_of: a?.ind.date ?? p.sec.as_of,
        generated_at: new Date().toISOString(),
      });
    }

    await withRetry("stock_plays clear", () => sb.from("stock_plays").delete().neq("symbol", "__none__"));
    await withRetry("stock_plays insert", () => sb.from("stock_plays").insert(out));
    const note = `sectors=${lead.map((s) => s.ticker).join(",")} screened=${cands.length} plays=${out.filter((o) => o.list === "play").map((o) => o.symbol).join(",")} watch=${out.filter((o) => o.list === "watch").map((o) => o.symbol).join(",")} ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    await logRun("compute-plays", true, note);
    return json({ ok: true, note });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logRun("compute-plays", false, message);
    return json({ ok: false, error: message }, 500);
  }
});
