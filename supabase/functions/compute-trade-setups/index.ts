// compute-trade-setups
//
// Turns the sector rotation into (a) a measure of how strong/tradeable the
// rotation actually is, and (b) a concrete candidate list with mechanically
// derived risk levels.
//
// Two outputs:
//   rotation_strength -- daily series: cross-sectional dispersion of the 11
//     sector scores, the leader/laggard spread, and leadership persistence
//     (Spearman rank correlation vs 21 sessions ago), blended into a 0-100
//     reading. A rotation is worth trading when sectors are genuinely
//     separating AND the leadership is holding still; wide dispersion with
//     no persistence is churn, not rotation.
//   trade_setups -- the leading sector ETFs plus the strongest constituents
//     inside those sectors, each with ATR-derived entry / stop / targets.
//
// Everything here is rules-based arithmetic on daily closes. It ranks and
// sizes risk; it does not predict. The backtest in this project found the
// regime score was a NET DRAG as a hard on/off filter, so regime is carried
// as context on each row, never as a gate.
//
// Auth: shared-secret header (x-refresh-secret), called by pg_cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REFRESH_SECRET = "Jl1kt0BO-VQC4xywXdrHuAV9pxgRiTxBjbZDMpDvZXI";

// Sector ETFs use the same 3/6/12-month blend as compute-sector-rotation so
// the ladder and the play list can never disagree. Individual names use a
// shorter 3/6-month blend: inside an already-chosen sector what matters is
// who is leading *now*, and a 12-month lookback is too slow for that.
const SECTOR_W = { m3: 0.2, m6: 0.3, m12: 0.5 };
const STOCK_W = { m3: 0.4, m6: 0.6 };
const SECTOR_MIN_BARS = 253;
const STOCK_MIN_BARS = 140;
const VOL_WINDOW = 126;
const ATR_N = 14;
const PERSIST_LAG = 21;
const PCTL_WINDOW = 252;
const HISTORY_OUT = 252;
const TOP_SECTORS = 3;
const STOCKS_PER_SECTOR = 3;
const SWING_LOOKBACK = 20;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---------- transient-failure retry (same contract as the other functions) ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function isTransient(msg: string): boolean {
  return /timeout|gateway|\b50[234]\b|fetch failed|network|connection|ECONNRESET|EPIPE|issued at future|jwt/i.test(msg);
}
async function withRetry<T>(
  label: string,
  fn: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
  attempts = 4,
): Promise<T | null> {
  let lastMsg = "";
  for (let i = 0; i < attempts; i++) {
    let res: { data: T | null; error: { message: string } | null };
    try {
      res = await fn();
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e);
      if (!isTransient(lastMsg)) throw new Error(`${label}: ${lastMsg}`);
      await sleep(800 * (i + 1));
      continue;
    }
    if (!res.error) return res.data;
    lastMsg = res.error.message;
    if (!isTransient(lastMsg)) throw new Error(`${label}: ${lastMsg}`);
    await sleep(800 * (i + 1));
  }
  throw new Error(`${label}: ${lastMsg} (gave up after ${attempts} attempts)`);
}

// ---------- math ----------
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

/** Risk-adjusted blended momentum at index `end`. Returns null if too short. */
function momentumScore(closes: number[], end: number, kind: "sector" | "stock") {
  const need = kind === "sector" ? 252 : 126;
  if (end < need) return null;
  const last = closes[end];
  const r3 = last / closes[end - 63] - 1;
  const r6 = last / closes[end - 126] - 1;
  const r12 = kind === "sector" ? last / closes[end - 252] - 1 : 0;
  const blended = kind === "sector"
    ? SECTOR_W.m3 * r3 + SECTOR_W.m6 * r6 + SECTOR_W.m12 * r12
    : STOCK_W.m3 * r3 + STOCK_W.m6 * r6;
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

/** Ranks, 1 = largest. Ties share the average rank. */
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

/** Pearson correlation of two rank vectors == Spearman of the underlying values. */
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
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** Fraction of `arr` at or below `v`, i.e. 0..1 percentile rank. */
function percentileOf(v: number, arr: number[]): number {
  if (arr.length === 0) return 0.5;
  let c = 0;
  for (const x of arr) if (x <= v) c++;
  return c / arr.length;
}

/**
 * Wilder ATR over the last `n` completed bars ending at `end`.
 * True range needs a high and a low; rows carrying only a close fall back to
 * |close - prevClose|, which is the close-to-close leg of the same formula
 * and understates range on gap days. `trueRange` reports which was used so
 * the UI can be honest about it.
 */
function wilderATR(bars: Bar[], end: number, n = ATR_N): { atr: number; trueRange: boolean } | null {
  if (end < n) return null;
  const trs: number[] = [];
  let withHL = 0;
  for (let i = end - n + 1; i <= end; i++) {
    const b = bars[i], pc = bars[i - 1].close;
    if (b.high !== null && b.low !== null) {
      trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
      withHL++;
    } else {
      trs.push(Math.abs(b.close - pc));
    }
  }
  const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  return { atr, trueRange: withHL >= n * 0.8 };
}

function round(v: number, d = 2) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-refresh-secret") !== REFRESH_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  try {
    // ---------- 1. what are we tracking ----------
    const meta = await withRetry("symbol_meta read failed", () =>
      supabase.from("symbol_meta").select("symbol,name,kind,sector_etf").eq("active", true)
    ) as { symbol: string; name: string; kind: string; sector_etf: string | null }[] | null;
    if (!meta || meta.length === 0) throw new Error("symbol_meta is empty -- register symbols first");

    const sectorMeta = meta.filter((m) => m.kind === "sector_etf");
    const stockMeta = meta.filter((m) => m.kind === "stock" && m.sector_etf);
    if (sectorMeta.length === 0) throw new Error("no sector ETFs registered in symbol_meta");

    // ---------- 2. load bars (per symbol: PostgREST truncates multi-symbol pages) ----------
    async function loadBars(symbol: string, limit: number): Promise<Bar[]> {
      const rows = await withRetry(`raw_prices read failed for ${symbol}`, () =>
        supabase
          .from("raw_prices")
          .select("date,open,high,low,close")
          .eq("symbol", symbol)
          .order("date", { ascending: false })
          .limit(limit)
      ) as Bar[] | null;
      if (!rows) return [];
      return rows
        .map((r) => ({
          date: r.date,
          open: r.open === null ? null : Number(r.open),
          high: r.high === null ? null : Number(r.high),
          low: r.low === null ? null : Number(r.low),
          close: Number(r.close),
        }))
        .reverse(); // back to ascending
    }

    const sectorBars = new Map<string, Bar[]>();
    for (const s of sectorMeta) sectorBars.set(s.symbol, await loadBars(s.symbol, 1200));

    const usableSectors = sectorMeta.filter((s) => (sectorBars.get(s.symbol)?.length ?? 0) >= SECTOR_MIN_BARS);
    if (usableSectors.length < 4) {
      throw new Error(`only ${usableSectors.length} sector ETFs have >= ${SECTOR_MIN_BARS} bars; need at least 4`);
    }

    // align sectors on dates every one of them printed
    const dateSets = usableSectors.map((s) => new Set(sectorBars.get(s.symbol)!.map((b) => b.date)));
    const dates = sectorBars
      .get(usableSectors[0].symbol)!
      .map((b) => b.date)
      .filter((d) => dateSets.every((set) => set.has(d)));
    const closesBySector = new Map<string, number[]>();
    for (const s of usableSectors) {
      const byDate = new Map(sectorBars.get(s.symbol)!.map((b) => [b.date, b.close]));
      closesBySector.set(s.symbol, dates.map((d) => byDate.get(d)!));
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
      for (const s of usableSectors) {
        const m = momentumScore(closesBySector.get(s.symbol)!, i, "sector");
        if (!m) { ok = false; break; }
        scores.push(m.score);
      }
      if (!ok) continue;

      const sorted = [...scores].sort((a, b) => b - a);
      const k = Math.min(3, Math.floor(scores.length / 3));
      const top = sorted.slice(0, k), bot = sorted.slice(-k);
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

      const rk = ranksDesc(scores);
      const order = usableSectors.map((s, j) => ({ sym: s.symbol, r: rk[j] })).sort((a, b) => a.r - b.r);

      seriesDates.push(dates[i]);
      rawDisp.push(stddev(scores));
      rawSpread.push(mean(top) - mean(bot));
      ranksAt.push(rk);
      leadersAt.push(order.slice(0, 3).map((o) => o.sym));
      laggardsAt.push(order.slice(-3).map((o) => o.sym));

      const back = ranksAt.length - 1 - PERSIST_LAG;
      rawPers.push(back >= 0 ? spearman(rk, ranksAt[back]) : NaN);
    }

    if (seriesDates.length === 0) throw new Error("no dates had a full set of sector scores");

    // percentile each component against its own trailing year, then blend
    const outStart = Math.max(0, seriesDates.length - HISTORY_OUT);
    const strengthRows: {
      d: string; dispersion: number; spread: number; persistence: number;
      strength: number; state: string; leaders: string; laggards: string;
    }[] = [];

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
    const latestStrength = strengthRows[strengthRows.length - 1];

    // ---------- 4. current sector ranking ----------
    const last = nD - 1;
    const sectorNow = usableSectors
      .map((s) => {
        const m = momentumScore(closesBySector.get(s.symbol)!, last, "sector")!;
        return { symbol: s.symbol, name: s.name, ...m };
      })
      .sort((a, b) => b.score - a.score)
      .map((s, i) => ({ ...s, rank: i + 1 }));
    const sectorScores = sectorNow.map((s) => s.score);
    const leadSectors = sectorNow.slice(0, TOP_SECTORS);
    const leadSet = new Set(leadSectors.map((s) => s.symbol));

    // ---------- 5. stocks inside the leading sectors ----------
    const stockRows: {
      symbol: string; name: string; sector_etf: string; score: number;
      r3: number; r6: number; bars: Bar[];
    }[] = [];
    for (const st of stockMeta) {
      if (!leadSet.has(st.sector_etf!)) continue; // only load what we can actually use
      const bars = await loadBars(st.symbol, 300);
      if (bars.length < STOCK_MIN_BARS) continue;
      const closes = bars.map((b) => b.close);
      const m = momentumScore(closes, closes.length - 1, "stock");
      if (!m) continue;
      stockRows.push({
        symbol: st.symbol, name: st.name, sector_etf: st.sector_etf!,
        score: m.score, r3: m.r3, r6: m.r6, bars,
      });
    }
    const allStockScores = stockRows.map((s) => s.score);

    // ---------- 6. build the candidate list with levels ----------
    type Setup = Record<string, unknown>;
    const setups: Setup[] = [];

    function buildLevels(bars: Bar[]) {
      const closes = bars.map((b) => b.close);
      const end = closes.length - 1;
      const a = wilderATR(bars, end);
      if (!a) return null;
      const close = closes[end];
      const dma50 = sma(closes, end, 50);
      const dma100 = sma(closes, end, 100);

      // Stop placement: start from volatility (2 ATR), drop it under the
      // recent swing low if structure sits lower, then cap the whole thing at
      // 3 ATR. Without that cap a deep 20-day low drags the stop so far out
      // that the trade risks more than a 2R target pays -- which is how you
      // end up with sub-1 reward:risk on an otherwise fine setup.
      let swing = Infinity;
      for (let i = Math.max(0, end - SWING_LOOKBACK + 1); i <= end; i++) {
        swing = Math.min(swing, bars[i].low ?? bars[i].close);
      }
      const structural = Math.min(close - 2 * a.atr, swing - 0.2 * a.atr);
      const stop = Math.max(close - 3 * a.atr, structural);
      const risk = close - stop;
      if (!(risk > 0)) return null;

      // Targets at fixed R multiples: the plan always pays 2:1 then 3:1.
      // t1Atr/t2Atr say how many DAILY ATRs that actually requires, which is
      // the honest feasibility check -- this is a multi-week hold, so several
      // ATRs is normal, but a double-digit figure means the stop is too wide
      // for the payoff to be realistic.
      const t1 = close + 2 * risk;
      const t2 = close + 3 * risk;
      return {
        close, atr: a.atr, atrTrue: a.trueRange, dma50, dma100,
        entry: close,
        buyZoneLow: close - 0.5 * a.atr,
        stop, risk, t1, t2,
        rr1: (t1 - close) / risk,
        rr2: (t2 - close) / risk,
        t1Atr: (t1 - close) / a.atr,
        t2Atr: (t2 - close) / a.atr,
        riskPct: (risk / close) * 100,
        extPct: dma50 ? (close / dma50 - 1) * 100 : null,
        trendOk: dma50 !== null && dma100 !== null && close > dma50 && dma50 > dma100,
      };
    }

    /** 0-100 conviction: own momentum, trend alignment, sector backing, not-overextended. */
    function playStrength(momPctl: number, trendOk: boolean, aboveDma50: boolean, sectorRank: number, extPct: number | null) {
      const trend = trendOk ? 1 : aboveDma50 ? 0.5 : 0;
      const sectorBack = (usableSectors.length + 1 - sectorRank) / usableSectors.length;
      const ext = extPct === null ? 1 : 1 - Math.min(1, Math.max(0, (extPct - 5) / 15));
      return 100 * (0.4 * momPctl + 0.2 * trend + 0.25 * sectorBack + 0.15 * ext);
    }

    for (const s of leadSectors) {
      const lv = buildLevels(sectorBars.get(s.symbol)!);
      if (!lv) continue;
      const momPctl = percentileOf(s.score, sectorScores);
      const aboveDma50 = lv.dma50 !== null && lv.close > lv.dma50;
      const warn: string[] = [];
      if (lv.extPct !== null && lv.extPct > 8) warn.push(`extended ${lv.extPct.toFixed(1)}% over 50dma`);
      if (!lv.trendOk) warn.push("50dma not above 100dma");
      setups.push({
        symbol: s.symbol, name: s.name, kind: "sector_etf",
        sector_etf: s.symbol, sector_name: s.name, sector_rank: s.rank,
        score: round(s.score, 4),
        strength: round(playStrength(momPctl, lv.trendOk, aboveDma50, s.rank, lv.extPct), 1),
        close: round(lv.close), atr: round(lv.atr, 3),
        atr_pct: round((lv.atr / lv.close) * 100, 2),
        entry: round(lv.entry), buy_zone_low: round(lv.buyZoneLow),
        stop: round(lv.stop), t1: round(lv.t1), t2: round(lv.t2),
        risk_per_share: round(lv.risk), risk_pct: round(lv.riskPct, 2),
        rr1: round(lv.rr1, 2), rr2: round(lv.rr2, 2),
        t1_atr: round(lv.t1Atr, 1), t2_atr: round(lv.t2Atr, 1),
        ext_pct: lv.extPct === null ? null : round(lv.extPct, 2),
        trend_ok: lv.trendOk, atr_true: lv.atrTrue,
        r3: round(s.r3, 2), r6: round(s.r6, 2), r12: round(s.r12, 2),
        as_of: dates[last],
        note: `sector rank ${s.rank} of ${usableSectors.length}` + (warn.length ? ` · ${warn.join(" · ")}` : ""),
      });
    }

    for (const sec of leadSectors) {
      const peers = stockRows
        .filter((r) => r.sector_etf === sec.symbol && r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, STOCKS_PER_SECTOR);
      for (let i = 0; i < peers.length; i++) {
        const p = peers[i];
        const lv = buildLevels(p.bars);
        if (!lv) continue;
        const momPctl = percentileOf(p.score, allStockScores);
        const aboveDma50 = lv.dma50 !== null && lv.close > lv.dma50;
        const warn: string[] = [];
        if (lv.extPct !== null && lv.extPct > 8) warn.push(`extended ${lv.extPct.toFixed(1)}% over 50dma`);
        if (!lv.trendOk) warn.push("50dma not above 100dma");
        if (!lv.atrTrue) warn.push("ATR from closes only");
        setups.push({
          symbol: p.symbol, name: p.name, kind: "stock",
          sector_etf: sec.symbol, sector_name: sec.name, sector_rank: sec.rank,
          score: round(p.score, 4),
          strength: round(playStrength(momPctl, lv.trendOk, aboveDma50, sec.rank, lv.extPct), 1),
          close: round(lv.close), atr: round(lv.atr, 3),
          atr_pct: round((lv.atr / lv.close) * 100, 2),
          entry: round(lv.entry), buy_zone_low: round(lv.buyZoneLow),
          stop: round(lv.stop), t1: round(lv.t1), t2: round(lv.t2),
          risk_per_share: round(lv.risk), risk_pct: round(lv.riskPct, 2),
          rr1: round(lv.rr1, 2), rr2: round(lv.rr2, 2),
          t1_atr: round(lv.t1Atr, 1), t2_atr: round(lv.t2Atr, 1),
          ext_pct: lv.extPct === null ? null : round(lv.extPct, 2),
          trend_ok: lv.trendOk, atr_true: lv.atrTrue,
          r3: round(p.r3, 2), r6: round(p.r6, 2), r12: null,
          as_of: dates[last],
          note: `#${i + 1} in ${sec.symbol} (sector rank ${sec.rank})` + (warn.length ? ` · ${warn.join(" · ")}` : ""),
        });
      }
    }

    if (setups.length === 0) throw new Error("no candidate passed the level checks");
    setups.sort((a, b) => (b.strength as number) - (a.strength as number));

    // ---------- 7. persist ----------
    await withRetry("rotation_strength upsert failed", () =>
      supabase.from("rotation_strength").upsert(strengthRows, { onConflict: "d" })
    );

    // the candidate set shrinks and shifts between runs, so clear then write
    await withRetry("trade_setups clear failed", () =>
      supabase.from("trade_setups").delete().neq("symbol", "__none__")
    );
    await withRetry("trade_setups insert failed", () =>
      supabase.from("trade_setups").insert(setups)
    );

    await withRetry("refresh_log insert failed", () =>
      supabase.from("refresh_log").insert({
        source: "compute-trade-setups",
        ok: true,
        note: `as_of=${dates[last]} setups=${setups.length} strength=${latestStrength.strength} (${latestStrength.state}) history=${strengthRows.length}`,
      })
    ).catch(() => {});

    return new Response(
      JSON.stringify({
        ok: true,
        as_of: dates[last],
        rotation: latestStrength,
        setups_written: setups.length,
        strength_rows: strengthRows.length,
        setups: setups.map((s) => ({
          symbol: s.symbol, kind: s.kind, strength: s.strength,
          entry: s.entry, stop: s.stop, t1: s.t1, t2: s.t2,
          risk_pct: s.risk_pct, t1_atr: s.t1_atr,
        })),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await withRetry("refresh_log insert failed", () =>
      supabase.from("refresh_log").insert({ source: "compute-trade-setups", ok: false, note: message })
    ).catch(() => {});
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 500 });
  }
});
