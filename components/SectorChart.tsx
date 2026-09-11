import type { SectorRankingRow } from "@/lib/types";

const W = 460,
  ROW = 17,
  ML = 44,
  MR = 52,
  MT = 6,
  MB = 6;

/**
 * Horizontal bar chart of the risk-adjusted momentum score per sector,
 * ranked best to worst -- the chart-window counterpart of the ladder table.
 */
export default function SectorChart({ sectors }: { sectors: SectorRankingRow[] }) {
  const rows = [...sectors].sort((a, b) => a.rank - b.rank);
  const H = MT + MB + rows.length * ROW;
  const maxAbs = Math.max(...rows.map((s) => Math.abs(s.score)), 0.01);
  const plotW = W - ML - MR;
  const zeroX = ML + plotW / 2;
  const scale = plotW / 2 / maxAbs;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full" style={{ height: H }}>
      <line x1={zeroX} y1={MT} x2={zeroX} y2={H - MB} stroke="#5a5a5a" strokeWidth={1} />
      {[-1, -0.5, 0.5, 1].map((g) => {
        if (Math.abs(g) > maxAbs) return null;
        const x = zeroX + g * scale;
        return <line key={g} x1={x} y1={MT} x2={x} y2={H - MB} stroke="#2b2b2b" strokeWidth={1} strokeDasharray="2,3" />;
      })}
      {rows.map((s, i) => {
        const y = MT + i * ROW;
        const pos = s.score >= 0;
        const w = Math.abs(s.score) * scale;
        const x = pos ? zeroX : zeroX - w;
        const held = s.rank <= 3;
        return (
          <g key={s.ticker}>
            <rect x={x} y={y + 3} width={Math.max(1, w)} height={ROW - 6} fill={pos ? "#4fb3e8" : "#e5453c"} opacity={held ? 1 : 0.75} />
            <text x={ML - 6} y={y + ROW / 2 + 3.5} textAnchor="end" fontSize={10} fontWeight={held ? 700 : 400} fill={held ? "#e6e6e6" : "#9c9c9c"}>
              {s.ticker}
            </text>
            <text x={W - MR + 6} y={y + ROW / 2 + 3.5} fontSize={10} fill={pos ? "#4fb3e8" : "#e5453c"}>
              {(s.score >= 0 ? "+" : "") + s.score.toFixed(2)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
