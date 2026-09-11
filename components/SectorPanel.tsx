import type { SectorRankingRow } from "@/lib/types";

// r3/r6/r12 are stored as percent (12.9 = +12.9%), same as scripts/refresh.py
function fmtPct(v: number) {
  return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}
function pctColor(v: number) {
  return v >= 0 ? "text-term-green" : "text-term-red";
}

/**
 * Option-chain style ladder of the 11 sector ETFs: momentum returns on the
 * left, the ticker in a highlighted "strike" column in the middle, the
 * risk-adjusted score and rank on the right. Rows 1-3 (the top-3 momentum
 * holdings the backtest trades) are shaded like in-the-money strikes; the
 * bottom 3 are tinted red.
 */
export default function SectorPanel({ sectors }: { sectors: SectorRankingRow[] }) {
  const rows = [...sectors].sort((a, b) => a.rank - b.rank);
  const n = rows.length;
  const maxAbs = Math.max(...rows.map((s) => Math.abs(s.score)), 0.01);
  const cols = "grid-cols-[46px_46px_46px_60px_minmax(36px,1fr)_46px_22px]";

  return (
    <div className="text-[11px]">
      <div className="flex items-center justify-between border-b border-term-border bg-term-panel2 px-2 py-1 text-[10px] uppercase text-term-dim">
        <span>
          Momentum <span className="normal-case">(3M / 6M / 12M total return)</span>
        </span>
        <span>Risk-adj. score</span>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[318px]">
          <div className={`grid ${cols} items-center gap-x-1 border-b border-term-border px-1 py-1 text-[10px] uppercase text-term-dim`}>
            <span className="text-right">3M</span>
            <span className="text-right">6M</span>
            <span className="text-right">12M</span>
            <span className="bg-term-ink py-0.5 text-center font-bold text-term-text">Sector</span>
            <span className="pl-1">Score</span>
            <span className="text-right">Value</span>
            <span className="text-right">#</span>
          </div>
          {rows.map((s) => {
            const pos = s.score >= 0;
            const w = (Math.abs(s.score) / maxAbs) * 50;
            const held = s.rank <= 3;
            const worst = s.rank > n - 3;
            const tint = held ? "bg-term-green/[0.07]" : worst ? "bg-term-red/[0.06]" : "";
            return (
              <div
                key={s.ticker}
                className={`row-hover grid ${cols} items-center gap-x-1 border-b border-term-border/60 px-1 py-1 ${tint}`}
                title={`${s.name} · rank ${s.rank} of ${n}`}
              >
                <span className={`text-right tabular-nums ${pctColor(s.r3)}`}>{fmtPct(s.r3)}</span>
                <span className={`text-right tabular-nums ${pctColor(s.r6)}`}>{fmtPct(s.r6)}</span>
                <span className={`text-right tabular-nums ${pctColor(s.r12)}`}>{fmtPct(s.r12)}</span>
                <span className="bg-term-ink py-0.5 text-center leading-tight">
                  <span className="block font-bold text-term-text">{s.ticker}</span>
                  <span className="block truncate text-[9px] text-term-dim">{s.name}</span>
                </span>
                <span className="relative ml-1 block h-3 bg-term-panel2">
                  <span
                    className={`absolute top-0 bottom-0 ${pos ? "bg-term-cyan" : "bg-term-red"}`}
                    style={pos ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
                  />
                  <span className="absolute top-0 bottom-0 left-1/2 w-px bg-term-borderStrong" />
                </span>
                <span className={`text-right tabular-nums ${pos ? "text-term-cyan" : "text-term-red"}`}>
                  {(s.score >= 0 ? "+" : "") + s.score.toFixed(2)}
                </span>
                <span className={`text-right tabular-nums ${held ? "font-bold text-term-green" : "text-term-dim"}`}>
                  {s.rank}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-3 border-t border-term-border px-2 py-1 text-[10px] text-term-dim">
        <span>
          <span className="inline-block h-2 w-2 bg-term-green/40 align-middle" /> top-3 = holdings
        </span>
        <span>
          <span className="inline-block h-2 w-2 bg-term-red/40 align-middle" /> bottom-3
        </span>
        <span className="ml-auto">score = (0.2·r3 + 0.3·r6 + 0.5·r12) ÷ 126d ann. vol</span>
      </div>
    </div>
  );
}
