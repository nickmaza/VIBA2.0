// Predictive Plays: consumer review tone as a lead on sales and earnings,
// after Jin (2023), "More than words: Can tone of consumer product reviews
// help predict firms' fundamentals?", Journal of Business Finance &
// Accounting 50(9-10), 1910-1942 (University of Michigan-Dearborn).
//
// Everything is computed inside Supabase:
//   sync-reviews       App Store customer reviews (Apple's public RSS feed) and
//                      Steam user reviews (Steam's public review API) for the
//                      apps and games each covered company sells; every review
//                      is scored for positive / negative tone with the Hu & Liu
//                      opinion lexicon (with negation handling) and summed by day
//   sync-earnings      next report dates (Nasdaq earnings calendar)
//   compute-predictive abnormal tone, controls, score, signal, thesis, and the
//                      return around each report once it has happened
// This module only reads the results.
import { supabase } from "./supabase";
import { num } from "./db";

export type Signal = "tailwind" | "headwind" | "neutral";

export interface PredictivePlay {
  ticker: string;
  name: string;
  industry: string | null;
  sources: string;
  products: string;
  link: "core" | "channel";
  asOf: string;
  windowDays: number;
  reviews: number;
  baselineReviews: number;
  negTone: number | null;
  posTone: number | null;
  negToneAbn: number | null;
  posToneAbn: number | null;
  negToneChg: number | null;
  posToneChg: number | null;
  negShare: number | null;
  rating: number | null;
  volumePerDay: number | null;
  score: number;
  signal: Signal;
  confidence: "high" | "medium" | "low";
  competition: "high" | "moderate" | "concentrated" | null;
  earningsDate: string | null;
  earningsTime: string | null;
  close: number | null;
  ret1m: number | null;
  thesis: string;
  updatedAt: string | null;
}

export interface ReviewQuote {
  ticker: string;
  source: string;
  stars: number;
  title: string;
  body: string;
  postedAt: string;
  tone: "negative" | "positive";
}

export interface Outcome {
  ticker: string;
  earningsDate: string;
  signal: Signal;
  score: number;
  ret: number;
  abnRet: number;
  hit: boolean | null;
}

export interface PredictiveData {
  plays: PredictivePlay[];
  quotes: Map<string, ReviewQuote[]>;
  outcomes: Outcome[];
  error: string | null;
}

export const MIN_REVIEWS = 30;

const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

export async function getPredictive(): Promise<PredictiveData> {
  const [p, s, o] = await Promise.all([
    supabase.from("predictive_plays").select("*").order("score", { ascending: false }),
    supabase
      .from("review_samples")
      .select("ticker,source,stars,title,body,posted_at,pos_words,neg_words")
      .order("posted_at", { ascending: false })
      .limit(1000),
    supabase
      .from("predictive_outcomes")
      .select("ticker,earnings_date,signal,score,ret,abn_ret,hit")
      .order("earnings_date", { ascending: false })
      .limit(500),
  ]);
  const errors: string[] = [];
  if (p.error) errors.push(`predictive_plays: ${p.error.message}`);
  if (s.error) errors.push(`review_samples: ${s.error.message}`);
  if (o.error) errors.push(`predictive_outcomes: ${o.error.message}`);

  const plays: PredictivePlay[] = ((p.data ?? []) as Record<string, unknown>[]).map((r) => ({
    ticker: String(r.ticker),
    name: String(r.name ?? r.ticker),
    industry: str(r.industry),
    sources: String(r.sources ?? ""),
    products: String(r.products ?? ""),
    link: r.link === "core" ? "core" : "channel",
    asOf: String(r.as_of ?? ""),
    windowDays: num(r.window_days) ?? 28,
    reviews: num(r.reviews) ?? 0,
    baselineReviews: num(r.baseline_reviews) ?? 0,
    negTone: num(r.neg_tone),
    posTone: num(r.pos_tone),
    negToneAbn: num(r.neg_tone_abn),
    posToneAbn: num(r.pos_tone_abn),
    negToneChg: num(r.neg_tone_chg),
    posToneChg: num(r.pos_tone_chg),
    negShare: num(r.neg_share),
    rating: num(r.rating),
    volumePerDay: num(r.volume_per_day),
    score: num(r.score) ?? 0,
    signal: (["tailwind", "headwind"].includes(String(r.signal)) ? r.signal : "neutral") as Signal,
    confidence: (["high", "medium"].includes(String(r.confidence)) ? r.confidence : "low") as PredictivePlay["confidence"],
    competition: (["high", "moderate", "concentrated"].includes(String(r.competition)) ? r.competition : null) as PredictivePlay["competition"],
    earningsDate: str(r.earnings_date),
    earningsTime: str(r.earnings_time),
    close: num(r.close),
    ret1m: num(r.ret_1m),
    thesis: String(r.thesis ?? ""),
    updatedAt: str(r.updated_at),
  }));

  // Newest quote of each tone per company (samples are already newest-first).
  const quotes = new Map<string, ReviewQuote[]>();
  for (const r of (s.data ?? []) as Record<string, unknown>[]) {
    const pos = num(r.pos_words) ?? 0;
    const neg = num(r.neg_words) ?? 0;
    const stars = num(r.stars) ?? 0;
    const steam = String(r.source) === "steam";
    // A quote counts only when its words and its rating agree.
    const low = steam ? stars < 3 : stars <= 2;
    const high = steam ? stars >= 3 : stars >= 4;
    const tone = neg > pos && low ? "negative" : pos > neg && high ? "positive" : null;
    if (!tone) continue;
    const t = String(r.ticker);
    const list = quotes.get(t) ?? [];
    if (list.some((q) => q.tone === tone)) continue;
    list.push({
      ticker: t,
      source: steam ? "Steam" : "App Store",
      stars,
      title: String(r.title ?? ""),
      body: String(r.body ?? ""),
      postedAt: String(r.posted_at ?? ""),
      tone,
    });
    quotes.set(t, list);
  }

  const outcomes: Outcome[] = ((o.data ?? []) as Record<string, unknown>[]).map((r) => ({
    ticker: String(r.ticker),
    earningsDate: String(r.earnings_date),
    signal: (["tailwind", "headwind"].includes(String(r.signal)) ? r.signal : "neutral") as Signal,
    score: num(r.score) ?? 0,
    ret: num(r.ret) ?? 0,
    abnRet: num(r.abn_ret) ?? 0,
    hit: r.hit === null || r.hit === undefined ? null : Boolean(r.hit),
  }));

  return { plays, quotes, outcomes, error: errors.length ? errors.join("; ") : null };
}
