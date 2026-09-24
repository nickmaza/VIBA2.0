import type { Analysis, Setup } from "@/lib/ta";
import { money } from "@/lib/ta";

export const STATUS_LABEL: Record<Setup["status"], string> = {
  confirmed: "Confirmed",
  pending: "Needs confirmation",
  waiting: "Waiting for entry",
};

export function statusClass(s: Setup["status"]) {
  if (s === "confirmed") return "border-term-green/50 bg-term-green/10 text-term-green";
  if (s === "pending") return "border-term-yellow/50 bg-term-yellow/10 text-term-yellow";
  return "border-term-amber/50 bg-term-amber/10 text-term-amber";
}

export function StatusChip({ status }: { status: Setup["status"] }) {
  return (
    <span className={`whitespace-nowrap border px-1.5 text-[10px] font-semibold uppercase leading-[16px] ${statusClass(status)}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

const CHECK_TAG = { ok: "Confirmed", pending: "Needs to confirm", fail: "Not met" } as const;
const CHECK_ICON = { ok: "✓", pending: "…", fail: "✕" } as const;
const CHECK_TONE = {
  ok: "text-term-green border-term-green/50",
  pending: "text-term-yellow border-term-yellow/50",
  fail: "text-term-red border-term-red/50",
} as const;

function pct(v: number) {
  return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}

function Cell({ k, tone, v, sub }: { k: string; tone: string; v: string; sub: string }) {
  return (
    <div className="border-l border-t border-term-border px-2 py-1.5 first:border-l-0">
      <div className="flex items-center gap-1 text-[9.5px] uppercase tracking-wide text-term-dim">
        <span className={`inline-block h-[3px] w-2 ${tone}`} />
        {k}
      </div>
      <div className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-term-text">{v}</div>
      <div className="font-mono text-[10px] tabular-nums text-term-dim">{sub}</div>
    </div>
  );
}

/**
 * One trade plan: entry, stop, TP1/TP2, reward:risk, how to enter, the
 * confirmed-vs-pending checklist, the reasoning, and what invalidates it.
 * Shared by the Plays board (server) and Chart & Search (client).
 */
export default function SetupBlock({ s }: { s: Setup }) {
  const short = s.side === "short";
  return (
    <div className="border border-term-borderStrong bg-term-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-term-panel2 px-2 py-1.5">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-term-text">
          <span
            className={`border px-1 font-mono text-[9.5px] leading-[14px] ${
              short ? "border-term-red/50 text-term-red" : "border-term-green/50 text-term-green"
            }`}
          >
            {short ? "SHORT" : "LONG"}
          </span>
          {s.name}
        </span>
        <StatusChip status={s.status} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5">
        <Cell k="Entry" tone="bg-term-cyan" v={money(s.entry)} sub={" "} />
        <Cell k="Stop loss" tone="bg-term-red" v={money(s.stop)} sub={pct(s.stopPct)} />
        <Cell k="TP 1" tone="bg-term-green" v={money(s.tp1)} sub={pct(s.tp1Pct)} />
        <Cell k="TP 2" tone="bg-term-green" v={money(s.tp2)} sub={pct(s.tp2Pct)} />
        <Cell k="Reward : risk" tone="bg-term-dim" v={`${s.rr1.toFixed(1)} / ${s.rr2.toFixed(1)}`} sub="TP1 / TP2" />
      </div>
      <div className="border-t border-term-border px-2 py-1.5 text-[11px] text-term-dim">
        <span className="font-semibold text-term-text">How to enter: </span>
        {s.entryType}. Risk is {money(s.risk)} per share ({Math.abs(s.stopPct).toFixed(1)}%).
      </div>
      <ul className="flex flex-col gap-1 border-t border-term-border px-2 py-1.5">
        {s.checks.map((c, i) => (
          <li key={i} className="flex items-start gap-2 text-[11px] leading-snug">
            <span
              className={`mt-px inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center border text-[9px] font-bold ${CHECK_TONE[c.state]}`}
            >
              {CHECK_ICON[c.state]}
            </span>
            <span className="text-term-text">{c.label}</span>
            <span className="ml-auto whitespace-nowrap pl-2 text-[9.5px] uppercase tracking-wide text-term-dim">
              {CHECK_TAG[c.state]}
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 border-t border-term-border px-2 py-1.5 text-[11.5px] leading-relaxed text-term-text">{s.why}</p>
      <p className="m-0 px-2 pb-2 text-[11px] leading-relaxed text-term-dim">
        <span className="font-semibold text-term-red">Invalidation: </span>
        {s.invalid}
      </p>
    </div>
  );
}

export function NoSetup({ a }: { a: Analysis }) {
  return (
    <div className="border border-dashed border-term-borderStrong px-2 py-2 text-[11.5px] leading-relaxed text-term-dim">
      <span className="font-semibold text-term-text">No active setup. </span>
      {a.noSetup}
    </div>
  );
}
