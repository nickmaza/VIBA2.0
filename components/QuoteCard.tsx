import type { RegimeSnapshotRow, RegimeHistoryRow, RawPriceRow } from "@/lib/types";
import { INSTRUMENT_BY_SYMBOL } from "@/lib/instruments";

export function bucketColor(bucket: string) {
  if (bucket.includes("strong risk-on") || bucket === "risk-on") return "text-term-green";
  if (bucket === "neutral") return "text-term-yellow";
  if (bucket.includes("caution")) return "text-term-amber";
  return "text-term-red";
}
export function bucketBg(bucket: string) {
  if (bucket.includes("strong risk-on") || bucket === "risk-on") return "bg-term-green/10 border-term-green/40";
  if (bucket === "neutral") return "bg-term-yellow/10 border-term-yellow/40";
  if (bucket.includes("caution")) return "bg-term-amber/10 border-term-amber/40";
  return "bg-term-red/10 border-term-red/40";
}

function fmtPx(v: number | null | undefined, digits = 2) {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(digits);
}
function fmtSigned(v: number | null | undefined, digits = 2, suffix = "") {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(digits) + suffix;
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 200,
    H = 28;
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
    <svg viewBox={`0 0 ${W} ${H}`} className="h-7 w-full" preserveAspectRatio="none">
      {zeroY >= 0 && zeroY <= H && (
        <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#3a3a3a" strokeWidth={1} strokeDasharray="2,3" />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.2} fill={color} />
    </svg>
  );
}

const SPARK_COLOR: Record<string, string> = {
  "text-term-green": "#3fbf4a",
  "text-term-yellow": "#f5d033",
  "text-term-amber": "#f5c542",
  "text-term-red": "#e5453c",
};

/**
 * Quote-window style card for one regime index: last close + day change up
 * top (from latest_prices), then the composite regime score / bucket and the
 * quote-style detail grid (prev close, 52-wk hi/lo, data date, updated).
 */
export default function QuoteCard({
  snap,
  price,
  history,
}: {
  snap: RegimeSnapshotRow;
  price?: RawPriceRow;
  history: RegimeHistoryRow[];
}) {
  const meta = INSTRUMENT_BY_SYMBOL.get(snap.index_symbol);
  const color = bucketColor(snap.bucket);
  const key = snap.index_symbol.toLowerCase() as "spy" | "qqq" | "iwm";
  const spark = history.slice(-60).map((h) => h[key]).filter((v) => Number.isFinite(v));
  const up = (price?.chg ?? 0) >= 0;

  // where today's close sits inside the trailing 52-week range, 0..1
  const rangePos =
    price && price.hi_52w !== null && price.lo_52w !== null && price.hi_52w > price.lo_52w
      ? (price.close - price.lo_52w) / (price.hi_52w - price.lo_52w)
      : null;

  return (
    <div className="p-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-bold text-term-text">{snap.index_symbol}</span>
        <span className="truncate text-[10px] uppercase text-term-dim">{meta?.name ?? ""}</span>
      </div>

      <div className="mt-0.5 flex items-end gap-2">
        <span className="text-[22px] font-bold leading-none tabular-nums text-term-text">
          {price ? fmtPx(price.close) : "—"}
        </span>
        {price && (
          <span className={`pb-0.5 text-[11px] tabular-nums ${up ? "text-term-green" : "text-term-red"}`}>
            {up ? "▲" : "▼"} {fmtSigned(price.chg)} ({fmtSigned(price.chg_pct, 2, "%")})
          </span>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between border-y border-term-border/70 py-1">
        <span className="text-[10px] uppercase text-term-dim">Regime</span>
        <span className={`text-[15px] font-bold tabular-nums ${color}`}>
          {fmtSigned(snap.score)}
          <span className="ml-1 text-[9.5px] font-normal text-term-dim">z</span>
        </span>
        <span className={`border px-1.5 py-px text-[9.5px] uppercase ${bucketBg(snap.bucket)} ${color}`}>
          {snap.bucket}
        </span>
      </div>

      {spark.length > 1 && (
        <div className="mt-1.5">
          <Sparkline values={spark} color={SPARK_COLOR[color]} />
          <div className="text-[9.5px] text-term-dim">composite · last {spark.length} sessions</div>
        </div>
      )}

      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10.5px]">
        <Row label="Prev Close" value={fmtPx(price?.prev_close)} />
        <Row label="52 Wk Hi" value={fmtPx(price?.hi_52w)} />
        <Row label="Data Date" value={price?.date ?? snap.as_of} />
        <Row label="52 Wk Lo" value={fmtPx(price?.lo_52w)} />
        <Row label="Updated" value={price ? price.updated_at.slice(11, 16) + "z" : "—"} />
        <Row label="As Of" value={snap.as_of} />
      </div>

      {rangePos !== null && (
        <div className="mt-1.5">
          <div className="relative h-1 w-full bg-term-panel2">
            <span
              className="absolute top-[-2px] h-2 w-[3px] bg-term-cyan"
              style={{ left: `calc(${(rangePos * 100).toFixed(1)}% - 1px)` }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-term-dim">
            <span>52wk lo</span>
            <span>{(rangePos * 100).toFixed(0)}% of range</span>
            <span>52wk hi</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-term-dim">{label}</span>
      <span className="tabular-nums text-term-text">{value}</span>
    </div>
  );
}
