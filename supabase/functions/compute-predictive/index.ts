// compute-predictive
//
// Predictive Plays, after Jin (2023), "More than words: Can tone of consumer
// product reviews help predict firms' fundamentals?" (Journal of Business
// Finance & Accounting 50(9-10)): the tone of consumer product reviews
// predicts a firm's next-quarter sales, earnings surprises, announcement
// returns and risk; negative tone carries more information than positive
// tone; the effect is stronger in competitive industries; and it holds after
// controlling for review rating, volume and dispersion.
//
// For every covered company (review_products), from the daily sums that
// sync-reviews writes:
//   1. tone over the last 28 days: positive and negative tone are each
//      review's share of positive / negative opinion words, averaged
//   2. abnormal tone: tone minus what reviews with the same star rating show
//      across the whole universe (information in the words beyond the stars)
//   3. cross-sectional controls for review rating, review volume (new ratings
//      per day from the stores' cumulative counts) and rating dispersion:
//      regression residuals
//   4. once the firm has a baseline (the 56 days before the window), the
//      change in abnormal tone against it
//   5. score = 0.65 x (lower negative tone) + 0.35 x (higher positive tone),
//      in cross-sectional standard deviations, levels blended with changes
//      when a baseline exists, then scaled down in concentrated industries
//      (Nasdaq industry HHI of market caps)
// It also stores each day's signal and, after every report, the stock's
// return from the close before to the close after it minus SPY, so the
// track record is measured on this data rather than assumed.
//
// Body: { wait? }. Auth: x-refresh-secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry, readBody, runInBackground, isoDate, upsertChunks } from "../_shared/common.ts";

const CUR_DAYS = 28;
const BASE_DAYS = 56;
const MIN_CUR = 30; // reviews needed in the window for a signal
const MIN_BASE = 30; // reviews needed in the baseline for the change component
const W_NEG = 0.65;
const W_POS = 0.35;

interface InputRow {
  ticker: string;
  source: string;
  win: "cur" | "base";
  stars: number;
  n: number;
  pos_tone_sum: number;
  neg_tone_sum: number;
  neg_reviews: number;
  pos_reviews: number;
}

interface WindowStats {
  n: number;
  posTone: number;
  negTone: number;
  abnPos: number;
  abnNeg: number;
  negShare: number;
  rating: number;
  dispersion: number;
}

const num = (v: unknown) => (v == null ? NaN : Number(v));

function ratingOf(source: string, stars: number): number {
  return source === "steam" ? (stars >= 3 ? 1 : 0) : (stars - 1) / 4;
}

function zscores(xs: number[]): number[] {
  const n = xs.length;
  if (n < 2) return xs.map(() => 0);
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) || 1;
  return xs.map((x) => Math.max(-3, Math.min(3, (x - mean) / sd)));
}

/** OLS residuals of y on [1, ...columns]; falls back to demeaned y when the system is singular. */
function residuals(y: number[], cols: number[][]): number[] {
  const n = y.length;
  const k = cols.length + 1;
  if (n < k + 5) {
    const m = y.reduce((s, v) => s + v, 0) / Math.max(1, n);
    return y.map((v) => v - m);
  }
  const X = y.map((_, i) => [1, ...cols.map((c) => c[i])]);
  const XtX = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => X.reduce((s, r) => s + r[a] * r[b], 0)));
  const Xty = Array.from({ length: k }, (_, a) => X.reduce((s, r, i) => s + r[a] * y[i], 0));
  // Gauss-Jordan with partial pivoting
  const M = XtX.map((row, i) => [...row, Xty[i]]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) {
      const m = y.reduce((s, v) => s + v, 0) / n;
      return y.map((v) => v - m);
    }
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  const beta = M.map((row, i) => row[k] / row[i]);
  return y.map((v, i) => v - X[i].reduce((s, x, j) => s + x * beta[j], 0));
}

async function selectAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, label: string) {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function pct(x: number, digits = 1) {
  return `${(x * 100).toFixed(digits)}%`;
}
function pts(x: number) {
  const v = x * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)} pts`;
}
function longDate(d: string) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

async function run() {
  const t0 = Date.now();
  const asOf = isoDate(new Date());

  // ---- inputs ----------------------------------------------------------
  const inputs = ((await withRetry("predictive_tone_inputs", () =>
    sb.rpc("predictive_tone_inputs", { p_asof: asOf, p_cur: CUR_DAYS, p_base: BASE_DAYS })
  )) ?? []) as Record<string, unknown>[];
  const rows: InputRow[] = inputs.map((r) => ({
    ticker: String(r.ticker),
    source: String(r.source),
    win: String(r.win) as "cur" | "base",
    stars: Number(r.stars),
    n: Number(r.n),
    pos_tone_sum: Number(r.pos_tone_sum),
    neg_tone_sum: Number(r.neg_tone_sum),
    neg_reviews: Number(r.neg_reviews),
    pos_reviews: Number(r.pos_reviews),
  }));

  const products = await selectAll<Record<string, unknown>>(
    (a, b) => sb.from("review_products").select("source,product_id,ticker,name,link").eq("active", true).range(a, b),
    "review_products",
  );
  const tickers = [...new Set(products.map((p) => String(p.ticker)))].sort();

  const volumes = await selectAll<Record<string, unknown>>(
    (a, b) =>
      sb
        .from("review_volume_daily")
        .select("source,product_id,day,total_count")
        .gte("day", isoDate(new Date(Date.now() - (CUR_DAYS + 3) * 86_400_000)))
        .order("day")
        .range(a, b),
    "review_volume_daily",
  );

  const { data: dir, error: dirErr } = await sb.from("symbol_directory").select("symbol,name,industry").in("symbol", tickers);
  if (dirErr) throw new Error(`symbol_directory: ${dirErr.message}`);
  const hhiRows = ((await withRetry("industry_concentration", () => sb.rpc("industry_concentration"))) ?? []) as Record<string, unknown>[];
  const hhiBy = new Map(hhiRows.map((r) => [String(r.industry), { hhi: Number(r.hhi), firms: Number(r.firms) }]));

  const staleCut = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const { data: cal, error: calErr } = await sb
    .from("earnings_calendar")
    .select("ticker,report_date,time_of_day,updated_at")
    .in("ticker", tickers)
    .gte("report_date", isoDate(new Date(Date.now() - 20 * 86_400_000)))
    .order("report_date");
  if (calErr) throw new Error(`earnings_calendar: ${calErr.message}`);

  const priceFrom = isoDate(new Date(Date.now() - 60 * 86_400_000));
  const prices = await selectAll<Record<string, unknown>>(
    (a, b) => sb.from("raw_prices").select("symbol,date,close").in("symbol", [...tickers, "SPY"]).gte("date", priceFrom).order("date").range(a, b),
    "raw_prices",
  );
  const closes = new Map<string, { date: string; close: number }[]>();
  for (const p of prices) {
    const s = String(p.symbol);
    const list = closes.get(s) ?? [];
    list.push({ date: String(p.date), close: Number(p.close) });
    closes.set(s, list);
  }

  // ---- pooled expectation per source, window and star rating ------------
  const pool = new Map<string, { n: number; pos: number; neg: number }>();
  for (const r of rows) {
    const k = `${r.source}|${r.win}|${r.stars}`;
    const e = pool.get(k) ?? { n: 0, pos: 0, neg: 0 };
    e.n += r.n;
    e.pos += r.pos_tone_sum;
    e.neg += r.neg_tone_sum;
    pool.set(k, e);
  }
  const expected = (source: string, win: string, stars: number) => {
    const e = pool.get(`${source}|${win}|${stars}`);
    return e && e.n ? { pos: e.pos / e.n, neg: e.neg / e.n } : { pos: 0, neg: 0 };
  };

  function stats(ticker: string, win: "cur" | "base"): WindowStats | null {
    const rs = rows.filter((r) => r.ticker === ticker && r.win === win);
    const n = rs.reduce((s, r) => s + r.n, 0);
    if (!n) return null;
    let pos = 0;
    let neg = 0;
    let abnPos = 0;
    let abnNeg = 0;
    let negRev = 0;
    let rating = 0;
    for (const r of rs) {
      const e = expected(r.source, win, r.stars);
      pos += r.pos_tone_sum;
      neg += r.neg_tone_sum;
      abnPos += r.pos_tone_sum - r.n * e.pos;
      abnNeg += r.neg_tone_sum - r.n * e.neg;
      negRev += r.neg_reviews;
      rating += r.n * ratingOf(r.source, r.stars);
    }
    rating /= n;
    const variance = rs.reduce((s, r) => s + r.n * (ratingOf(r.source, r.stars) - rating) ** 2, 0) / n;
    return {
      n,
      posTone: pos / n,
      negTone: neg / n,
      abnPos: abnPos / n,
      abnNeg: abnNeg / n,
      negShare: negRev / n,
      rating,
      dispersion: Math.sqrt(variance),
    };
  }

  // ---- review volume: new ratings per day over the window --------------
  const volByProduct = new Map<string, { first: { day: string; c: number }; last: { day: string; c: number } }>();
  for (const v of volumes) {
    const k = `${v.source}|${v.product_id}`;
    const point = { day: String(v.day), c: Number(v.total_count) };
    const e = volByProduct.get(k);
    if (!e) volByProduct.set(k, { first: point, last: point });
    else {
      if (point.day < e.first.day) e.first = point;
      if (point.day > e.last.day) e.last = point;
    }
  }
  function volumePerDay(ticker: string): number | null {
    let total = 0;
    let any = false;
    for (const p of products.filter((x) => String(x.ticker) === ticker)) {
      const e = volByProduct.get(`${p.source}|${p.product_id}`);
      if (!e || e.last.day === e.first.day) continue;
      const days = (Date.parse(e.last.day) - Date.parse(e.first.day)) / 86_400_000;
      total += Math.max(0, e.last.c - e.first.c) / days;
      any = true;
    }
    return any ? total : null;
  }

  // ---- per company ------------------------------------------------------
  interface Firm {
    ticker: string;
    cur: WindowStats | null;
    base: WindowStats | null;
    volume: number | null;
    products: string[];
    sources: string[];
    link: string;
  }
  const firms: Firm[] = tickers.map((t) => {
    const ps = products.filter((p) => String(p.ticker) === t);
    return {
      ticker: t,
      cur: stats(t, "cur"),
      base: stats(t, "base"),
      volume: volumePerDay(t),
      products: ps.map((p) => String(p.name)),
      sources: [...new Set(ps.map((p) => (String(p.source) === "steam" ? "Steam" : "App Store")))],
      link: ps.some((p) => String(p.link) === "core") ? "core" : "channel",
    };
  });

  const eligible = firms.filter((f) => f.cur && f.cur.n >= MIN_CUR);
  // controls: rating, log volume (median-imputed), dispersion
  const logVol = eligible.map((f) => (f.volume != null ? Math.log1p(f.volume) : NaN));
  const known = logVol.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const med = known.length ? known[Math.floor(known.length / 2)] : 0;
  const volCol = logVol.map((v) => (Number.isFinite(v) ? v : med));
  const ratingCol = eligible.map((f) => f.cur!.rating);
  const dispCol = eligible.map((f) => f.cur!.dispersion);
  const resNeg = residuals(eligible.map((f) => f.cur!.abnNeg), [ratingCol, volCol, dispCol]);
  const resPos = residuals(eligible.map((f) => f.cur!.abnPos), [ratingCol, volCol, dispCol]);
  const zNeg = zscores(resNeg);
  const zPos = zscores(resPos);
  const level = new Map(eligible.map((f, i) => [f.ticker, W_NEG * -zNeg[i] + W_POS * zPos[i]]));

  const withBase = eligible.filter((f) => f.base && f.base.n >= MIN_BASE);
  const change = new Map<string, number>();
  const deltas = new Map<string, { dNeg: number; dPos: number }>();
  if (withBase.length >= 8) {
    const dNeg = withBase.map((f) => f.cur!.abnNeg - f.base!.abnNeg);
    const dPos = withBase.map((f) => f.cur!.abnPos - f.base!.abnPos);
    const zdN = zscores(dNeg);
    const zdP = zscores(dPos);
    withBase.forEach((f, i) => {
      change.set(f.ticker, W_NEG * -zdN[i] + W_POS * zdP[i]);
      deltas.set(f.ticker, { dNeg: dNeg[i], dPos: dPos[i] });
    });
  } else {
    withBase.forEach((f) => deltas.set(f.ticker, { dNeg: f.cur!.abnNeg - f.base!.abnNeg, dPos: f.cur!.abnPos - f.base!.abnPos }));
  }

  const dirBy = new Map((dir ?? []).map((d) => [String(d.symbol), d]));
  const nextReport = new Map<string, { date: string; time: string | null }>();
  for (const c of cal ?? []) {
    const d = String(c.report_date);
    if (d < asOf || String(c.updated_at) < staleCut) continue;
    if (!nextReport.has(String(c.ticker))) nextReport.set(String(c.ticker), { date: d, time: c.time_of_day == null ? null : String(c.time_of_day) });
  }

  const out: Record<string, unknown>[] = [];
  for (const f of firms) {
    const d = dirBy.get(f.ticker);
    const name = String(d?.name ?? f.ticker);
    const industry = d?.industry == null ? null : String(d.industry);
    const conc = industry ? hhiBy.get(industry) : undefined;
    const hhi = conc?.hhi ?? null;
    const competition = hhi == null ? null : hhi < 0.15 ? "high" : hhi < 0.25 ? "moderate" : "concentrated";
    const factor = competition === "concentrated" ? 0.7 : competition === "moderate" ? 0.85 : 1;
    const px = closes.get(f.ticker) ?? [];
    const last = px[px.length - 1];
    const monthAgo = px.length > 21 ? px[px.length - 22] : px[0];
    const report = nextReport.get(f.ticker) ?? null;
    const lvl = level.get(f.ticker);
    const chg = change.get(f.ticker);
    const delta = deltas.get(f.ticker);
    const eligibleNow = lvl !== undefined;
    const raw = !eligibleNow ? 0 : chg !== undefined ? 0.6 * chg + 0.4 * lvl : lvl;
    const score = Math.round(raw * factor * 100) / 100;
    const signal = !eligibleNow ? "neutral" : score >= 0.5 ? "tailwind" : score <= -0.5 ? "headwind" : "neutral";
    const n = f.cur?.n ?? 0;
    const points = (n >= 150 ? 2 : n >= 60 ? 1 : 0) + (chg !== undefined ? 1 : 0) + (f.link === "core" ? 1 : 0) + (competition === "high" ? 1 : 0);
    const confidence = !eligibleNow ? "low" : points >= 4 ? "high" : points >= 2 ? "medium" : "low";

    let thesis: string;
    const where = f.sources.join(" + ");
    if (!eligibleNow || !f.cur) {
      thesis = `Not enough reviews yet: ${n} in the last ${CUR_DAYS} days (${where}); a signal needs ${MIN_CUR}.`;
    } else {
      const c = f.cur;
      const parts = [
        `${n.toLocaleString("en-US")} ${where} reviews in the last ${CUR_DAYS} days: ${pct(c.negTone)} of words negative, ${pct(c.posTone)} positive.`,
        `Against reviews with the same star ratings across the universe, negative tone is ${pts(c.abnNeg)} and positive tone ${pts(c.abnPos)}.`,
      ];
      if (delta && chg !== undefined) {
        parts.push(`Versus the firm's previous ${BASE_DAYS} days, negative tone moved ${pts(delta.dNeg)} and positive tone ${pts(delta.dPos)}.`);
      } else {
        parts.push(`No ${BASE_DAYS}-day baseline yet, so this reads tone against other companies only.`);
      }
      const lean =
        signal === "tailwind"
          ? "Tone points to stronger sales and an upside earnings surprise next quarter"
          : signal === "headwind"
            ? "Tone points to weaker sales and a downside earnings surprise next quarter"
            : "Tone does not lean clearly either way";
      parts.push(`${lean}${competition ? ` (competition: ${competition})` : ""}.`);
      if (report) parts.push(`Next report ${longDate(report.date)}${report.time && report.time !== "not supplied" ? `, ${report.time}` : ""}.`);
      thesis = parts.join(" ");
    }

    out.push({
      ticker: f.ticker,
      name,
      industry,
      sources: where,
      products: f.products.join(" · "),
      link: f.link,
      as_of: asOf,
      window_days: CUR_DAYS,
      reviews: n,
      baseline_reviews: f.base?.n ?? 0,
      neg_tone: f.cur?.negTone ?? null,
      pos_tone: f.cur?.posTone ?? null,
      neg_tone_abn: f.cur?.abnNeg ?? null,
      pos_tone_abn: f.cur?.abnPos ?? null,
      neg_tone_chg: chg !== undefined ? delta?.dNeg ?? null : null,
      pos_tone_chg: chg !== undefined ? delta?.dPos ?? null : null,
      neg_share: f.cur?.negShare ?? null,
      rating: f.cur?.rating ?? null,
      dispersion: f.cur?.dispersion ?? null,
      volume_per_day: f.volume,
      score,
      signal,
      confidence,
      competition,
      industry_hhi: hhi,
      earnings_date: report?.date ?? null,
      earnings_time: report?.time ?? null,
      close: last?.close ?? null,
      ret_1m: last && monthAgo && monthAgo.close ? last.close / monthAgo.close - 1 : null,
      thesis,
      updated_at: new Date().toISOString(),
    });
  }
  await upsertChunks("predictive_plays", out, "ticker", 200);

  const history = out
    .filter((r) => Number(r.reviews) >= MIN_CUR)
    .map((r) => ({
      ticker: r.ticker,
      as_of: asOf,
      score: r.score,
      signal: r.signal,
      confidence: r.confidence,
      reviews: r.reviews,
      earnings_date: r.earnings_date,
      close: r.close,
    }));
  if (history.length) await upsertChunks("predictive_signal_history", history, "ticker,as_of", 500);

  // ---- outcomes: return around each report vs SPY ------------------------
  const { data: done } = await sb.from("predictive_outcomes").select("ticker,earnings_date");
  const scored = new Set((done ?? []).map((d) => `${d.ticker}|${d.earnings_date}`));
  const spy = closes.get("SPY") ?? [];
  const outcomes: Record<string, unknown>[] = [];
  for (const c of cal ?? []) {
    const t = String(c.ticker);
    const d = String(c.report_date);
    if (d >= asOf || scored.has(`${t}|${d}`)) continue;
    const { data: sig } = await sb
      .from("predictive_signal_history")
      .select("as_of,score,signal,confidence")
      .eq("ticker", t)
      .lt("as_of", d)
      .gte("as_of", isoDate(new Date(Date.parse(`${d}T00:00:00Z`) - 10 * 86_400_000)))
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!sig) continue;
    const px = closes.get(t) ?? [];
    const pre = [...px].reverse().find((p) => p.date < d);
    const post = px.find((p) => p.date > d);
    const spyPre = [...spy].reverse().find((p) => p.date < d);
    const spyPost = spy.find((p) => p.date > d);
    if (!pre || !post || !spyPre || !spyPost) continue;
    const ret = post.close / pre.close - 1;
    const spyRet = spyPost.close / spyPre.close - 1;
    const abn = ret - spyRet;
    outcomes.push({
      ticker: t,
      earnings_date: d,
      signal_as_of: sig.as_of,
      score: sig.score,
      signal: sig.signal,
      confidence: sig.confidence,
      pre_close: pre.close,
      post_close: post.close,
      ret,
      spy_ret: spyRet,
      abn_ret: abn,
      hit: sig.signal === "tailwind" ? abn > 0 : sig.signal === "headwind" ? abn < 0 : null,
      computed_at: new Date().toISOString(),
    });
  }
  if (outcomes.length) await upsertChunks("predictive_outcomes", outcomes, "ticker,earnings_date", 200);

  const tail = out.filter((r) => r.signal === "tailwind").length;
  const head = out.filter((r) => r.signal === "headwind").length;
  const note =
    `as_of=${asOf} companies=${out.length} with_signal=${eligible.length} baseline=${withBase.length} ` +
    `tailwind=${tail} headwind=${head} outcomes=${outcomes.length} ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  await logRun("compute-predictive", true, note);
  return { ok: true, note };
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  return runInBackground(async () => {
    try {
      return await run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logRun("compute-predictive", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
