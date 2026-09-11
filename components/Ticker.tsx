import type { RegimeSnapshotRow, SectorRankingRow } from "@/lib/types";

function fmt(v: number) {
  return (v >= 0 ? "+" : "") + v.toFixed(2);
}

export default function Ticker({
  snapshot,
  sectors,
}: {
  snapshot: RegimeSnapshotRow[];
  sectors: SectorRankingRow[];
}) {
  const items: { label: string; value: string; positive: boolean }[] = [
    ...snapshot.map((s) => ({
      label: s.index_symbol,
      value: `${fmt(s.score)}z`,
      positive: s.score >= 0,
    })),
    ...sectors.slice(0, 6).map((s) => ({
      label: s.ticker,
      value: `${fmt(s.r3)}%`,
      positive: s.r3 >= 0,
    })),
  ];
  const loop = [...items, ...items];

  return (
    <div className="overflow-hidden border-y border-term-border bg-term-panel">
      <div className="ticker-track flex w-max gap-8 whitespace-nowrap py-1.5">
        {loop.map((it, i) => (
          <span key={i} className="flex items-center gap-1.5 text-[11.5px]">
            <span className="text-term-dim">{it.label}</span>
            <span className={it.positive ? "text-term-green" : "text-term-red"}>
              {it.value}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
