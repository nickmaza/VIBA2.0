import type { RegimeSnapshotRow } from "@/lib/types";
import { REGIME_LEGS } from "@/lib/instruments";
import { bucketColor, bucketBg } from "@/components/QuoteCard";

function fmtZ(v: number | null | undefined) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return (v >= 0 ? "+" : "") + v.toFixed(2);
}
function zColor(v: number | null | undefined) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "text-term-dim";
  return v >= 0 ? "text-term-green" : "text-term-red";
}

function ZBar({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="relative block h-1.5 w-full bg-term-panel2" />;
  }
  const clamped = Math.max(-3, Math.min(3, value));
  const pct = (Math.abs(clamped) / 3) * 50;
  const pos = clamped >= 0;
  return (
    <span className="relative block h-1.5 w-full bg-term-panel2">
      <span
        className={`absolute top-0 bottom-0 ${pos ? "bg-term-green" : "bg-term-red"}`}
        style={pos ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
      />
      <span className="absolute top-0 bottom-0 left-1/2 w-px bg-term-borderStrong" />
    </span>
  );
}

/**
 * "Multi-leg ticket" view of the composite regime score: the five weighted
 * legs, what each one reads, its weight, and its current z-score for every
 * index side by side -- so exactly what's being tracked is visible, not just
 * the blended number. Legs 2-5 are market-wide (identical for SPY/QQQ/IWM);
 * leg 1 (trend) is index-specific.
 */
export default function GaugePanel({ snapshot }: { snapshot: RegimeSnapshotRow[] }) {
  const order = ["SPY", "QQQ", "IWM"];
  const snaps = order
    .map((s) => snapshot.find((r) => r.index_symbol === s))
    .filter((r): r is RegimeSnapshotRow => Boolean(r));

  // Static class string on purpose: Tailwind only generates classes it can
  // find verbatim in the source, so this can't be built from snaps.length.
  const cols = "grid-cols-[minmax(76px,1fr)_30px_54px_54px_54px]";

  return (
    <div className="text-[11px]">
      {/* ticket header: which symbols are on the ticket */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-2 py-1 text-[10px]">
        <span className="uppercase text-term-dim">Symbol</span>
        {snaps.map((s) => (
          <span key={s.index_symbol} className="border border-term-borderStrong bg-term-panel px-1.5 py-px font-bold">
            {s.index_symbol}
          </span>
        ))}
        <span className="ml-auto uppercase text-term-dim">Strategy</span>
        <span className="border border-term-borderStrong bg-term-panel px-1.5 py-px">Composite z</span>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[280px]">
          <div className={`grid ${cols} items-center gap-x-1 border-b border-term-border px-2 py-1 text-[10px] uppercase text-term-dim`}>
            <span>Leg · reads</span>
            <span className="text-right">Wt</span>
            {snaps.map((s) => (
              <span key={s.index_symbol} className="text-right">
                {s.index_symbol} z
              </span>
            ))}
          </div>

          {REGIME_LEGS.map((leg) => (
            <div
              key={leg.key}
              className={`row-hover grid ${cols} items-center gap-x-1 border-b border-term-border/60 px-2 py-1`}
            >
              <span className="min-w-0 leading-tight">
                <span className="block font-semibold text-term-text">
                  <span className="text-term-dim">{leg.leg} · </span>
                  {leg.label}
                  {!leg.perIndex && <span className="ml-1 text-[9px] font-normal text-term-dim">mkt-wide</span>}
                </span>
                <span className="block truncate text-[10px] text-term-dim">{leg.inputs}</span>
              </span>
              <span className="text-right tabular-nums text-term-text">{Math.round(leg.weight * 100)}%</span>
              {snaps.map((s) => {
                const v = s[leg.key];
                return (
                  <span key={s.index_symbol} className="flex flex-col items-end gap-0.5">
                    <span className={`tabular-nums ${zColor(v)}`}>{fmtZ(v)}</span>
                    <ZBar value={v} />
                  </span>
                );
              })}
            </div>
          ))}

          {/* composite row, like a ticket's net line */}
          <div className={`grid ${cols} items-center gap-x-1 border-t border-term-borderStrong bg-term-panel2 px-2 py-1.5`}>
            <span className="leading-tight">
              <span className="block font-semibold text-term-text">
                <span className="text-term-dim">Σ · </span>Composite
              </span>
              <span className="block text-[10px] text-term-dim">re-standardized · 252 sessions</span>
            </span>
            <span className="text-right tabular-nums text-term-dim">100%</span>
            {snaps.map((s) => (
              <span key={s.index_symbol} className="flex flex-col items-end gap-0.5">
                <span className={`text-[13px] font-bold tabular-nums ${bucketColor(s.bucket)}`}>{fmtZ(s.score)}</span>
                <span
                  className={`max-w-full truncate border px-1 text-[9px] uppercase ${bucketBg(s.bucket)} ${bucketColor(s.bucket)}`}
                  title={s.bucket}
                >
                  {s.bucket}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-term-border px-2 py-1.5 text-[10px] leading-snug text-term-dim">
        score = z( 0.25·trend + 0.25·breadth + 0.20·vol + 0.20·credit + 0.10·curve ) — every leg is its own
        z-score over the trailing 252 sessions; buckets: ≥ +1.25 strong risk-on · ≥ +0.40 risk-on ·
        &gt; −0.40 neutral · &gt; −1.25 risk-off/caution · else crash-warning.
      </div>
    </div>
  );
}
