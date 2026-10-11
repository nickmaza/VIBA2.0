import type { ReactNode } from "react";
import Panel, { Chip } from "@/components/Panel";
import { MIN_REVIEWS, type Outcome, type PredictiveData, type PredictivePlay, type ReviewQuote, type Signal } from "@/lib/predictive";

const PAPER_URL = "https://ideas.repec.org/a/bla/jbfnac/v50y2023i9-10p1910-1942.html";

function pct(x: number | null, digits = 1) {
  return x === null ? "—" : `${(x * 100).toFixed(digits)}%`;
}
function pts(x: number | null) {
  if (x === null) return "—";
  const v = x * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
}
function signed(x: number | null, digits = 1) {
  if (x === null) return "—";
  const v = x * 100;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;
}
function shortDate(d: string | null) {
  if (!d) return "—";
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
function daysUntil(d: string | null, today: string) {
  if (!d) return null;
  return Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
function clip(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

const SIGNAL_CLASS: Record<Signal, string> = {
  tailwind: "text-term-green",
  headwind: "text-term-red",
  neutral: "text-term-dim",
};

function SignalTag({ signal }: { signal: Signal }) {
  const label = signal === "tailwind" ? "▲ TAILWIND" : signal === "headwind" ? "▼ HEADWIND" : "· NEUTRAL";
  return <span className={`whitespace-nowrap font-semibold ${SIGNAL_CLASS[signal]}`}>{label}</span>;
}

/** Diverging bar for the score (cross-sectional standard deviations, ±2 shown). */
function ScoreBar({ score }: { score: number }) {
  const w = Math.min(1, Math.abs(score) / 2) * 50;
  const pos = score >= 0;
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-2 w-24 shrink-0 border border-term-border bg-term-panel2">
        <div className="absolute inset-y-0 left-1/2 w-px bg-term-borderStrong" />
        <div
          className={`absolute inset-y-0 ${pos ? "bg-term-green" : "bg-term-red"}`}
          style={pos ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
        />
      </div>
      <span className={`w-10 text-right tabular-nums ${score >= 0.5 ? "text-term-green" : score <= -0.5 ? "text-term-red" : "text-term-text"}`}>
        {score >= 0 ? "+" : "−"}
        {Math.abs(score).toFixed(2)}
      </span>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="px-2 py-3 text-[11px] text-term-dim">{children}</div>;
}

function SignalTable({ rows, today }: { rows: PredictivePlay[]; today: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase text-term-dim">
            <th className="px-2 py-1 font-normal">Company</th>
            <th className="px-2 py-1 font-normal">Signal</th>
            <th className="px-2 py-1 font-normal">Score</th>
            <th className="px-2 py-1 font-normal">Conf.</th>
            <th className="px-2 py-1 text-right font-normal">Reviews</th>
            <th className="px-2 py-1 text-right font-normal" title="Share of review words that are negative">Neg tone</th>
            <th className="px-2 py-1 text-right font-normal" title="Share of review words that are positive">Pos tone</th>
            <th className="px-2 py-1 text-right font-normal" title="Negative tone minus reviews with the same star ratings across the universe, in percentage points">Abn neg</th>
            <th className="px-2 py-1 text-right font-normal" title="Change in abnormal negative tone against the firm's previous 56 days, in percentage points">Δ neg</th>
            <th className="px-2 py-1 font-normal" title="Industry concentration (Herfindahl index of market caps). The paper finds the signal is stronger where competition is high.">Competition</th>
            <th className="px-2 py-1 font-normal">Next report</th>
            <th className="px-2 py-1 text-right font-normal">1M</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const days = daysUntil(r.earningsDate, today);
            return (
              <tr key={r.ticker} className="row-hover border-t border-term-border/60 align-top">
                <td className="px-2 py-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-bold text-term-text">{r.ticker}</span>
                    <span className="truncate text-term-dim">{clip(r.name, 30)}</span>
                  </div>
                  <div className="text-[10px] text-term-dim" title={r.products}>
                    {r.sources} · {clip(r.products, 48)}
                  </div>
                  <div className="mt-0.5 max-w-[560px] text-[10px] leading-snug text-term-dim">{r.thesis}</div>
                </td>
                <td className="px-2 py-1">
                  <SignalTag signal={r.signal} />
                </td>
                <td className="px-2 py-1">
                  <ScoreBar score={r.score} />
                </td>
                <td className="px-2 py-1 uppercase text-term-dim">{r.confidence}</td>
                <td className="px-2 py-1 text-right tabular-nums text-term-text">{r.reviews.toLocaleString("en-US")}</td>
                <td className="px-2 py-1 text-right tabular-nums text-term-text">{pct(r.negTone)}</td>
                <td className="px-2 py-1 text-right tabular-nums text-term-text">{pct(r.posTone)}</td>
                <td className={`px-2 py-1 text-right tabular-nums ${r.negToneAbn !== null && r.negToneAbn > 0 ? "text-term-red" : "text-term-green"}`}>
                  {pts(r.negToneAbn)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums text-term-text">{pts(r.negToneChg)}</td>
                <td className="px-2 py-1 text-term-dim">{r.competition ?? "—"}</td>
                <td className="whitespace-nowrap px-2 py-1 text-term-text">
                  {shortDate(r.earningsDate)}
                  {days !== null && <span className="text-term-dim"> · {days}d</span>}
                </td>
                <td className={`px-2 py-1 text-right tabular-nums ${r.ret1m === null ? "text-term-dim" : r.ret1m >= 0 ? "text-term-green" : "text-term-red"}`}>
                  {signed(r.ret1m)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Upcoming({ rows, today }: { rows: PredictivePlay[]; today: string }) {
  const soon = rows
    .filter((r) => r.signal !== "neutral" && r.earningsDate)
    .map((r) => ({ r, days: daysUntil(r.earningsDate, today) ?? 999 }))
    .filter((x) => x.days >= 0 && x.days <= 30)
    .sort((a, b) => a.days - b.days);
  if (!soon.length) return <Empty>No tailwind or headwind name reports in the next 30 days.</Empty>;
  return (
    <div className="divide-y divide-term-border/60 text-[11px]">
      {soon.map(({ r, days }) => (
        <div key={r.ticker} className="flex items-center justify-between gap-2 px-2 py-1">
          <span className="flex items-center gap-2">
            <span className="w-12 font-bold text-term-text">{r.ticker}</span>
            <SignalTag signal={r.signal} />
          </span>
          <span className="whitespace-nowrap tabular-nums text-term-text">
            {shortDate(r.earningsDate)}
            {r.earningsTime && r.earningsTime !== "not supplied" ? <span className="text-term-dim"> · {r.earningsTime}</span> : null}
            <span className="text-term-dim"> · in {days}d</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function TrackRecord({ outcomes }: { outcomes: Outcome[] }) {
  const called = outcomes.filter((o) => o.signal !== "neutral");
  if (!called.length) {
    return (
      <Empty>
        No report has been scored yet. After each covered company reports, compute-predictive records the stock&apos;s move from the
        close before the report to the close after it, minus SPY, against the signal it showed going in. The record builds from
        there — nothing here is backfilled or assumed.
      </Empty>
    );
  }
  const group = (s: Signal) => {
    const g = called.filter((o) => o.signal === s);
    const hits = g.filter((o) => o.hit === true).length;
    const avg = g.length ? g.reduce((a, o) => a + o.abnRet, 0) / g.length : null;
    return { n: g.length, hits, avg };
  };
  const tw = group("tailwind");
  const hw = group("headwind");
  const all = tw.hits + hw.hits;
  return (
    <div className="space-y-2 p-2 text-[11px]">
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Hit rate", value: `${((all / called.length) * 100).toFixed(0)}%`, sub: `${all} of ${called.length} calls` },
          { label: "Tailwind avg vs SPY", value: signed(tw.avg), sub: `${tw.n} reports` },
          { label: "Headwind avg vs SPY", value: signed(hw.avg), sub: `${hw.n} reports` },
        ].map((k) => (
          <div key={k.label} className="border border-term-border bg-term-panel2 px-2 py-1">
            <div className="text-[10px] uppercase text-term-dim">{k.label}</div>
            <div className="text-[15px] font-bold tabular-nums text-term-text">{k.value}</div>
            <div className="text-[10px] text-term-dim">{k.sub}</div>
          </div>
        ))}
      </div>
      <div className="divide-y divide-term-border/60">
        {called.slice(0, 12).map((o) => (
          <div key={`${o.ticker}${o.earningsDate}`} className="flex justify-between gap-2 py-0.5">
            <span className="flex gap-2">
              <span className="w-12 font-bold text-term-text">{o.ticker}</span>
              <SignalTag signal={o.signal} />
            </span>
            <span className="tabular-nums">
              <span className="text-term-dim">{shortDate(o.earningsDate)} · </span>
              <span className={o.abnRet >= 0 ? "text-term-green" : "text-term-red"}>{signed(o.abnRet)} vs SPY</span>
              <span className={o.hit ? "text-term-green" : "text-term-red"}> {o.hit ? "✓" : "✗"}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Quote({ q }: { q: ReviewQuote }) {
  const stars = q.source === "Steam" ? (q.stars >= 3 ? "👍 recommended" : "👎 not recommended") : `${"★".repeat(q.stars)}${"☆".repeat(Math.max(0, 5 - q.stars))}`;
  return (
    <blockquote className={`border-l-2 pl-2 ${q.tone === "negative" ? "border-term-red" : "border-term-green"}`}>
      <div className="text-[10px] text-term-dim">
        {q.source} · {stars} · {q.postedAt.slice(0, 10)}
      </div>
      <div className="text-[11px] leading-snug text-term-text">
        {q.title ? <span className="font-semibold">{clip(q.title, 80)} — </span> : null}
        {clip(q.body, 240)}
      </div>
    </blockquote>
  );
}

function Voices({ rows, quotes }: { rows: PredictivePlay[]; quotes: Map<string, ReviewQuote[]> }) {
  const tail = rows.filter((r) => r.signal === "tailwind").slice(0, 3);
  const head = rows.filter((r) => r.signal === "headwind").slice(-3).reverse();
  const picks = [...tail, ...head].filter((r) => quotes.get(r.ticker)?.length);
  if (!picks.length) return <Empty>No review samples yet.</Empty>;
  return (
    <div className="grid grid-cols-1 gap-[3px] p-[3px] md:grid-cols-2 xl:grid-cols-3">
      {picks.map((r) => {
        const qs = quotes.get(r.ticker) ?? [];
        const order = r.signal === "headwind" ? ["negative", "positive"] : ["positive", "negative"];
        qs.sort((a, b) => order.indexOf(a.tone) - order.indexOf(b.tone));
        return (
          <div key={r.ticker} className="space-y-1.5 border border-term-border bg-term-panel p-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-term-text">
                {r.ticker} <span className="font-normal text-term-dim">{clip(r.name, 26)}</span>
              </span>
              <SignalTag signal={r.signal} />
            </div>
            {qs.map((q) => (
              <Quote key={q.tone} q={q} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Predictive Plays tab: companies whose customers' review language leans
 * unusually negative or positive ahead of their next report.
 */
export default function PredictivePlays({ data }: { data: PredictiveData }) {
  const { plays, quotes, outcomes, error } = data;
  const signaled = plays.filter((p) => p.reviews >= MIN_REVIEWS);
  const building = plays.filter((p) => p.reviews < MIN_REVIEWS).sort((a, b) => b.reviews - a.reviews);
  const tail = signaled.filter((p) => p.signal === "tailwind").length;
  const head = signaled.filter((p) => p.signal === "headwind").length;
  const asOf = plays.reduce((m, p) => (p.asOf > m ? p.asOf : m), "");
  const today = new Date().toISOString().slice(0, 10);
  const baseline = signaled.some((p) => p.negToneChg !== null);

  return (
    <div className="flex flex-col gap-[3px]">
      <Panel
        title="Predictive Plays — Consumer Review Tone"
        controls={
          <>
            <Chip active>{signaled.length} with signal</Chip>
            <Chip active>
              <span className="text-term-green">{tail} tailwind</span> · <span className="text-term-red">{head} headwind</span>
            </Chip>
            <Chip>as of {asOf || "—"}</Chip>
          </>
        }
      >
        <div className="border-b border-term-border px-2 py-1.5 text-[11px] leading-relaxed text-term-dim">
          What customers write predicts what a company reports. Following{" "}
          <a href={PAPER_URL} target="_blank" rel="noreferrer" className="text-term-cyan hover:underline">
            Jin (2023), University of Michigan-Dearborn
          </a>
          , every review of each company&apos;s apps and games is scored for negative and positive tone, compared with reviews that gave
          the same star rating, and adjusted for rating, review volume and rating dispersion. Unusually <span className="text-term-red">negative</span>{" "}
          language — the stronger predictor in the study — points to weaker sales and a downside earnings surprise.
          {!baseline && (
            <span className="text-term-amber">
              {" "}
              Each company&apos;s own 56-day baseline is still building, so scores currently compare companies with each other only.
            </span>
          )}
        </div>
        {error && <div className="px-2 py-1 text-[11px] text-term-red">{error}</div>}
        {signaled.length ? (
          <SignalTable rows={signaled} today={today} />
        ) : (
          <Empty>No company has {MIN_REVIEWS} reviews in the window yet. sync-reviews collects new reviews every 20 minutes.</Empty>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-[3px] lg:grid-cols-2">
        <Panel title="Reporting Soon" controls={<Chip>next 30 days · Nasdaq calendar</Chip>}>
          <Upcoming rows={signaled} today={today} />
        </Panel>
        <Panel title="Track Record" controls={<Chip>report-day move vs SPY</Chip>}>
          <TrackRecord outcomes={outcomes} />
        </Panel>
      </div>

      <Panel title="What Reviewers Are Saying" controls={<Chip>newest scored reviews</Chip>}>
        <Voices rows={signaled} quotes={quotes} />
      </Panel>

      {building.length > 0 && (
        <Panel title="Building Coverage" controls={<Chip>{building.length} companies below {MIN_REVIEWS} reviews</Chip>}>
          <div className="flex flex-wrap gap-1 p-2 text-[10px]">
            {building.map((p) => (
              <span key={p.ticker} className="border border-term-border px-1 text-term-dim" title={`${p.name} · ${p.products}`}>
                <span className="text-term-text">{p.ticker}</span> {p.reviews}
              </span>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Method" controls={<Chip>Jin (2023) · JBFA 50(9-10)</Chip>}>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 p-2 text-[11px] leading-relaxed text-term-dim md:grid-cols-2">
          <p>
            <span className="text-term-text">The study.</span> Using a broad sample of Amazon.com product reviews, Jin finds that review tone
            predicts a firm&apos;s next-quarter sales, earnings surprises, announcement returns and risk; that negative tone carries more
            information than positive tone; that the effect is stronger in highly competitive industries; and that it holds after
            controlling for review rating, volume and dispersion.
          </p>
          <p>
            <span className="text-term-text">The data here.</span> Amazon offers no public access to its reviews, so the terminal reads the
            same kind of signal from customer reviews on Apple&apos;s App Store (public RSS feed) and Steam (public review API) for the apps
            and games each company sells. Tone uses the Hu &amp; Liu opinion lexicon with negation handling.
          </p>
          <p>
            <span className="text-term-text">The score.</span> Over the last 28 days: tone minus what same-star reviews show across the
            universe, regressed on rating, log volume and dispersion; 0.65 × lower negative tone + 0.35 × higher positive tone in standard
            deviations, blended 60/40 with the change against the firm&apos;s prior 56 days once that exists, and scaled to 0.85 / 0.7 in
            moderately concentrated / concentrated industries. Tailwind ≥ +0.5, headwind ≤ −0.5; at least {MIN_REVIEWS} reviews needed.
          </p>
          <p>
            <span className="text-term-text">Limits.</span> App and game reviews cover part of each business (marked core or channel), the
            App Store feed shows the newest reviews in the US store only, and the paper&apos;s results are averages across many firms, not a
            promise for any one report. The track record above is measured on this data as reports come in.
          </p>
        </div>
      </Panel>
    </div>
  );
}
