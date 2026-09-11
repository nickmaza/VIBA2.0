import type { SectorRankingRow } from "@/lib/types";

function fmtPct(v: number) {
  return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}

export default function SectorPanel({ sectors }: { sectors: SectorRankingRow[] }) {
  const maxAbs = Math.max(...sectors.map((s) => Math.abs(s.score)), 0.01);

  return (
    <div className="border border-term-border bg-term-panel">
      <div className="grid grid-cols-[24px_1fr_70px_54px_54px_54px] gap-2 border-b border-term-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-term-dim">
        <span></span>
        <span>Sector</span>
        <span>Score</span>
        <span className="text-right">3M</span>
        <span className="text-right">6M</span>
        <span className="text-right">12M</span>
      </div>
      <div>
        {sectors.map((s) => {
          const pos = s.score >= 0;
          const w = (Math.abs(s.score) / maxAbs) * 50;
          return (
            <div
              key={s.ticker}
              className="grid grid-cols-[24px_1fr_70px_54px_54px_54px] items-center gap-2 border-b border-term-border/60 px-3 py-1.5 text-[12.5px] last:border-b-0 hover:bg-term-panel2"
            >
              <span className="text-term-dim">{s.rank}</span>
              <span className="flex flex-col leading-tight">
                <span className="font-semibold text-term-text">{s.ticker}</span>
                <span className="text-[10.5px] text-term-dim">{s.name}</span>
              </span>
              <span className="relative h-3.5 bg-[#1a1a18]">
                <span
                  className={`absolute top-0 bottom-0 ${pos ? "bg-term-cyan" : "bg-term-red"}`}
                  style={
                    pos
                      ? { left: "50%", width: `${w}%` }
                      : { right: "50%", width: `${w}%` }
                  }
                />
              </span>
              <span className={`text-right tabular-nums ${s.r3 >= 0 ? "text-term-green" : "text-term-red"}`}>
                {fmtPct(s.r3)}
              </span>
              <span className={`text-right tabular-nums ${s.r6 >= 0 ? "text-term-green" : "text-term-red"}`}>
                {fmtPct(s.r6)}
              </span>
              <span className={`text-right tabular-nums ${s.r12 >= 0 ? "text-term-green" : "text-term-red"}`}>
                {fmtPct(s.r12)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
