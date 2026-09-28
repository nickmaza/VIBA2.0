// compute-trade-setups
//
// Turns the sector rotation into (a) a measure of how strong/tradeable the
// rotation actually is, and (b) a concrete candidate list with mechanically
// derived risk levels.
//
//   rotation_strength -- daily series: cross-sectional dispersion of the 11
//     sector scores, the leader/laggard spread, and leadership persistence
//     (Spearman rank correlation vs 21 sessions ago), blended into 0-100.
//   trade_setups -- the leading sector ETFs plus the strongest constituents
//     inside those sectors (ranked across the whole stock library from
//     symbol_stats), each with ATR-derived entry / stop / targets.
//
// Everything here is rules-based arithmetic on real daily bars (raw_prices,
// filled by sync-prices). It ranks and sizes risk; it does not predict.
//
// Auth: x-refresh-secret, called by pg_cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry } from "../_shared/common.ts";

const SECTOR_W = { m3: 0.2, m6: 0.3, m12: 0.5 };
const STOCK_W = { m3: 0.4, m6: 0.6 };
const SECTOR_MIN_BARS = 253;
const VOL_WINDOW = 126;
const ATR_N = 14;
const PERSIST_LAG = 21;
const PCTL_WINDOW = 252;
const HISTORY_OUT = 252;
const TOP_SECTORS = 3;
const STOCKS_PER_SECTOR = 3;
const SWING_LOOKBACK = 20;
const MIN_DOLLAR_VOL = 20e6; // liquid enough to trade with a stop

type Bar = { date: string; open: number | null; high: number | null; low: number | null; close: number };

function stddev(x: number[]): number {
  if (x.length === 0) return 0;
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  return Math.sqrt(x.reduce((a, b) => a + (b - m) * (b - m), 0) / x.length);
}
function annVol(closes: number[], end: number, window = VOL_WINDOW): number {
  const start = end - window;
  if (start < 1) return NaN;
  const rets: number[] = [];
  for (let i = start + 1; i <= end; i++) rets.push(closes[i] / closes[i - 1] - 1);
  return stddev(rets) * Math.sqrt(252);
}
function momentumScore(closes: number[], end: number) {
  if (end < 252) return null;
  const last = closes[end];
  const r3 = last / closes[end - 63] - 1;
  const r6 = last / closes[end - 126] - 1;
  const r12 = last / closes[end - 252] - 1;
  const blended = SECTOR_W.m3 * r3 + SECTOR_W.m6 * r6 + SECTOR_W.m12 * r12;
  const vol = annVol(closes, end);
  if (!Number.isFinite(vol) || vol === 0) return null;
  return { score: blended / vol, r3: r3 * 100, r6: r6 * 100, r12: r12 * 100 };
}
function sma(closes: number[], end: number, n: number): number | null {
  if (end < n - 1) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += closes[i];
  return s / n;
}
function ranksDesc(vals: number[]): number[] {
  const idx = vals.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const out = new Array(vals.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}
function spearman(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0 || b.length !== n) return 0;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}
function percentileOf(v: number, arr: number[]): number {
  if (arr.length === 0) return 0.5;
  let c = 0;
  for (const x of arr) if (x <= v) c++;
  return c / arr.length;
}
function wilderATR(bars: Bar[], end: number, n = ATR_N): { atr: number; trueRange: boolean } | null {
  if (end < n) return null;
  const trs: number[] = [];
  let withHL = 0;
  for (let i = end - n + 1; i <= end; i++) {
    const b = bars[i], pc = bars[i - 1].close;
    if (b.high !== null && b.low !== null) {
      trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
      withHL++;
    } else trs.push(Math.abs(b.close - pc));
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  return { atr, trueRange: withHL >= n * 0.8 };
}
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

async function loadBars(symbols: string[], sinceDays: number): Promise<Map<string, Bar[]>> {
  const since = new Date(Date.now() - sinceDays * 86400e3).toISOString().slice(0, 10);
  const j = (await withRetry("bars_json_many", () => sb.rpc("bars_json_many", { p_symbols: symbols, p_since: since }))) as Record<
    string,
    { t: string[]; o: number[]; h: number[]; l: number[]; c: number[] }
  > | null;
  const out = new Map<string, Bar[]>();
  for (const s of symbols) {
    const b = j?.[s];
    if (!b) continue;
    out.set(s, b.t.map((d, i) => ({ date: d, open: Number(b.o[i]), high: Number(b.h[i]), low: Number(b.l[i]), close: Number(b.c[i]) })));
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  try {
    // ---------- 1. what are we tracking ----------
    const { data: sectorMeta } = await sb.from("symbol_meta").select("symbol,name").eq("active", true).eq("kind", "sector_etf");
    const sectors = (sectorMeta ?? []) as { symbol: string; name: string }[];
    if (!sectors.length) throw new Error("no sector ETFs registered in symbol_meta");

    // ---------- 2. sector bars (one JSON payload) ----------
    const sectorBars = await loadBars(sectors.map((s) => s.symbol), 1900);
    const usable = sectors.filter((s) => (sectorBars.get(s.symbol)?.length ?? 0) >= SECTOR_MIN_BARS);
    if (usable.length < 4) throw new Error(`only ${usable.length} sector ETFs have >= ${SECTOR_MIN_BARS} bars; need at least 4`);
    const dateSets = usable.map((s) => new Set(sectorBars.get(s.symbol)!.map((b) => b.date)));
    const dates = sectorBars.get(usable[0].symbol)!.map((b) => b.date).filter((d) => dateSets.every((set) => set.has(d)));
    const closesBy = new Map<string, number[]>();
    for (const s of usable) {
      const byDate = new Map(sectorBars.get(s.symbol)!.map((b) => [b.date, b.close]));
      closesBy.set(s.symbol, dates.map((d) => byDate.get(d)!));
    }

    // ---------- 3. rotation strength series ----------
    const nD = dates.length;
    const rawDisp: number[] = [], rawSpread: number[] = [], rawPers: number[] = [];
    const seriesDates: string[] = [];
    const leadersAt: string[][] = [], laggardsAt: string[][] = [];
    const ranksAt: number[][] = [];
    for (let i = 252; i < nD; i++) {
      const scores: number[] = [];
      let ok = true;
      for (const s of usable) {
        const m = momentumScore(closesBy.get(s.symbol)!, i);
        if (!m) { ok = false; break; }
        scores.push(m.score);
      }
      if (!ok) continue;
      const sorted = [...scores].sort((a, b) => b - a);
      const k = Math.min(3, Math.floor(scores.length / 3));
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      const rk = ranksDesc(scores);
      const order = usable.map((s, j) => ({ sym: s.symbol, r: rk[j] })).sort((a, b) => a.r - b.r);
      seriesDates.push(dates[i]);
      rawDisp.push(stddev(scores));
      rawSpread.push(mean(sorted.slice(0, k)) - mean(sorted.slice(-k)));
      ranksAt.push(rk);
      leadersAt.push(order.slice(0, 3).map((o) => o.sym));
      laggardsAt.push(order.slice(-3).map((o) => o.sym));
      const back = ranksAt.length - 1 - PERSIST_LAG;
      rawPers.push(back >= 0 ? spearman(rk, ranksAt[back]) : NaN);
    }
    if (!seriesDates.length) throw new Error("no dates had a full set of sector scores");

    const outStart = Math.max(0, seriesDates.length - HISTORY_OUT);
    const strengthRows: Record<string, unknown>[] = [];
    for (let i = outStart; i < seriesDates.length; i++) {
      const lo = Math.max(0, i - PCTL_WINDOW + 1);
      const pDisp = percentileOf(rawDisp[i], rawDisp.slice(lo, i + 1));
      const pSpread = percentileOf(rawSpread[i], rawSpread.slice(lo, i + 1));
      const pers = Number.isFinite(rawPers[i]) ? rawPers[i] : 0;
      const strength = 100 * (0.4 * pDisp + 0.35 * pSpread + 0.25 * ((pers + 1) / 2));
      let state: string;
      if (pDisp > 0.5 && pers < 0.2) state = "churn";
      else if (strength >= 70) state = "strong";
      else if (strength >= 40) state = "moderate";
      else state = "weak";
      strengthRows.push({
        d: seriesDates[i],
        dispersion: round(rawDisp[i], 4),
        spread: round(rawSpread[i], 4),
        persistence: round(pers, 4),
        strength: round(strength, 2),
        state,
        leaders: leadersAt[i].join(","),
        laggards: laggardsAt[i].join(","),
      });
    }
    const latestStrength = strengthRows[strengthRows.length - 1] as { strength: number; state: string };

    // ---------- 4. current sector ranking ----------
    const last = nD - 1;
    const sectorNow = usable
      .map((s) => ({ symbol: s.symbol, name: s.name, ...momentumScore(closesBy.get(s.symbol)!, last)! }))
      .sort((a, b) => b.score - a.score)
      .map((s, i) => ({ ...s, rank: i + 1 }));
    const sectorScores = sectorNow.map((s) => s.score);
    const leadSectors = sectorNow.slice(0, TOP_SECTORS);
    const leadSet = new Set(leadSectors.map((s) => s.symbol));

    // ---------- 5. stocks inside the leading sectors, ranked from symbol_stats ----------
    const stockRows: { symbol: string; name: string; sector_etf: string; score: number; r3: number; r6: number }[] = [];
    for (let from = 0; from < 10000; from += 1000) {
      const { data } = await sb
        .from("library_stats")
        .select("symbol,name,sector_etf,r3m,r6m,vol126,bars,dollar_vol20")
        .eq("active", true)
        .eq("kind", "stock")
        .in("sector_etf", Array.from(leadSet))
        .order("symbol")
        .range(from, from + 999);
      const rows = (data ?? []) as {
        symbol: string;
        name: string;
        sector_etf: string;
        r3m: number | null;
        r6m: number | null;
        vol126: number | null;
        bars: number;
        dollar_vol20: number | null;
      }[];
      for (const r of rows) {
        const st = r;
        if (st.r3m === null || st.r6m === null || !st.vol126 || st.bars < 140) continue;
        if ((st.dollar_vol20 ?? 0) < MIN_DOLLAR_VOL) continue;
        const score = (STOCK_W.m3 * Number(st.r3m) + STOCK_W.m6 * Number(st.r6m)) / 100 / Number(st.vol126);
        if (!Number.isFinite(score)) continue;
        stockRows.push({ symbol: r.symbol, name: r.name, sector_etf: r.sector_etf, score, r3: Number(st.r3m), r6: Number(st.r6m) });
      }
      if (rows.length < 1000) break;
    }
    const allStockScores = stockRows.map((s) => s.score);
    const picks = leadSectors.flatMap((sec) =>
      stockRows.filter((r) => r.sector_etf === sec.symbol && r.score > 0).sort((a, b) => b.score - a.score).slice(0, STOCKS_PER_SECTOR)
    );
    const stockBars = await loadBars(picks.map((p) => p.symbol), 480);

    // ---------- 6. levels ----------
    function buildLevels(bars: Bar[]) {
      const closes = bars.map((b) => b.close);
      const end = closes.length - 1;
      const a = wilderATR(bars, end);
      if (!a) return null;
      const close = closes[end];
      const dma50 = sma(closes, end, 50);
      const dma100 = sma(closes, end, 100);
      let swing = Infinity;
      for (let i = Math.max(0, end - SWING_LOOKBACK + 1); i <= end; i++) swing = Math.min(swing, bars[i].low ?? bars[i].close);
      const structural = Math.min(close - 2 * a.atr, swing - 0.2 * a.atr);
      const stop = Math.max(close - 3 * a.atr, structural);
      const risk = close - stop;
      if (!(risk > 0)) return null;
      const t1 = close + 2 * risk;
      const t2 = close + 3 * risk;
      return {
        close, atr: a.atr, atrTrue: a.trueRange, dma50, dma100,
        entry: close, buyZoneLow: close - 0.5 * a.atr, stop, risk, t1, t2,
        rr1: (t1 - close) / risk, rr2: (t2 - close) / risk,
        t1Atr: (t1 - close) / a.atr, t2Atr: (t2 - close) / a.atr,
        riskPct: (risk / close) * 100,
        extPct: dma50 ? (close / dma50 - 1) * 100 : null,
        trendOk: dma50 !== null && dma100 !== null && close > dma50 && dma50 > dma100,
        date: bars[end].date,
      };
    }
    function playStrength(momPctl: number, trendOk: boolean, aboveDma50: boolean, sectorRank: number, extPct: number | null) {
      const trend = trendOk ? 1 : aboveDma50 ? 0.5 : 0;
      const sectorBack = (usable.length + 1 - sectorRank) / usable.length;
      const ext = extPct === null ? 1 : 1 - Math.min(1, Math.max(0, (extPct - 5) / 15));
      return 100 * (0.4 * momPctl + 0.2 * trend + 0.25 * sectorBack + 0.15 * ext);
    }
    const row = (base: Record<string, unknown>, lv: NonNullable<ReturnType<typeof buildLevels>>, strength: number) => ({
      ...base,
      strength: round(strength, 1),
      close: round(lv.close), atr: round(lv.atr, 3), atr_pct: round((lv.atr / lv.close) * 100, 2),
      entry: round(lv.entry), buy_zone_low: round(lv.buyZoneLow), stop: round(lv.stop), t1: round(lv.t1), t2: round(lv.t2),
      risk_per_share: round(lv.risk), risk_pct: round(lv.riskPct, 2), rr1: round(lv.rr1, 2), rr2: round(lv.rr2, 2),
      t1_atr: round(lv.t1Atr, 1), t2_atr: round(lv.t2Atr, 1), ext_pct: lv.extPct === null ? null : round(lv.extPct, 2),
      trend_ok: lv.trendOk, atr_true: lv.atrTrue,
    });

    const setups: Record<string, unknown>[] = [];
    for (const s of leadSectors) {
      const lv = buildLevels(sectorBars.get(s.symbol)!);
      if (!lv) continue;
      const warn: string[] = [];
      if (lv.extPct !== null && lv.extPct > 8) warn.push(`extended ${lv.extPct.toFixed(1)}% over 50dma`);
      if (!lv.trendOk) warn.push("50dma not above 100dma");
      setups.push(
        row(
          {
            symbol: s.symbol, name: s.name, kind: "sector_etf", sector_etf: s.symbol, sector_name: s.name, sector_rank: s.rank,
            score: round(s.score, 4), r3: round(s.r3, 2), r6: round(s.r6, 2), r12: round(s.r12, 2), as_of: dates[last],
            note: `sector rank ${s.rank} of ${usable.length}` + (warn.length ? ` · ${warn.join(" · ")}` : ""),
          },
          lv,
          playStrength(percentileOf(s.score, sectorScores), lv.trendOk, lv.dma50 !== null && lv.close > lv.dma50, s.rank, lv.extPct),
        ),
      );
    }
    for (const sec of leadSectors) {
      const peers = picks.filter((p) => p.sector_etf === sec.symbol);
      peers.forEach((p, i) => {
        const bars = stockBars.get(p.symbol);
        if (!bars || bars.length < 60) return;
        const lv = buildLevels(bars);
        if (!lv) return;
        const warn: string[] = [];
        if (lv.extPct !== null && lv.extPct > 8) warn.push(`extended ${lv.extPct.toFixed(1)}% over 50dma`);
        if (!lv.trendOk) warn.push("50dma not above 100dma");
        if (!lv.atrTrue) warn.push("ATR from closes only");
        setups.push(
          row(
            {
              symbol: p.symbol, name: p.name, kind: "stock", sector_etf: sec.symbol, sector_name: sec.name, sector_rank: sec.rank,
              score: round(p.score, 4), r3: round(p.r3, 2), r6: round(p.r6, 2), r12: null, as_of: lv.date,
              note: `#${i + 1} in ${sec.symbol} (sector rank ${sec.rank})` + (warn.length ? ` · ${warn.join(" · ")}` : ""),
            },
            lv,
            playStrength(percentileOf(p.score, allStockScores), lv.trendOk, lv.dma50 !== null && lv.close > lv.dma50, sec.rank, lv.extPct),
          ),
        );
      });
    }
    if (!setups.length) throw new Error("no candidate passed the level checks");
    setups.sort((a, b) => (b.strength as number) - (a.strength as number));

    // ---------- 7. persist ----------
    await withRetry("rotation_strength upsert", () => sb.from("rotation_strength").upsert(strengthRows, { onConflict: "d" }));
    await withRetry("trade_setups clear", () => sb.from("trade_setups").delete().neq("symbol", "__none__"));
    await withRetry("trade_setups insert", () => sb.from("trade_setups").insert(setups));

    await logRun(
      "compute-trade-setups",
      true,
      `as_of=${dates[last]} setups=${setups.length} strength=${latestStrength.strength} (${latestStrength.state}) history=${strengthRows.length} ranked_stocks=${stockRows.length}`,
    );
    return json({
      ok: true,
      as_of: dates[last],
      rotation: latestStrength,
      setups: setups.map((s) => ({ symbol: s.symbol, kind: s.kind, strength: s.strength, entry: s.entry, stop: s.stop, t1: s.t1 })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logRun("compute-trade-setups", false, message);
    return json({ ok: false, error: message }, 500);
  }
});
