import type { RegimePoint } from "@/lib/landing";
import styles from "./landing.module.css";

// The landing page's hero: two years of the SPY regime score drawn as one
// flowing line through the five regime bands the terminal uses. The stroke
// changes color with the band it is in (green above +0.4, slate through
// neutral, amber below -0.4, rust below -1.25), so the line itself reads as
// the market's mood without a legend.

const W = 1200;
const H = 420;
const PAD_T = 24;
const PAD_B = 34;
const LO = -2.6;
const HI = 2.6;

const BANDS = [
  { from: 1.25, to: HI, label: "Strong risk-on", fill: "rgba(78,154,46,0.10)" },
  { from: 0.4, to: 1.25, label: "Risk-on", fill: "rgba(78,154,46,0.05)" },
  { from: -0.4, to: 0.4, label: "Neutral", fill: "rgba(20,35,44,0.025)" },
  { from: -1.25, to: -0.4, label: "Caution", fill: "rgba(201,146,26,0.07)" },
  { from: LO, to: -1.25, label: "Crash warning", fill: "rgba(194,74,58,0.08)" },
];

const y = (v: number) => PAD_T + ((HI - Math.max(LO, Math.min(HI, v))) / (HI - LO)) * (H - PAD_T - PAD_B);

/** Smooth path through the points (Catmull-Rom converted to cubic Béziers). */
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Light smoothing so two years of daily values read as a current, not noise. */
function ease(points: RegimePoint[], k = 5): number[] {
  return points.map((_, i) => {
    let s = 0,
      c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(points.length - 1, i + k); j++) {
      s += points[j].v;
      c++;
    }
    return s / c;
  });
}

const fmtMonth = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export default function RegimeRiver({ points, today }: { points: RegimePoint[]; today: { score: number; label: string } | null }) {
  if (points.length < 10) return null;
  // every other session keeps the path light without losing the shape
  const thin = points.filter((_, i) => i % 2 === 0 || i === points.length - 1);
  const vals = ease(thin);
  const xs = thin.map((_, i) => (i / (thin.length - 1)) * (W - 150));
  const pts: [number, number][] = vals.map((v, i) => [xs[i], y(v)]);
  // end the line exactly on today's published score
  const last = today?.score ?? thin[thin.length - 1].v;
  pts[pts.length - 1] = [pts[pts.length - 1][0], y(last)];
  const d = smoothPath(pts);
  const end = pts[pts.length - 1];
  const zeroY = y(0);

  // stroke gradient keyed to the band thresholds (userSpaceOnUse = real y)
  const stop = (v: number) => `${(((y(v) - 0) / H) * 100).toFixed(2)}%`;

  return (
    <figure className={styles.river} aria-labelledby="river-caption">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={styles.riverSvg} role="img" aria-label={`S&P 500 regime score over two years, now ${last.toFixed(2)}`}>
        <defs>
          <linearGradient id="riverStroke" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
            <stop offset={stop(1.25)} stopColor="#3f8a22" />
            <stop offset={stop(0.4)} stopColor="#4e9a2e" />
            <stop offset={stop(0.15)} stopColor="#5b6b74" />
            <stop offset={stop(-0.15)} stopColor="#5b6b74" />
            <stop offset={stop(-0.4)} stopColor="#c9921a" />
            <stop offset={stop(-1.25)} stopColor="#c24a3a" />
          </linearGradient>
          <linearGradient id="riverFill" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
            <stop offset="0%" stopColor="#4e9a2e" stopOpacity="0.16" />
            <stop offset={stop(0)} stopColor="#4e9a2e" stopOpacity="0.02" />
            <stop offset={stop(0)} stopColor="#c24a3a" stopOpacity="0.02" />
            <stop offset="100%" stopColor="#c24a3a" stopOpacity="0.14" />
          </linearGradient>
        </defs>

        {BANDS.map((b) => (
          <rect key={b.label} x={0} width={W} y={y(b.to)} height={y(b.from) - y(b.to)} fill={b.fill} />
        ))}
        <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="#14232c" strokeOpacity="0.18" strokeDasharray="3 6" vectorEffect="non-scaling-stroke" />

        {/* the area between the line and zero: green above, rust below */}
        <path d={`${d} L${end[0].toFixed(1)},${zeroY.toFixed(1)} L0,${zeroY.toFixed(1)} Z`} fill="url(#riverFill)" className={styles.riverArea} />
        <path d={d} fill="none" stroke="url(#riverStroke)" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" className={styles.riverLine} />
      </svg>

      {/* band names and today's reading sit in HTML so they stay crisp at any width */}
      <ul className={styles.bandLabels} aria-hidden>
        {BANDS.map((b) => (
          <li key={b.label} style={{ top: `${(((y(b.from) + y(b.to)) / 2 / H) * 100).toFixed(2)}%` }}>
            {b.label}
          </li>
        ))}
      </ul>
      <div className={styles.todayMark} style={{ left: `${((end[0] / W) * 100).toFixed(2)}%`, top: `${((end[1] / H) * 100).toFixed(2)}%` }}>
        <span className={styles.todayDot} />
        {today && (
          <span className={styles.todayLabel}>
            Today <b>{(today.score >= 0 ? "+" : "") + today.score.toFixed(2)}</b>
            <span>{today.label}</span>
          </span>
        )}
      </div>
      <div className={styles.riverDates} aria-hidden>
        <span>{fmtMonth(points[0].d)}</span>
        <span>{fmtMonth(points[points.length - 1].d)}</span>
      </div>
    </figure>
  );
}
