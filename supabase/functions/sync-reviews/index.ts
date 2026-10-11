// sync-reviews
//
// Consumer reviews for the Predictive Plays tab (Jin 2023: the tone of
// consumer product reviews predicts sales, earnings surprises and returns).
//   appstore  Apple's public customer-reviews RSS feed, US storefront: the
//             newest 50 reviews of each app. Apple serves every spelling of
//             the feed URL from its own cache and some caches come back empty,
//             so each app is tried with the four spellings in random order and
//             the reviews of up to two non-empty answers are merged.
//   steam     Steam's review API, English reviews newest first, back to the
//             last review already counted. The first run counts the current
//             day; backfill runs then sample the 84 days before it, one day
//             (50 reviews) at a time.
//   volume    Cumulative rating counts, one snapshot a day (iTunes lookup,
//             Steam review summary); their day-to-day change is review volume.
// Each review is scored with tone.ts; only daily sums per product and star
// rating are stored, plus a few recent reviews per product for display.
//
// Body: { source: "appstore" | "steam" | "volume", limit?, backfill?, wait? }
// Auth: x-refresh-secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, withRetry, readBody, runInBackground, sleep, httpGet, isoDate } from "../_shared/common.ts";
import { nameWords, scoreReview, type ReviewTone } from "../_shared/tone.ts";
import { NEGATIVE_WORDS, POSITIVE_WORDS } from "../_shared/lexicon.ts";

const BUDGET_MS = 100_000;
const SAMPLE_SLOTS = 8;
const BACKFILL_DAYS = 84;
const STEAM_LIVE_PAGES = 6;

interface Product {
  source: string;
  product_id: string;
  ticker: string;
  name: string;
  last_review_id: number | null;
  backfilled_to: string | null;
  last_fetch_at: string | null;
}

interface Review {
  id: string;
  idNum: number;
  postedAt: string; // ISO
  stars: number; // 1..5 (Steam: 5 recommended, 1 not recommended)
  title: string;
  body: string;
}

interface ToneRow {
  day: string;
  stars: number;
  n: number;
  words: number;
  pos_words: number;
  neg_words: number;
  pos_tone_sum: number;
  neg_tone_sum: number;
  neg_reviews: number;
  pos_reviews: number;
}

interface Sample {
  slot: number;
  review_id: string;
  posted_at: string;
  stars: number;
  title: string;
  body: string;
  words: number;
  pos_words: number;
  neg_words: number;
}

async function loadProducts(source: string): Promise<Product[]> {
  const { data: prods, error } = await sb.from("review_products").select("source,product_id,ticker,name").eq("source", source).eq("active", true);
  if (error) throw new Error(`review_products: ${error.message}`);
  const { data: marks, error: e2 } = await sb
    .from("review_watermarks")
    .select("product_id,last_review_id,backfilled_to,last_fetch_at")
    .eq("source", source)
    .eq("storefront", "us");
  if (e2) throw new Error(`review_watermarks: ${e2.message}`);
  const by = new Map((marks ?? []).map((m) => [String(m.product_id), m]));
  return (prods ?? []).map((p) => {
    const m = by.get(String(p.product_id));
    return {
      source,
      product_id: String(p.product_id),
      ticker: String(p.ticker),
      name: String(p.name),
      last_review_id: m?.last_review_id == null ? null : Number(m.last_review_id),
      backfilled_to: m?.backfilled_to ?? null,
      last_fetch_at: m?.last_fetch_at ?? null,
    };
  });
}

/** Least recently fetched first (never fetched before anything else). */
function rotation(products: Product[]): Product[] {
  return [...products].sort((a, b) => (a.last_fetch_at ?? "").localeCompare(b.last_fetch_at ?? ""));
}

function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Score reviews and sum them by day and star rating; also pick display samples. */
function aggregate(p: Product, reviews: Review[], game: boolean) {
  const ignore = nameWords(p.name);
  const rows = new Map<string, ToneRow>();
  const scored: { r: Review; t: ReviewTone }[] = [];
  for (const r of reviews) {
    const t = scoreReview([r.title, r.body].filter(Boolean).join(". "), { game, ignore });
    if (t.words === 0) continue;
    const day = utcDay(r.postedAt);
    const key = `${day}|${r.stars}`;
    const row = rows.get(key) ?? {
      day,
      stars: r.stars,
      n: 0,
      words: 0,
      pos_words: 0,
      neg_words: 0,
      pos_tone_sum: 0,
      neg_tone_sum: 0,
      neg_reviews: 0,
      pos_reviews: 0,
    };
    row.n++;
    row.words += t.words;
    row.pos_words += t.pos;
    row.neg_words += t.neg;
    row.pos_tone_sum += t.pos / t.words;
    row.neg_tone_sum += t.neg / t.words;
    if (t.neg > t.pos) row.neg_reviews++;
    else if (t.pos > t.neg) row.pos_reviews++;
    rows.set(key, row);
    scored.push({ r, t });
  }
  // newest clearly negative and newest clearly positive review with some text
  const newest = [...scored].filter((s) => s.t.words >= 8).sort((a, b) => b.r.postedAt.localeCompare(a.r.postedAt));
  const picks = [newest.find((s) => s.t.neg > s.t.pos), newest.find((s) => s.t.pos > s.t.neg)].filter(
    (s): s is { r: Review; t: ReviewTone } => Boolean(s),
  );
  const base = (Math.floor(Date.now() / 3_600_000) * 2) % SAMPLE_SLOTS;
  const samples: Sample[] = picks.map((s, i) => ({
    slot: (base + i) % SAMPLE_SLOTS,
    review_id: s.r.id,
    posted_at: new Date(s.r.postedAt).toISOString(),
    stars: s.r.stars,
    title: s.r.title.slice(0, 200),
    body: s.r.body.slice(0, 600),
    words: s.t.words,
    pos_words: s.t.pos,
    neg_words: s.t.neg,
  }));
  return { tone: [...rows.values()], samples, scored: scored.length };
}

// ------------------------------------------------------------------ App Store
const RSS: ((id: string) => string)[] = [
  (id) => `https://itunes.apple.com/us/rss/customerreviews/page=1/id=${id}/sortby=mostrecent/json`,
  (id) => `https://itunes.apple.com/us/rss/customerreviews/id=${id}/sortby=mostrecent/json`,
  (id) => `https://itunes.apple.com/us/rss/customerreviews/id=${id}/sortBy=mostRecent/json`,
  (id) => `https://itunes.apple.com/us/rss/customerreviews/id=${id}/json`,
];

async function appStoreReviews(id: string): Promise<{ reviews: Review[]; answered: number }> {
  const byId = new Map<string, Review>();
  let answered = 0;
  for (const url of shuffled(RSS)) {
    const r = await httpGet(url(id), { timeoutMs: 15_000 });
    if (r.status === 200) {
      let list: Record<string, Record<string, string>>[] = [];
      try {
        const entry = JSON.parse(r.text)?.feed?.entry;
        list = Array.isArray(entry) ? entry : entry ? [entry] : [];
      } catch {
        list = [];
      }
      let got = 0;
      for (const e of list) {
        const stars = Number(e?.["im:rating"]?.label);
        const rid = String(e?.id?.label ?? "");
        const posted = String(e?.updated?.label ?? "");
        // older feeds list the app itself first: no rating, not a review
        if (!(stars >= 1 && stars <= 5) || !/^\d+$/.test(rid) || Number.isNaN(Date.parse(posted))) continue;
        byId.set(rid, { id: rid, idNum: Number(rid), postedAt: posted, stars, title: e?.title?.label ?? "", body: e?.content?.label ?? "" });
        got++;
      }
      if (got) answered++;
      if (answered >= 2) break;
    }
    await sleep(150);
  }
  return { reviews: [...byId.values()], answered };
}

// ------------------------------------------------------------------ Steam
interface SteamReview {
  recommendationid: string;
  review: string;
  timestamp_created: number;
  voted_up: boolean;
}

async function steamPage(appid: string, cursor: string, extra = "", perPage = 100) {
  const url =
    `https://store.steampowered.com/appreviews/${appid}?json=1&filter=recent&language=english&purchase_type=all` +
    `&review_type=all&num_per_page=${perPage}&cursor=${encodeURIComponent(cursor)}${extra}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await httpGet(url, { timeoutMs: 20_000 });
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.text);
        if (j?.success === 1) return { reviews: (j.reviews ?? []) as SteamReview[], cursor: String(j.cursor ?? ""), summary: j.query_summary };
      } catch {
        /* retry */
      }
    }
    await sleep(2_000 * (attempt + 1));
  }
  throw new Error(`steam ${appid}: no answer`);
}

function steamReview(s: SteamReview): Review {
  return {
    id: String(s.recommendationid),
    idNum: Number(s.recommendationid),
    postedAt: new Date(s.timestamp_created * 1000).toISOString(),
    stars: s.voted_up ? 5 : 1,
    title: "",
    body: String(s.review ?? ""),
  };
}

// ------------------------------------------------------------------ runs
async function runAppStore(limit: number) {
  const t0 = Date.now();
  const products = rotation(await loadProducts("appstore")).slice(0, limit);
  const items: Record<string, unknown>[] = [];
  let answered = 0;
  let empty = 0;
  let fresh = 0;
  for (const p of products) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const { reviews, answered: a } = await appStoreReviews(p.product_id);
    const newer = reviews.filter((r) => p.last_review_id == null || r.idNum > p.last_review_id);
    const agg = aggregate(p, newer, false);
    if (a) answered++;
    else empty++;
    fresh += agg.scored;
    const maxId = newer.reduce((m, r) => Math.max(m, r.idNum), p.last_review_id ?? 0);
    const maxAt = newer.reduce<string | null>((m, r) => {
      const at = new Date(r.postedAt).toISOString();
      return m && m > at ? m : at;
    }, null);
    items.push({
      source: "appstore",
      product_id: p.product_id,
      storefront: "us",
      ticker: p.ticker,
      mode: "live",
      prev_review_id: p.last_review_id,
      last_review_id: maxId || null,
      last_review_at: maxAt,
      status: a ? `ok new=${agg.scored}` : "feed empty",
      tone: agg.tone,
      samples: agg.samples,
    });
  }
  const res = (await withRetry("apply_review_batch", () => sb.rpc("apply_review_batch", { p_items: items }))) as {
    applied: number;
    skipped: number;
  } | null;
  return {
    ok: answered > 0 || items.length === 0,
    note: `source=appstore apps=${items.length} answered=${answered} empty=${empty} new_reviews=${fresh} applied=${res?.applied ?? 0} skipped=${res?.skipped ?? 0}`,
  };
}

async function runSteamLive(limit: number) {
  const t0 = Date.now();
  const products = rotation(await loadProducts("steam")).slice(0, limit);
  const items: Record<string, unknown>[] = [];
  let fresh = 0;
  let failed = 0;
  const today = isoDate(new Date());
  const todayStart = Date.parse(`${today}T00:00:00Z`);
  for (const p of products) {
    if (Date.now() - t0 > BUDGET_MS) break;
    try {
      const reviews: Review[] = [];
      let newestSeen = 0;
      let cursor = "*";
      let done = false;
      for (let page = 0; page < STEAM_LIVE_PAGES && !done; page++) {
        const r = await steamPage(p.product_id, cursor);
        for (const s of r.reviews) {
          const rv = steamReview(s);
          newestSeen = Math.max(newestSeen, rv.idNum);
          // first run: only today (earlier days are backfilled); later: back to the watermark
          if (p.last_review_id == null ? Date.parse(rv.postedAt) < todayStart : rv.idNum <= p.last_review_id) {
            done = true;
            break;
          }
          reviews.push(rv);
        }
        if (!r.reviews.length || !r.cursor || r.cursor === cursor) done = true;
        cursor = r.cursor;
        await sleep(600);
      }
      const agg = aggregate(p, reviews, true);
      fresh += agg.scored;
      // on the first run the newest review seen is the starting point even if
      // it is older than today (older days belong to the backfill)
      const maxId = reviews.reduce((m, r) => Math.max(m, r.idNum), p.last_review_id ?? (newestSeen || 0));
      const maxAt = reviews.reduce<string | null>((m, r) => (m && m > r.postedAt ? m : r.postedAt), null);
      items.push({
        source: "steam",
        product_id: p.product_id,
        storefront: "us",
        ticker: p.ticker,
        mode: "live",
        prev_review_id: p.last_review_id,
        last_review_id: maxId || null,
        last_review_at: maxAt,
        status: `ok new=${agg.scored}`,
        backfilled_to: today, // days before the first live run are left to backfill
        tone: agg.tone,
        samples: agg.samples,
      });
    } catch (e) {
      failed++;
      console.error(e instanceof Error ? e.message : String(e));
    }
  }
  const res = (await withRetry("apply_review_batch", () => sb.rpc("apply_review_batch", { p_items: items }))) as {
    applied: number;
    skipped: number;
  } | null;
  return {
    ok: items.length > 0 || products.length === 0,
    note: `source=steam games=${items.length} new_reviews=${fresh} failed=${failed} applied=${res?.applied ?? 0} skipped=${res?.skipped ?? 0}`,
  };
}

async function runSteamBackfill() {
  const t0 = Date.now();
  const floor = isoDate(new Date(Date.now() - BACKFILL_DAYS * 86_400_000));
  const products = (await loadProducts("steam"))
    .filter((p) => p.backfilled_to && p.backfilled_to > floor)
    .sort((a, b) => (b.backfilled_to ?? "").localeCompare(a.backfilled_to ?? ""));
  const items: Record<string, unknown>[] = [];
  let days = 0;
  let fresh = 0;
  for (const p of products) {
    if (Date.now() - t0 > BUDGET_MS) break;
    const reviews: Review[] = [];
    let to = p.backfilled_to as string;
    while (to > floor && Date.now() - t0 < BUDGET_MS) {
      const day = isoDate(new Date(Date.parse(`${to}T00:00:00Z`) - 86_400_000));
      const start = Date.parse(`${day}T00:00:00Z`) / 1000;
      try {
        const r = await steamPage(p.product_id, "*", `&start_date=${start}&end_date=${start + 86_399}&date_range_type=include`, 50);
        for (const s of r.reviews) {
          const rv = steamReview(s);
          if (utcDay(rv.postedAt) === day) reviews.push(rv);
        }
      } catch {
        break; // keep what is done; the next run continues from here
      }
      to = day;
      days++;
      await sleep(600);
    }
    if (to === p.backfilled_to) continue;
    const agg = aggregate(p, reviews, true);
    fresh += agg.scored;
    items.push({
      source: "steam",
      product_id: p.product_id,
      storefront: "us",
      ticker: p.ticker,
      mode: "backfill",
      prev_backfilled_to: p.backfilled_to,
      backfilled_to: to,
      tone: agg.tone,
      samples: [],
    });
  }
  const res = items.length
    ? ((await withRetry("apply_review_batch", () => sb.rpc("apply_review_batch", { p_items: items }))) as { applied: number; skipped: number } | null)
    : { applied: 0, skipped: 0 };
  const left = products.length - items.filter((i) => String(i.backfilled_to) <= floor).length;
  return {
    ok: true,
    note: `source=steam mode=backfill games=${items.length} days=${days} reviews=${fresh} applied=${res?.applied ?? 0} skipped=${res?.skipped ?? 0} games_left=${left}`,
  };
}

async function runVolume() {
  const day = isoDate(new Date());
  const rows: Record<string, unknown>[] = [];
  const apps = await loadProducts("appstore");
  for (let i = 0; i < apps.length; i += 100) {
    const ids = apps.slice(i, i + 100).map((p) => p.product_id);
    const r = await httpGet(`https://itunes.apple.com/lookup?id=${ids.join(",")}&country=us`, { timeoutMs: 20_000 });
    if (r.status !== 200) continue;
    for (const x of (JSON.parse(r.text)?.results ?? []) as Record<string, unknown>[]) {
      const n = Number(x.userRatingCount);
      if (!Number.isFinite(n)) continue;
      rows.push({ source: "appstore", product_id: String(x.trackId), day, total_count: n, avg_rating: Number(x.averageUserRating) || null });
    }
    await sleep(1_000);
  }
  const games = await loadProducts("steam");
  for (const p of games) {
    try {
      const url = `https://store.steampowered.com/appreviews/${p.product_id}?json=1&language=all&purchase_type=all&num_per_page=0`;
      const r = await httpGet(url, { timeoutMs: 20_000 });
      const q = r.status === 200 ? JSON.parse(r.text)?.query_summary : null;
      if (q && Number(q.total_reviews) > 0) {
        rows.push({
          source: "steam",
          product_id: p.product_id,
          day,
          total_count: Number(q.total_reviews),
          avg_rating: Number(q.total_positive) / Number(q.total_reviews),
        });
      }
    } catch {
      /* skip this game today */
    }
    await sleep(500);
  }
  if (rows.length) {
    await withRetry("review_volume_daily upsert", () => sb.from("review_volume_daily").upsert(rows, { onConflict: "source,product_id,day" }));
  }
  return { ok: rows.length > 0, note: `source=volume snapshots=${rows.length} of ${apps.length + games.length}` };
}

async function run(body: Record<string, unknown>) {
  const t0 = Date.now();
  const source = String(body.source ?? "appstore");
  const limit = Math.max(1, Math.min(200, Number(body.limit ?? 30)));
  let out: { ok: boolean; note: string };
  if (source === "appstore") out = await runAppStore(limit);
  else if (source === "steam") out = body.backfill ? await runSteamBackfill() : await runSteamLive(limit);
  else if (source === "volume") out = await runVolume();
  else throw new Error(`unknown source ${source}`);
  const note = `${out.note} ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  await logRun("sync-reviews", out.ok, note);
  return { ok: out.ok, note };
}

/** Fingerprint of the deployed lexicon and scorer, to check a deployment against the repo. */
async function selftest() {
  const bytes = new TextEncoder().encode(`${POSITIVE_WORDS}|${NEGATIVE_WORDS}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    lexicon_sha256: [...digest].map((b) => b.toString(16).padStart(2, "0")).join(""),
    sample: scoreReview("The app doesn't work anymore. Terrible update, crashes constantly. Love the old design though!"),
  };
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  if (body.selftest) return json(await selftest());
  return runInBackground(async () => {
    try {
      return await run(body);
    } catch (e) {
      const msg = `source=${String(body.source ?? "appstore")} ${e instanceof Error ? e.message : String(e)}`;
      await logRun("sync-reviews", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
