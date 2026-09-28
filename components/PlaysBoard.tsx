import type { ReactNode } from "react";
import type { Analysis } from "@/lib/ta";
import { money } from "@/lib/ta";
import type { Play, WatchItem } from "@/lib/plays";
import { EXCLUDED_INDEX_PRODUCTS } from "@/lib/plays";
import SetupBlock, { NoSetup, StatusChip } from "@/components/SetupBlock";

export interface PlayView {
  play: Play;
  analysis: Analysis | null;
  closes: number[];
}

export interface WatchView {
  item: WatchItem;
  analysis: Analysis | null;
}

function pct(v: number | null, d = 0) {
  if (v === null || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(d) + "%";
}
function tone(v: number | null) {
  if (v === null) return "text-term-dim";
  return v > 0 ? "text-term-green" : v < 0 ? "text-term-red" : "text-term-text";
}

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const W = 200, H = 40;
  const mn = Math.min(...values), mx = Math.max(...values), pad = (mx - mn) * 0.08 || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - ((v - mn + pad) / (mx - mn + 2 * pad)) * H]);
  const line = "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L ");
  const e = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-10 w-[46%]" aria-hidden>
      <path d={`${line} L ${W},${H} L 0,${H} Z`} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <circle cx={e[0]} cy={e[1]} r={2.4} fill={color} />
    </svg>
  );
}

function Metric({ k, v, cls = "text-term-text" }: { k: string; v: string; cls?: string }) {
  return (
    <div className="border-l border-term-border px-2 py-1 first:border-l-0">
      <div className="text-[9.5px] uppercase tracking-wide text-term-dim">{k}</div>
      <div className={`font-mono text-[12px] tabular-nums ${cls}`}>{v}</div>
    </div>
  );
}

function PlayCard({ v }: { v: PlayView }) {
  const { play: p, analysis: A } = v;
  const color = p.kind === "stock" ? "#4fb3e8" : "#f5c542";
  const s = A?.primary ?? null;
  const alt = A ? A.setups.slice(1) : [];
  return (
    <article className="flex min-w-0 flex-col gap-2 border border-term-border bg-term-panel p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[18px] font-bold leading-none text-term-text">{p.symbol}</div>
          <div className="mt-1 truncate text-[11.5px] text-term-text">{p.name}</div>
          <div className="text-[10.5px] text-term-dim">{p.sector}</div>
        </div>
        {s && <StatusChip status={s.status} />}
      </div>

      {A ? (
        <>
          <div className="flex items-end justify-between gap-2">
            <div>
              <div className="font-mono text-[20px] font-semibold tabular-nums text-term-text">{money(A.ind.close)}</div>
              <div className="text-[10px] text-term-dim">
                Close {A.ind.date} · {A.ind.offHi > -0.5 ? "at 52-week high" : `${pct(A.ind.offHi, 1)} from 52-wk high`} · Supabase
              </div>
            </div>
            <Spark values={v.closes} color={color} />
          </div>
          <div className="grid grid-cols-3 border border-term-border sm:grid-cols-6">
            <Metric k="Score" v={p.score.toFixed(2)} />
            <Metric k="1M" v={pct(A.ind.r1m)} cls={tone(A.ind.r1m)} />
            <Metric k="3M" v={pct(A.ind.r3m)} cls={tone(A.ind.r3m)} />
            <Metric k="12M" v={pct(A.ind.r12m)} cls={tone(A.ind.r12m)} />
            <Metric k="RSI" v={A.ind.rsi.toFixed(0)} />
            <Metric k="ATR" v={money(A.ind.atr)} />
          </div>
        </>
      ) : (
        <div className="text-[11px] text-term-amber">Price history unavailable right now, so no setup could be computed.</div>
      )}

      <div className="flex flex-col gap-1">
        <div className="text-[9.5px] font-semibold uppercase tracking-wider text-term-dim">The case</div>
        <p className="m-0 text-[11.5px] leading-relaxed text-term-text">{p.thesis}</p>
        <div className="mt-1 text-[9.5px] font-semibold uppercase tracking-wider text-term-dim">Chart read</div>
        <p className="m-0 text-[11.5px] leading-relaxed text-term-dim">{p.chartRead}</p>
      </div>

      {A && (
        <>
          <div className="text-[9.5px] font-semibold uppercase tracking-wider text-term-dim">Technical setup</div>
          {s ? <SetupBlock s={s} /> : <NoSetup a={A} />}
          {alt.length > 0 && (
            <details className="text-[11px]">
              <summary className="cursor-pointer text-term-cyan">
                {alt.length} other setup{alt.length > 1 ? "s" : ""} on this chart
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                {alt.map((x) => (
                  <SetupBlock key={x.key} s={x} />
                ))}
              </div>
            </details>
          )}
          <details className="text-[11px]">
            <summary className="cursor-pointer text-term-cyan">Full technical read</summary>
            {A.narrative.map((t, i) => (
              <p key={i} className="mb-0 mt-1.5 leading-relaxed text-term-dim">
                {t}
              </p>
            ))}
          </details>
        </>
      )}

      <p className="m-0 border-l-2 border-term-amber pl-2 text-[11px] leading-snug text-term-dim">{p.risk}</p>

      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="text-[10px] text-term-dim">
          {A ? `${A.trend} · vol ${p.vol}%` : ""}
        </span>
        <a
          href={`#chart/${p.symbol}`}
          className="border border-term-cyan/60 bg-term-cyan/10 px-2 py-0.5 text-[11px] font-semibold text-term-cyan hover:bg-term-cyan/20"
        >
          Open chart →
        </a>
      </div>
    </article>
  );
}

/**
 * The VIBA plays: stock plays with the written case plus the engine's setup
 * and exact levels, then the Smart Money plays section (passed in as
 * `secondary`, it loads client-side), then a watchlist.
 */
export default function PlaysBoard({
  stocks,
  watchlist,
  asOf,
  generatedAt,
  error,
  secondary,
}: {
  stocks: PlayView[];
  watchlist: WatchView[];
  asOf: string | null;
  generatedAt: string | null;
  error: string | null;
  secondary?: ReactNode;
}) {
  const computed = generatedAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(generatedAt)) + " ET"
    : null;
  return (
    <div className="flex flex-col gap-3 p-2 text-[11px]">
      <div className="border border-term-cyan/40 bg-term-cyan/[0.06] px-2 py-1.5 leading-relaxed text-term-dim">
        <span className="font-semibold text-term-text">How to read a play. </span>
        Each play has a trade plan computed from its own chart: an <b className="text-term-cyan">entry</b>, a{" "}
        <b className="text-term-red">stop loss</b> where the idea is wrong, and two take-profit targets (
        <b className="text-term-green">TP 1</b> and <b className="text-term-green">TP 2</b>). The checklist shows which
        conditions are <span className="text-term-green">confirmed</span> and which still{" "}
        <span className="text-term-yellow">need to confirm</span> before the entry is valid. The plays, and every word of
        each case, are generated in Supabase by the compute-plays function from the{" "}
        {asOf ?? "latest"} session{computed ? ` (last run ${computed})` : ""}; the levels on each card recompute from the
        latest bars.
      </div>

      <section className="flex flex-col gap-2">
        <div>
          <h2 className="m-0 flex items-center gap-2 text-[13px] font-bold uppercase tracking-wide text-term-text">
            <span className="border border-term-cyan/60 px-1 font-mono text-[10px] text-term-cyan">STOCKS</span>
            Stock plays
          </h2>
          <p className="m-0 mt-0.5 text-term-dim">
            Individual companies from the top three sectors on risk-adjusted momentum. Each one trades above its 50- and
            200-day averages on at least $50M a day, and ranks highest in its sector on average 3/6/12-month return per unit
            of volatility. Two names per sector.
          </p>
        </div>
        {error && (
          <div className="border border-term-red/50 bg-term-red/10 px-2 py-2 text-[11.5px]">Stock plays didn&apos;t load: {error}</div>
        )}
        {!error && stocks.length === 0 && (
          <div className="border border-term-border px-2 py-3 text-[11.5px] text-term-dim">
            No stock in the leading sectors passes every rule right now (above the 50- and 200-day averages, $50M+ a day,
            a year of history), so there are no stock plays. The screen reruns every 30 minutes in the session.
          </div>
        )}
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {stocks.map((v) => (
            <PlayCard key={v.play.symbol} v={v} />
          ))}
        </div>
      </section>

      {secondary}

      <div className="flex flex-wrap items-center gap-1 text-[10.5px] text-term-dim">
        <span>Excluded by rule, no index products:</span>
        {EXCLUDED_INDEX_PRODUCTS.map((s) => (
          <span key={s} className="border border-term-border px-1 font-mono text-term-dim line-through">
            {s}
          </span>
        ))}
      </div>

      <section className="flex flex-col gap-1">
        <h2 className="m-0 text-[13px] font-bold uppercase tracking-wide text-term-text">Watchlist</h2>
        <p className="m-0 text-term-dim">
          The next name in each leading sector, held back to keep two plays per sector. The setup column is what the engine
          sees in the latest bars.
        </p>
        <div className="overflow-x-auto border border-term-border">
          <table className="w-full min-w-[760px] border-collapse text-[11px]">
            <thead>
              <tr className="bg-term-panel2 text-left text-[10px] uppercase text-term-dim">
                <th className="px-2 py-1 font-normal">Symbol</th>
                <th className="px-2 py-1 font-normal">Type</th>
                <th className="px-2 py-1 text-right font-normal">Close</th>
                <th className="px-2 py-1 font-normal">Setup</th>
                <th className="px-2 py-1 text-right font-normal">Entry</th>
                <th className="px-2 py-1 text-right font-normal">Stop</th>
                <th className="px-2 py-1 text-right font-normal">TP 1</th>
                <th className="px-2 py-1 font-normal">Why it&apos;s on watch</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {watchlist.map(({ item, analysis: A }) => {
                const s = A?.primary ?? null;
                return (
                  <tr key={item.symbol} className="row-hover border-t border-term-border/60">
                    <td className="px-2 py-1 font-mono font-bold text-term-text">{item.symbol}</td>
                    <td className="px-2 py-1 text-term-cyan">Stock</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{A ? money(A.ind.close) : "—"}</td>
                    <td className="px-2 py-1">{s ? s.name : <span className="text-term-dim">No setup</span>}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-term-cyan">{s ? money(s.entry) : ""}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-term-red">{s ? money(s.stop) : ""}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-term-green">{s ? money(s.tp1) : ""}</td>
                    <td className="max-w-[340px] px-2 py-1 text-term-dim">{item.note}</td>
                    <td className="px-2 py-1 text-right">
                      <a href={`#chart/${item.symbol}`} className="text-term-cyan hover:underline">
                        Chart →
                      </a>
                    </td>
                  </tr>
                );
              })}
              {watchlist.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-2 py-2 text-term-dim">
                    No watchlist names right now.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** Compact one-line-per-play table for the Overview tab. */
export function PlaysSummary({ rows }: { rows: { label: string; items: PlayView[] }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase text-term-dim">
            <th className="px-2 py-1 font-normal">Symbol</th>
            <th className="px-2 py-1 font-normal">Setup</th>
            <th className="px-2 py-1 text-right font-normal">Close</th>
            <th className="px-2 py-1 text-right font-normal">Entry</th>
            <th className="px-2 py-1 text-right font-normal">Stop</th>
            <th className="px-2 py-1 text-right font-normal">TP 1</th>
            <th className="px-2 py-1 text-right font-normal">TP 2</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => [
            <tr key={g.label} className="bg-term-panel2">
              <td colSpan={7} className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-term-amber">
                {g.label}
              </td>
            </tr>,
            ...g.items.map(({ play: p, analysis: A }) => {
              const s = A?.primary ?? null;
              return (
                <tr key={p.symbol} className="row-hover border-t border-term-border/60">
                  <td className="px-2 py-1">
                    <a href={`#chart/${p.symbol}`} className="font-mono font-bold text-term-text hover:text-term-cyan">
                      {p.symbol}
                    </a>
                  </td>
                  <td className="px-2 py-1">
                    {s ? (
                      <span className="flex items-center gap-1.5 whitespace-nowrap">
                        <span className="text-term-text">{s.name.replace(/ \(.*\)| — .*/, "")}</span>
                        <StatusChip status={s.status} />
                      </span>
                    ) : (
                      <span className="text-term-dim">No setup</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">{A ? money(A.ind.close) : "—"}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-term-cyan">{s ? money(s.entry) : ""}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-term-red">{s ? money(s.stop) : ""}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-term-green">{s ? money(s.tp1) : ""}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-term-green">{s ? money(s.tp2) : ""}</td>
                </tr>
              );
            }),
            ...(g.items.length === 0
              ? [
                  <tr key={`${g.label}-none`}>
                    <td colSpan={7} className="px-2 py-2 text-term-dim">
                      No stock passes the play rules right now.
                    </td>
                  </tr>,
                ]
              : []),
          ])}
        </tbody>
      </table>
    </div>
  );
}
