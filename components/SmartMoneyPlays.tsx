"use client";

import type { SmartMoneyPlay, Evidence } from "@/lib/smartmoney";
import type { InsiderSummary } from "@/lib/smartmoney/sec";
import { money } from "@/lib/ta";
import SetupBlock, { StatusChip } from "@/components/SetupBlock";
import { useInsiders, useSmartMoney } from "@/components/useSmartMoney";

const fmtBig = (x: number) =>
  x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}K` : `$${x.toFixed(0)}`;
const pct = (v: number | null, d = 0) => (v === null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const tone = (v: number | null) => (v === null ? "text-term-dim" : v > 0 ? "text-term-green" : v < 0 ? "text-term-red" : "text-term-text");

export function scoreTone(s: number) {
  return s >= 70 ? "text-term-green border-term-green/50" : s >= 57 ? "text-term-cyan border-term-cyan/50" : s > 43 ? "text-term-yellow border-term-yellow/50" : "text-term-red border-term-red/50";
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 200, H = 40;
  const mn = Math.min(...values), mx = Math.max(...values), pad = (mx - mn) * 0.08 || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - ((v - mn + pad) / (mx - mn + 2 * pad)) * H]);
  const line = "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L ");
  const e = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-10 w-[46%]" aria-hidden>
      <path d={`${line} L ${W},${H} L 0,${H} Z`} fill="#6cb33f" opacity={0.12} />
      <path d={line} fill="none" stroke="#6cb33f" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <circle cx={e[0]} cy={e[1]} r={2.4} fill="#6cb33f" />
    </svg>
  );
}

const ICON = { ok: "✓", pending: "…", fail: "✕" } as const;
const TONE = {
  ok: "text-term-green border-term-green/50",
  pending: "text-term-yellow border-term-yellow/50",
  fail: "text-term-red border-term-red/50",
} as const;

function EvidenceList({ items }: { items: Evidence[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 border border-term-border p-2">
      {items.map((e, i) => (
        <li key={i} className="flex items-start gap-2 text-[11px] leading-snug">
          <span className={`mt-px inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center border text-[9px] font-bold ${TONE[e.state]}`}>
            {ICON[e.state]}
          </span>
          <span>
            <span className="font-semibold text-term-text">{e.label}</span>
            <span className="block text-term-dim">{e.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function InsiderLine({ s }: { s: InsiderSummary | undefined }) {
  if (!s) return <span className="text-term-dim">Checking SEC Form 4 filings…</span>;
  if (s.error) return <span className="text-term-dim">Insiders: {s.error}</span>;
  if (s.buys.length === 0 && s.sells.length === 0)
    return <span className="text-term-dim">Insiders: no open-market buys or sells in {s.windowDays} days ({s.filingsChecked} Form 4s checked).</span>;
  return (
    <span className={s.buys.length ? "text-term-green" : "text-term-dim"}>
      Insiders ({s.windowDays}d):{" "}
      {s.buys.length ? `${s.buys.length} open-market buy${s.buys.length > 1 ? "s" : ""} (${fmtBig(s.buyValue)})` : "no open-market buys"}
      {s.sells.length ? `, ${s.sells.length} sale${s.sells.length > 1 ? "s" : ""} (${fmtBig(s.sellValue)})` : ""}.
      {s.buys[0] && ` Latest buy: ${s.buys[0].name}, ${s.buys[0].role}, ${s.buys[0].date}.`}
    </span>
  );
}

function PlayCard({ p, insider }: { p: SmartMoneyPlay; insider: InsiderSummary | undefined }) {
  const A = p.analysis;
  const s = A?.primary ?? null;
  const alt = A ? A.setups.slice(1) : [];
  return (
    <article className="flex min-w-0 flex-col gap-2 border border-term-border bg-term-panel p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[18px] font-bold leading-none text-term-text">{p.symbol}</span>
            <span className={`border px-1 font-mono text-[10px] font-semibold ${scoreTone(p.score)}`} title="Smart money score, 0-100">
              SM {p.score}
            </span>
          </div>
          <div className="mt-1 truncate text-[11.5px] text-term-text">{p.name}</div>
          <div className="text-[10.5px] text-term-dim">{p.flow.label} · {p.options?.label ?? "no options data"}</div>
        </div>
        {s && <StatusChip status={s.status} />}
      </div>

      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="font-mono text-[20px] font-semibold tabular-nums text-term-text">{money(p.flow.last)}</div>
          <div className="text-[10px] text-term-dim">
            Close {p.flow.date} · {p.source === "snapshot" ? "snapshot bars" : `live · ${p.source}`}
          </div>
        </div>
        <Spark values={p.closes} />
      </div>

      <div className="grid grid-cols-3 border border-term-border sm:grid-cols-6">
        {[
          ["Flow", String(p.flow.score), "text-term-text"],
          ["Options", p.options ? String(p.options.score) : "—", "text-term-text"],
          ["CMF", `${p.flow.cmf >= 0 ? "+" : ""}${p.flow.cmf.toFixed(2)}`, tone(p.flow.cmf)],
          ["1M", pct(p.flow.r1m), tone(p.flow.r1m)],
          ["vs SPY 3M", pct(p.rs3m), tone(p.rs3m)],
          ["RVOL 5d", `${p.flow.relVol5.toFixed(1)}×`, "text-term-text"],
        ].map(([k, v, c]) => (
          <div key={k} className="border-l border-term-border px-2 py-1 first:border-l-0">
            <div className="text-[9.5px] uppercase tracking-wide text-term-dim">{k}</div>
            <div className={`font-mono text-[12px] tabular-nums ${c}`}>{v}</div>
          </div>
        ))}
      </div>

      <div className="text-[9.5px] font-semibold uppercase tracking-wider text-term-dim">Why smart money is here</div>
      <p className="m-0 text-[11.5px] leading-relaxed text-term-text">{p.thesis}</p>
      <EvidenceList items={p.evidence} />
      <div className="text-[11px] leading-snug">
        <InsiderLine s={insider} />
      </div>

      {A && (
        <>
          <div className="text-[9.5px] font-semibold uppercase tracking-wider text-term-dim">Technical setup</div>
          {s ? (
            <SetupBlock s={s} />
          ) : (
            <div className="border border-dashed border-term-borderStrong px-2 py-2 text-[11.5px] text-term-dim">
              <span className="font-semibold text-term-text">No active setup. </span>
              {A.noSetup}
            </div>
          )}
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
        </>
      )}

      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="text-[10px] text-term-dim">{A ? A.trend : ""}</span>
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

/** The Smart Money plays section of the Plays tab (replaces the leveraged-ETF plays). */
export default function SmartMoneyPlays() {
  const { data, error, loading } = useSmartMoney();
  const symbols = data ? data.plays.map((p) => p.symbol) : [];
  const ins = useInsiders(symbols);
  const insBy = new Map((ins.data?.results ?? []).map((r) => [r.symbol, r]));

  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="m-0 flex items-center gap-2 text-[13px] font-bold uppercase tracking-wide text-term-text">
          <span className="border border-term-brand/60 px-1 font-mono text-[10px] text-term-brand">SMART $</span>
          Smart money plays
        </h2>
        <p className="m-0 mt-0.5 text-term-dim">
          Large-cap stocks where volume flow, options positioning and trend all point the same way: money is accumulating
          the stock, options traders are paying up for calls, and price is above its 50- and 200-day averages. Insider (SEC
          Form 4) and congressional trades are shown as supporting evidence. Full detail is on the{" "}
          <a href="#smart" className="text-term-cyan hover:underline">
            Smart Money tab
          </a>
          .
        </p>
      </div>
      {loading && <div className="border border-term-border px-2 py-3 text-[11.5px] text-term-dim">Scanning money flow and options positioning…</div>}
      {error && <div className="border border-term-red/50 bg-term-red/10 px-2 py-2 text-[11.5px]">Smart money data didn&apos;t load: {error}</div>}
      {data && data.plays.length === 0 && (
        <div className="border border-term-border px-2 py-3 text-[11.5px] text-term-dim">
          No large cap passes every smart-money check today (accumulation, bullish options and uptrend together). See the Smart
          Money tab for where flows are leaning.
        </div>
      )}
      {data && data.plays.length > 0 && (
        <>
          <div className="text-[10.5px] text-term-dim">
            Bars through {data.barsAsOf} · options &amp; congress feed as of {data.feedAsOf} ({data.feedSource}) · insider data from SEC EDGAR
          </div>
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {data.plays.map((p) => (
              <PlayCard key={p.symbol} p={p} insider={ins.loading ? undefined : insBy.get(p.symbol) ?? { symbol: p.symbol, windowDays: 90, filingsChecked: 0, buys: [], sells: [], buyValue: 0, sellValue: 0, error: ins.error ?? "No SEC response" }} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Overview rows: one line per smart money play. */
export function SmartMoneySummary() {
  const { data, error, loading } = useSmartMoney();
  if (loading) return <div className="px-2 py-2 text-[11px] text-term-dim">Scanning money flow…</div>;
  if (error || !data) return <div className="px-2 py-2 text-[11px] text-term-red">Smart money data didn&apos;t load{error ? `: ${error}` : ""}.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-[10px] uppercase text-term-dim">
            <th className="px-2 py-1 font-normal">Symbol</th>
            <th className="px-2 py-1 font-normal">Smart money</th>
            <th className="px-2 py-1 text-right font-normal">Close</th>
            <th className="px-2 py-1 text-right font-normal">Entry</th>
            <th className="px-2 py-1 text-right font-normal">Stop</th>
            <th className="px-2 py-1 text-right font-normal">TP 1</th>
            <th className="px-2 py-1 text-right font-normal">TP 2</th>
          </tr>
        </thead>
        <tbody>
          {data.plays.map((p) => {
            const s = p.analysis?.primary ?? null;
            return (
              <tr key={p.symbol} className="row-hover border-t border-term-border/60">
                <td className="px-2 py-1">
                  <a href={`#chart/${p.symbol}`} className="font-mono font-bold text-term-text hover:text-term-cyan">
                    {p.symbol}
                  </a>
                </td>
                <td className="px-2 py-1">
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className={`border px-1 font-mono text-[10px] ${scoreTone(p.score)}`}>SM {p.score}</span>
                    <span className="text-term-dim">{p.flow.label}</span>
                    {s && <StatusChip status={s.status} />}
                  </span>
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">{money(p.flow.last)}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-term-cyan">{s ? money(s.entry) : ""}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-term-red">{s ? money(s.stop) : ""}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-term-green">{s ? money(s.tp1) : ""}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-term-green">{s ? money(s.tp2) : ""}</td>
              </tr>
            );
          })}
          {data.plays.length === 0 && (
            <tr>
              <td colSpan={7} className="px-2 py-2 text-term-dim">No stock passes every smart-money check today.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
