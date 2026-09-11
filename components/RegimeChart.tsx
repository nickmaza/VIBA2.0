"use client";

import { useMemo, useRef, useState } from "react";
import type { RegimeHistoryRow } from "@/lib/types";

const EVENTS = [
  { label: "2018 Q4 selloff", from: "2018-10-01", to: "2018-12-24" },
  { label: "2020 COVID crash", from: "2020-02-19", to: "2020-03-23" },
  { label: "2022 bear market", from: "2022-01-03", to: "2022-10-13" },
];

const W = 980,
  H = 300,
  ML = 40,
  MR = 16,
  MT = 16,
  MB = 26;
const plotW = W - ML - MR,
  plotH = H - MT - MB;

export default function RegimeChart({ history }: { history: RegimeHistoryRow[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const dates = useMemo(() => history.map((h) => h.d), [history]);
  const vals = useMemo(() => history.map((h) => h.spy), [history]);

  const { y0, y1 } = useMemo(() => {
    const minV = Math.min(...vals),
      maxV = Math.max(...vals);
    return { y0: Math.floor(minV - 0.4), y1: Math.ceil(maxV + 0.4) };
  }, [vals]);

  function xAt(i: number) {
    return ML + (i / (vals.length - 1)) * plotW;
  }
  function yAt(v: number) {
    return MT + plotH - ((v - y0) / (y1 - y0)) * plotH;
  }
  function findIdx(dateStr: string) {
    for (let i = 0; i < dates.length; i++) if (dates[i] >= dateStr) return i;
    return dates.length - 1;
  }

  const path = useMemo(() => {
    const pts = vals.map((v, i) => [xAt(i), yAt(v)] as const);
    return "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L ");
  }, [vals, y0, y1]);

  const yearTicks = useMemo(() => {
    const ticks: { x: number; label: string }[] = [];
    let lastYear = "";
    dates.forEach((d, i) => {
      const yr = d.slice(0, 4);
      if (yr !== lastYear && d.slice(5, 7) === "01") {
        lastYear = yr;
        ticks.push({ x: xAt(i), label: yr });
      }
    });
    return ticks;
  }, [dates]);

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    let i = Math.round(((relX - ML) / plotW) * (vals.length - 1));
    i = Math.max(0, Math.min(vals.length - 1, i));
    setHover(i);
  }

  const thresholds = [1.25, 0.4, 0, -0.4, -1.25];

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full">
        {EVENTS.map((ev) => {
          const i0 = findIdx(ev.from),
            i1 = findIdx(ev.to);
          const x0 = xAt(i0),
            x1 = xAt(i1);
          return (
            <g key={ev.label}>
              <rect
                x={x0}
                y={MT}
                width={Math.max(2, x1 - x0)}
                height={plotH}
                fill="#ff4136"
                opacity={0.07}
              />
              <text
                x={(x0 + x1) / 2}
                y={MT + 12}
                textAnchor="middle"
                fontSize={10.5}
                fill="#87867e"
              >
                {ev.label}
              </text>
            </g>
          );
        })}
        {thresholds.map((g) => {
          if (g < y0 || g > y1) return null;
          const y = yAt(g);
          return (
            <g key={g}>
              <line
                x1={ML}
                y1={y}
                x2={W - MR}
                y2={y}
                stroke="#2a2a28"
                strokeWidth={1}
                strokeDasharray={g === 0 ? undefined : "3,3"}
              />
              <text x={ML - 8} y={y + 3.5} textAnchor="end" fontSize={10} fill="#87867e">
                {g}
              </text>
            </g>
          );
        })}
        <path d={path} fill="none" stroke="#ff9d2e" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        {yearTicks.map((t) => (
          <text key={t.label} x={t.x} y={H - 8} fontSize={10} fill="#87867e">
            {t.label}
          </text>
        ))}
        {hover !== null && (
          <>
            <line x1={xAt(hover)} y1={MT} x2={xAt(hover)} y2={MT + plotH} stroke="#3d3d3a" strokeWidth={1} />
            <circle cx={xAt(hover)} cy={yAt(vals[hover])} r={4} fill="#ff9d2e" stroke="#000" strokeWidth={1.5} />
          </>
        )}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute z-10 border border-term-borderStrong bg-term-panel2 px-2.5 py-1.5 text-[11.5px] shadow-lg"
          style={{
            left: `${(xAt(hover) / W) * 100}%`,
            top: `${(yAt(vals[hover]) / H) * 100}%`,
            transform: "translate(12px, -30px)",
          }}
        >
          <div className="font-semibold text-term-text">{dates[hover]}</div>
          <div className="text-term-dim">
            SPY composite:{" "}
            <span className="text-term-amber">
              {vals[hover] >= 0 ? "+" : ""}
              {vals[hover].toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
