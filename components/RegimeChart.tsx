"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RegimeHistoryRow } from "@/lib/types";

const EVENTS = [
  { label: "2018 Q4 selloff", from: "2018-10-01", to: "2018-12-24" },
  { label: "2020 COVID crash", from: "2020-02-19", to: "2020-03-23" },
  { label: "2022 bear market", from: "2022-01-03", to: "2022-10-13" },
];

type SeriesKey = "spy" | "qqq" | "iwm";
const SERIES_META: Record<SeriesKey, { label: string; color: string }> = {
  spy: { label: "SPY", color: "#f5d033" },
  qqq: { label: "QQQ", color: "#4fb3e8" },
  iwm: { label: "IWM", color: "#8fd14f" },
};

// approximate trading sessions per range; "max" = everything on file
const RANGES: { key: string; label: string; points: number | null }[] = [
  { key: "3m", label: "3M", points: 63 },
  { key: "6m", label: "6M", points: 126 },
  { key: "1y", label: "1Y", points: 252 },
  { key: "3y", label: "3Y", points: 756 },
  { key: "5y", label: "5Y", points: 1260 },
  { key: "max", label: "MAX", points: null },
];

const ML = 40,
  MR = 16,
  MT = 16,
  MB = 26;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Composite regime z-score chart. One or more index series, a selectable
 * lookback (toolbar in the chart, like a workstation chart window), bucket
 * threshold lines, and hover readout. Daily sessions from regime_history.
 */
export default function RegimeChart({
  history,
  series = ["spy"],
  defaultRange = "max",
  showEvents = true,
  height = 230,
}: {
  history: RegimeHistoryRow[];
  series?: SeriesKey[];
  defaultRange?: string;
  showEvents?: boolean;
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [rangeKey, setRangeKey] = useState(defaultRange);

  // Draw the SVG at the container's real pixel width (1:1) so text and line
  // weights aren't stretched by a fixed viewBox; SSR starts at 600px and the
  // client corrects it on mount / resize.
  const [W, setW] = useState(600);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => setW(Math.max(240, Math.floor(el.clientWidth)));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const plotW = W - ML - MR,
    plotH = H - MT - MB;

  const rows = useMemo(() => {
    const r = RANGES.find((x) => x.key === rangeKey) ?? RANGES[RANGES.length - 1];
    return r.points === null ? history : history.slice(-r.points);
  }, [history, rangeKey]);

  const dates = useMemo(() => rows.map((h) => h.d), [rows]);
  const valsBy = useMemo(() => {
    const out = {} as Record<SeriesKey, number[]>;
    for (const k of series) out[k] = rows.map((h) => h[k]);
    return out;
  }, [rows, series]);

  const { y0, y1 } = useMemo(() => {
    let minV = Infinity,
      maxV = -Infinity;
    for (const k of series) {
      for (const v of valsBy[k]) {
        if (!Number.isFinite(v)) continue;
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
    if (!Number.isFinite(minV)) return { y0: -3, y1: 3 };
    return { y0: Math.floor(Math.min(minV, -1.5) - 0.3), y1: Math.ceil(Math.max(maxV, 1.5) + 0.3) };
  }, [valsBy, series]);

  const n = dates.length;
  function xAt(i: number) {
    return n > 1 ? ML + (i / (n - 1)) * plotW : ML + plotW / 2;
  }
  function yAt(v: number) {
    return MT + plotH - ((v - y0) / (y1 - y0)) * plotH;
  }
  function findIdx(dateStr: string) {
    for (let i = 0; i < dates.length; i++) if (dates[i] >= dateStr) return i;
    return dates.length - 1;
  }

  const paths = useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of series) {
      const pts = valsBy[k].map((v, i) => [xAt(i), yAt(v)] as const);
      out[k] = "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L ");
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valsBy, series, y0, y1, n, W]);

  // ticks: yearly when the window spans more than ~2 years, otherwise monthly
  const ticks = useMemo(() => {
    const out: { x: number; label: string }[] = [];
    const spanYears = n > 1 ? (Number(dates[n - 1].slice(0, 4)) - Number(dates[0].slice(0, 4))) : 0;
    const yearly = spanYears >= 2;
    let last = "";
    dates.forEach((d, i) => {
      const key = yearly ? d.slice(0, 4) : d.slice(0, 7);
      if (key !== last) {
        if (last !== "") {
          const label = yearly ? d.slice(0, 4) : `${MONTHS[Number(d.slice(5, 7)) - 1]}${d.slice(5, 7) === "01" ? " " + d.slice(2, 4) : ""}`;
          out.push({ x: xAt(i), label });
        }
        last = key;
      }
    });
    // thin out if crowded
    const maxTicks = 14;
    if (out.length > maxTicks) {
      const step = Math.ceil(out.length / maxTicks);
      return out.filter((_, i) => i % step === 0);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates, n, W]);

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    let i = Math.round(((relX - ML) / plotW) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    setHover(i);
  }

  const thresholds = [1.25, 0.4, 0, -0.4, -1.25];
  const bands: { from: number; to: number; fill: string }[] = [
    { from: 1.25, to: y1, fill: "#3fbf4a" },
    { from: -1.25, to: y0, fill: "#e5453c" },
  ];

  const hoverSeries = hover !== null ? series : [];
  const primary = series[0];

  return (
    <div className="flex h-full flex-col">
      {/* chart-window toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-2 py-1 text-[10px]">
        <span className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRangeKey(r.key)}
              className={`border px-1.5 leading-[15px] ${
                r.key === rangeKey
                  ? "border-term-borderStrong bg-term-panel text-term-text"
                  : "border-transparent text-term-dim hover:text-term-text"
              }`}
            >
              {r.label}
            </button>
          ))}
        </span>
        <span className="text-term-dim">DAILY</span>
        <span className="ml-auto flex gap-3">
          {series.map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className="inline-block h-[2px] w-3" style={{ background: SERIES_META[k].color }} />
              <span className="text-term-text">{SERIES_META[k].label}</span>
              <span className="tabular-nums text-term-dim">
                {(() => {
                  const v = valsBy[k][hover ?? n - 1];
                  return Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) : "";
                })()}
              </span>
            </span>
          ))}
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative flex-1"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block w-full" style={{ height }}>
          {bands.map((b) => {
            const top = yAt(Math.max(b.from, b.to)),
              bottom = yAt(Math.min(b.from, b.to));
            if (!(bottom > top)) return null;
            return <rect key={b.fill} x={ML} y={top} width={plotW} height={bottom - top} fill={b.fill} opacity={0.05} />;
          })}
          {showEvents &&
            EVENTS.map((ev) => {
              if (ev.to < dates[0] || ev.from > dates[n - 1]) return null;
              const i0 = findIdx(ev.from),
                i1 = findIdx(ev.to);
              const x0 = xAt(i0),
                x1 = xAt(i1);
              return (
                <g key={ev.label}>
                  <rect x={x0} y={MT} width={Math.max(2, x1 - x0)} height={plotH} fill="#e5453c" opacity={0.08} />
                  {/* label only when the band is wide enough for it not to collide with its neighbours */}
                  {x1 - x0 > 70 && (
                    <text x={(x0 + x1) / 2} y={MT + 11} textAnchor="middle" fontSize={10} fill="#9c9c9c">
                      {ev.label}
                    </text>
                  )}
                </g>
              );
            })}
          {thresholds.map((g) => {
            if (g < y0 || g > y1) return null;
            const y = yAt(g);
            return (
              <g key={g}>
                <line x1={ML} y1={y} x2={W - MR} y2={y} stroke={g === 0 ? "#5a5a5a" : "#333333"} strokeWidth={1} strokeDasharray={g === 0 ? undefined : "3,3"} />
                <text x={ML - 6} y={y + 3.5} textAnchor="end" fontSize={10} fill="#9c9c9c">
                  {g > 0 ? "+" : ""}
                  {g}
                </text>
              </g>
            );
          })}
          {series.map((k) => (
            <path key={k} d={paths[k]} fill="none" stroke={SERIES_META[k].color} strokeWidth={k === primary ? 1.6 : 1.2} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {ticks.map((t, i) => (
            <text key={i} x={t.x} y={H - 8} fontSize={10} fill="#9c9c9c" textAnchor="middle">
              {t.label}
            </text>
          ))}
          {hover !== null && (
            <>
              <line x1={xAt(hover)} y1={MT} x2={xAt(hover)} y2={MT + plotH} stroke="#5a5a5a" strokeWidth={1} />
              {hoverSeries.map((k) => (
                <circle key={k} cx={xAt(hover)} cy={yAt(valsBy[k][hover])} r={3.5} fill={SERIES_META[k].color} stroke="#000" strokeWidth={1.2} />
              ))}
            </>
          )}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute z-10 border border-term-borderStrong bg-term-panel2 px-2 py-1 text-[11px] shadow-lg"
            style={{
              left: `${(xAt(hover) / W) * 100}%`,
              top: "6px",
              transform: xAt(hover) > W * 0.7 ? "translate(calc(-100% - 10px), 0)" : "translate(10px, 0)",
            }}
          >
            <div className="font-semibold text-term-text">{dates[hover]}</div>
            {series.map((k) => {
              const v = valsBy[k][hover];
              return (
                <div key={k} className="flex items-center gap-1.5">
                  <span className="inline-block h-1.5 w-1.5" style={{ background: SERIES_META[k].color }} />
                  <span className="text-term-dim">{SERIES_META[k].label}</span>
                  <span className="tabular-nums text-term-text">
                    {Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(2) : "n/a"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
