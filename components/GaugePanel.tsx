import type { RegimeSnapshotRow, RegimeHistoryRow } from "@/lib/types";

function bucketColor(bucket: string) {
  if (bucket.includes("strong risk-on") || bucket === "risk-on") return "text-term-green";
  if (bucket === "neutral") return "text-term-yellow";
  if (bucket.includes("caution")) return "text-term-amber";
  return "text-term-red";
}
function bucketBg(bucket: string) {
  if (bucket.includes("strong risk-on") || bucket === "risk-on") return "bg-term-green/10 border-term-green/40";
  if (bucket === "neutral") return "bg-term-yellow/10 border-term-yellow/40";
  if (bucket.includes("caution")) return "bg-term-amber/10 border-term-amber/40";
  return "bg-term-red/10 border-term-red/40";
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 200,
    H = 32;
  const min = Math.min(...values),
    max = Math.max(...values);
  const pad = (max - min) * 0.15 || 0.5;
  const y0 = min - pad,
    y1 = max + pad;
  const pts = values.map((v, i) => {
    const x = values.length > 1 ? (i / (values.length - 1)) * W : W / 2;
    const y = H - ((v - y0) / (y1 - y0)) * H;
    return [x, y];
  });
  const zeroY = H - ((0 - y0) / (y1 - y0)) * H;
  const path = "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-full" preserveAspectRatio="none">
      <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#2a2a28" strokeWidth={1} strokeDasharray="2,3" />
      <path d={path} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.5} fill={color} />
    </svg>
  );
}

const SPARK_COLOR: Record<string, string> = {
  "text-term-green": "#2ecc40",
  "text-term-yellow": "#ffd93d",
  "text-term-amber": "#ff9d2e",
  "text-term-red": "#ff4136",
};

export default function GaugePanel({
  snapshot,
  history,
}: {
  snapshot: RegimeSnapshotRow[];
  history: RegimeHistoryRow[];
}) {
  const recent = history.slice(-13);
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {snapshot.map((s) => {
        const color = bucketColor(s.bucket);
        const key = s.index_symbol.toLowerCase() as "spy" | "qqq" | "iwm";
        const values = recent.map((r) => r[key]);
        return (
          <div
            key={s.index_symbol}
            className="border border-term-border bg-term-panel p-4"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold tracking-wide text-term-amber">
                {s.index_symbol}
              </span>
              <span
                className={`border px-2 py-0.5 text-[10px] uppercase tracking-wide ${bucketBg(
                  s.bucket
                )} ${color}`}
              >
                {s.bucket}
              </span>
            </div>
            <div className="mb-2 text-3xl font-semibold tabular-nums text-term-text">
              {s.score >= 0 ? "+" : ""}
              {s.score.toFixed(2)}
              <span className="ml-1.5 text-xs font-normal text-term-dim">z-score</span>
            </div>
            {values.length > 1 && (
              <Sparkline values={values} color={SPARK_COLOR[color]} />
            )}
            <div className="mt-1 text-[10.5px] text-term-dim">13-wk trend · weekly close</div>
          </div>
        );
      })}
    </div>
  );
}
