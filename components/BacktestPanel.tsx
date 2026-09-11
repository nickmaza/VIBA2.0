"use client";

import { useMemo, useRef, useState } from "react";
import type { BacktestCurvePointRow, BacktestStatRow } from "@/lib/types";

const SERIES: { key: BacktestCurvePointRow["strategy"]; label: string; color: string }[] = [
  { key: "baseline", label: "Equal-weight (baseline)", color: "#4fb3e8" },
  { key: "top3", label: "Top-3 momentum", color: "#f5d033" },
  { key: "dual", label: "Top-3 + regime filter", color: "#3fbf4a" },
  { key: "bottom3", label: "Bottom-3 (sanity check)", color: "#e078d0" },
];

const W = 460,
  H = 230,
  ML = 34,
  MR = 10,
  MT = 12,
  MB = 22;
const plotW = W - ML - MR,
  plotH = H - MT - MB;

export default function BacktestPanel({
  curves,
  stats,
}: {
  curves: BacktestCurvePointRow[];
  stats: BacktestStatRow[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const byStrategy = useMemo(() => {
    const map = new Map<string, BacktestCurvePointRow[]>();
    for (const s of SERIES) {
      map.set(
        s.key,
        curves.filter((c) => c.strategy === s.key).sort((a, b) => a.month.localeCompare(b.month))
      );
    }
    return map;
  }, [curves]);

  const months = byStrategy.get("baseline")?.map((c) => c.month) ?? [];

  const { logMin, logMax } = useMemo(() => {
    let minV = Infinity,
      maxV = -Infinity;
    curves.forEach((c) => {
      minV = Math.min(minV, c.growth);
      maxV = Math.max(maxV, c.growth);
    });
    return { logMin: Math.log(minV * 0.95), logMax: Math.log(maxV * 1.05) };
  }, [curves]);

  function xAt(i: number) {
    return ML + (i / (months.length - 1)) * plotW;
  }
  function yAt(v: number) {
    return MT + plotH - ((Math.log(v) - logMin) / (logMax - logMin)) * plotH;
  }

  const gridVals = [1, 1.5, 2, 3, 4].filter((g) => Math.log(g) >= logMin && Math.log(g) <= logMax);

  const yearTicks = useMemo(() => {
    const ticks: { x: number; label: string }[] = [];
    let lastYear = "";
    months.forEach((m, i) => {
      const yr = m.slice(0, 4);
      if (yr !== lastYear && m.slice(5, 7) === "01") {
        lastYear = yr;
        ticks.push({ x: xAt(i), label: yr });
      }
    });
    return ticks;
  }, [months]);

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    let i = Math.round(((relX - ML) / plotW) * (months.length - 1));
    i = Math.max(0, Math.min(months.length - 1, i));
    setHover(i);
  }

  return (
    <div className="p-2">
      <div
        ref={wrapRef}
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full">
          {gridVals.map((g) => {
            const y = yAt(g);
            return (
              <g key={g}>
                <line x1={ML} y1={y} x2={W - MR} y2={y} stroke="#333333" strokeWidth={1} />
                <text x={ML - 6} y={y + 3} textAnchor="end" fontSize={9.5} fill="#9c9c9c">
                  ${g}
                </text>
              </g>
            );
          })}
          {SERIES.map((s) => {
            const pts = (byStrategy.get(s.key) ?? []).map((c, i) => [xAt(i), yAt(c.growth)] as const);
            const path = "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L ");
            return (
              <path
                key={s.key}
                d={path}
                fill="none"
                stroke={s.color}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
          {yearTicks.map((t) => (
            <text key={t.label} x={t.x} y={H - 6} fontSize={9.5} fill="#9c9c9c">
              {t.label}
            </text>
          ))}
          {hover !== null && (
            <line x1={xAt(hover)} y1={MT} x2={xAt(hover)} y2={MT + plotH} stroke="#5a5a5a" strokeWidth={1} />
          )}
          {hover !== null &&
            SERIES.map((s) => {
              const pt = byStrategy.get(s.key)?.[hover];
              if (!pt) return null;
              return (
                <circle
                  key={s.key}
                  cx={xAt(hover)}
                  cy={yAt(pt.growth)}
                  r={3}
                  fill={s.color}
                  stroke="#000"
                  strokeWidth={1}
                />
              );
            })}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute z-10 border border-term-borderStrong bg-term-panel2 px-2.5 py-1.5 text-[11px] shadow-lg"
            style={{
              left: `${(xAt(hover) / W) * 100}%`,
              top: "8px",
              transform: "translate(10px, 0)",
            }}
          >
            <div className="mb-0.5 font-semibold text-term-text">{months[hover]}</div>
            {SERIES.map((s) => {
              const pt = byStrategy.get(s.key)?.[hover];
              if (!pt) return null;
              return (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                  <span className="text-term-dim">{s.label}:</span>
                  <span className="tabular-nums text-term-text">${pt.growth.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-term-dim">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-3" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <table className="mt-3 w-full border-collapse text-[11.5px]">
        <thead>
          <tr className="text-term-dim">
            <th className="border-t border-term-border py-1.5 text-left font-normal uppercase tracking-wide text-[10px]">
              Strategy
            </th>
            <th className="border-t border-term-border py-1.5 text-right font-normal uppercase tracking-wide text-[10px]">
              CAGR
            </th>
            <th className="border-t border-term-border py-1.5 text-right font-normal uppercase tracking-wide text-[10px]">
              Vol
            </th>
            <th className="border-t border-term-border py-1.5 text-right font-normal uppercase tracking-wide text-[10px]">
              Sharpe
            </th>
            <th className="border-t border-term-border py-1.5 text-right font-normal uppercase tracking-wide text-[10px]">
              MaxDD
            </th>
          </tr>
        </thead>
        <tbody>
          {SERIES.map((s) => {
            const st = stats.find((x) => x.strategy === s.key);
            if (!st) return null;
            return (
              <tr key={s.key}>
                <td className="flex items-center gap-1.5 border-t border-term-border py-1.5">
                  <span className="inline-block h-2 w-2" style={{ background: s.color }} />
                  {st.label}
                </td>
                <td className="border-t border-term-border py-1.5 text-right tabular-nums text-term-green">
                  +{st.cagr.toFixed(1)}%
                </td>
                <td className="border-t border-term-border py-1.5 text-right tabular-nums text-term-text">
                  {st.ann_vol.toFixed(1)}%
                </td>
                <td className="border-t border-term-border py-1.5 text-right tabular-nums text-term-text">
                  {st.sharpe.toFixed(2)}
                </td>
                <td className="border-t border-term-border py-1.5 text-right tabular-nums text-term-red">
                  {st.max_dd.toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
