import type { RotationStrengthRow } from "@/lib/types";

const STATE_COLOR: Record<string, string> = {
  strong: "text-term-green",
  moderate: "text-term-yellow",
  churn: "text-term-amber",
  weak: "text-term-red",
};
const STATE_BG: Record<string, string> = {
  strong: "bg-term-green/10 border-term-green/40",
  moderate: "bg-term-yellow/10 border-term-yellow/40",
  churn: "bg-term-amber/10 border-term-amber/40",
  weak: "bg-term-red/10 border-term-red/40",
};
const STATE_NOTE: Record<string, string> = {
  strong: "sectors separating and leadership holding — rotation is tradeable",
  moderate: "some separation, but leadership is only partly settled",
  churn: "sectors are spread out but leadership keeps reshuffling — whipsaw risk",
  weak: "sectors moving together — little to rotate into",
};

/** 0-100 meter with the reading marked. */
function Meter({ value, color }: { value: number; color: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="relative h-3 w-full bg-term-panel2">
      <div className="absolute inset-y-0 left-0 bg-term-red/20" style={{ width: "40%" }} />
      <div className="absolute inset-y-0 bg-term-yellow/20" style={{ left: "40%", width: "30%" }} />
      <div className="absolute inset-y-0 bg-term-green/20" style={{ left: "70%", width: "30%" }} />
      <div className={`absolute inset-y-0 left-0 ${color}`} style={{ width: `${v}%`, opacity: 0.55 }} />
      <div className="absolute inset-y-0 w-[2px] bg-term-text" style={{ left: `calc(${v}% - 1px)` }} />
      {[40, 70].map((t) => (
        <div key={t} className="absolute inset-y-0 w-px bg-term-borderStrong/70" style={{ left: `${t}%` }} />
      ))}
    </div>
  );
}

/** Signed -1..+1 bar for the persistence reading. */
function SignedBar({ value }: { value: number }) {
  const v = Math.max(-1, Math.min(1, value));
  const pct = (Math.abs(v) / 1) * 50;
  return (
    <span className="relative block h-1.5 w-full bg-term-panel2">
      <span
        className={`absolute top-0 bottom-0 ${v >= 0 ? "bg-term-green" : "bg-term-red"}`}
        style={v >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }}
      />
      <span className="absolute top-0 bottom-0 left-1/2 w-px bg-term-borderStrong" />
    </span>
  );
}

/** Filled area chart of the strength series, with the 40/70 state bands. */
function History({ rows }: { rows: RotationStrengthRow[] }) {
  const W = 320, H = 54;
  if (rows.length < 2) return null;
  const vals = rows.map((r) => r.strength);
  const xAt = (i: number) => (i / (vals.length - 1)) * W;
  const yAt = (v: number) => H - (Math.max(0, Math.min(100, v)) / 100) * H;
  const line = vals.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" L ");
  const area = `M0,${H} L ${line} L ${W},${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[54px] w-full">
      <rect x={0} y={yAt(100)} width={W} height={yAt(70) - yAt(100)} fill="#3fbf4a" opacity={0.07} />
      <rect x={0} y={yAt(70)} width={W} height={yAt(40) - yAt(70)} fill="#f5d033" opacity={0.06} />
      <rect x={0} y={yAt(40)} width={W} height={H - yAt(40)} fill="#e5453c" opacity={0.06} />
      {[40, 70].map((t) => (
        <line key={t} x1={0} y1={yAt(t)} x2={W} y2={yAt(t)} stroke="#3a3a3a" strokeWidth={1} strokeDasharray="2,3" />
      ))}
      <path d={area} fill="#4fb3e8" opacity={0.18} />
      <path d={`M${line}`} fill="none" stroke="#4fb3e8" strokeWidth={1.4} strokeLinejoin="round" />
      <circle cx={xAt(vals.length - 1)} cy={yAt(vals[vals.length - 1])} r={2.4} fill="#4fb3e8" />
    </svg>
  );
}

function Chips({ label, csv, tone }: { label: string; csv: string | null; tone: string }) {
  const items = (csv ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-[52px] shrink-0 text-[10px] uppercase text-term-dim">{label}</span>
      <span className="flex flex-wrap gap-1">
        {items.map((t) => (
          <span key={t} className={`border px-1 text-[10px] font-semibold ${tone}`}>
            {t}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * How strong the current rotation is, and why. The headline 0-100 blends
 * three things the trade list depends on: are sectors actually separating
 * (dispersion), how wide the leader/laggard gap is (spread), and whether the
 * same names keep leading (persistence). A high reading built on dispersion
 * alone, with no persistence, is flagged as churn rather than strength.
 */
export default function RotationStrength({ rows }: { rows: RotationStrengthRow[] }) {
  if (rows.length === 0) {
    return <div className="p-2 text-[11px] text-term-dim">No rotation history computed yet.</div>;
  }
  const cur = rows[rows.length - 1];
  const prev = rows[Math.max(0, rows.length - 6)];
  const delta = cur.strength - prev.strength;
  const color = STATE_COLOR[cur.state] ?? "text-term-dim";
  const barColor =
    cur.state === "strong" ? "bg-term-green" : cur.state === "weak" ? "bg-term-red" : "bg-term-yellow";

  const rowsOut: { label: string; value: string; bar: React.ReactNode; hint: string }[] = [
    {
      label: "Dispersion",
      value: cur.dispersion.toFixed(2),
      hint: "spread of the 11 sector scores",
      bar: (
        <span className="relative block h-1.5 w-full bg-term-panel2">
          <span className="absolute inset-y-0 left-0 bg-term-cyan" style={{ width: `${Math.min(100, (cur.dispersion / 0.8) * 100)}%` }} />
        </span>
      ),
    },
    {
      label: "Leader gap",
      value: cur.spread.toFixed(2),
      hint: "mean top-3 minus mean bottom-3",
      bar: (
        <span className="relative block h-1.5 w-full bg-term-panel2">
          <span className="absolute inset-y-0 left-0 bg-term-cyan" style={{ width: `${Math.min(100, (cur.spread / 2.2) * 100)}%` }} />
        </span>
      ),
    },
    {
      label: "Persistence",
      value: (cur.persistence >= 0 ? "+" : "") + cur.persistence.toFixed(2),
      hint: "rank correlation vs 21 sessions ago",
      bar: <SignedBar value={cur.persistence} />,
    },
  ];

  return (
    <div className="p-2 text-[11px]">
      <div className="flex items-end justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className={`text-[26px] font-bold leading-none tabular-nums ${color}`}>
            {cur.strength.toFixed(0)}
          </span>
          <span className="text-[10px] text-term-dim">/ 100</span>
        </div>
        <span className={`border px-1.5 py-0.5 text-[10px] uppercase ${STATE_BG[cur.state] ?? ""} ${color}`}>
          {cur.state}
        </span>
      </div>

      <div className="mt-1.5">
        <Meter value={cur.strength} color={barColor} />
        <div className="mt-0.5 flex justify-between text-[9px] text-term-dim">
          <span>weak</span>
          <span>moderate</span>
          <span>strong</span>
        </div>
      </div>

      <div className="mt-1 text-[10px] leading-snug text-term-dim">{STATE_NOTE[cur.state] ?? ""}</div>

      <div className="mt-2 space-y-1 border-t border-term-border/60 pt-2">
        {rowsOut.map((r) => (
          <div key={r.label} className="grid grid-cols-[62px_1fr_40px] items-center gap-2" title={r.hint}>
            <span className="text-term-dim">{r.label}</span>
            {r.bar}
            <span className="text-right tabular-nums text-term-text">{r.value}</span>
          </div>
        ))}
      </div>

      <div className="mt-2 space-y-1 border-t border-term-border/60 pt-2">
        <Chips label="Leading" csv={cur.leaders} tone="border-term-green/50 bg-term-green/10 text-term-green" />
        <Chips label="Lagging" csv={cur.laggards} tone="border-term-red/50 bg-term-red/10 text-term-red" />
      </div>

      <div className="mt-2 border-t border-term-border/60 pt-1.5">
        <div className="mb-0.5 flex justify-between text-[10px] text-term-dim">
          <span>{rows.length}-session history</span>
          <span className={delta >= 0 ? "text-term-green" : "text-term-red"}>
            {delta >= 0 ? "+" : ""}
            {delta.toFixed(1)} vs 5 sessions ago
          </span>
        </div>
        <History rows={rows} />
      </div>
    </div>
  );
}
