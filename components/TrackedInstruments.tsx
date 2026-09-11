import type { RawPriceRow, SectorRankingRow, RegimeSnapshotRow } from "@/lib/types";
import { INSTRUMENTS, ROLE_LABEL } from "@/lib/instruments";

function fmt(v: number | null | undefined, digits = 2) {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(digits);
}
function fmtSigned(v: number | null | undefined, digits = 2, suffix = "") {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(digits) + suffix;
}
// sector r3/r6/r12 are stored as percent (12.9 = +12.9%)
function fmtRet(v: number | undefined) {
  return v === undefined ? "—" : fmtSigned(v, 1, "%");
}
function signColor(v: number | null | undefined) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "text-term-dim";
  return v >= 0 ? "text-term-green" : "text-term-red";
}
function fmtUpdated(iso: string | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(5, 16).replace("T", " ") + "z";
}

function RangeBar({ close, lo, hi }: { close: number; lo: number | null; hi: number | null }) {
  if (lo === null || hi === null || hi <= lo) return <span className="text-term-dim">—</span>;
  const pos = Math.max(0, Math.min(1, (close - lo) / (hi - lo)));
  return (
    <span className="flex items-center gap-1 tabular-nums">
      <span className="w-[40px] text-right text-[10px] text-term-dim">{fmt(lo)}</span>
      <span className="relative block h-1 w-[44px] bg-term-panel2">
        <span className="absolute top-[-2px] h-2 w-[3px] bg-term-cyan" style={{ left: `calc(${(pos * 100).toFixed(1)}% - 1px)` }} />
      </span>
      <span className="w-[40px] text-[10px] text-term-dim">{fmt(hi)}</span>
    </span>
  );
}

const ROLE_COLOR = {
  index: "text-term-brand",
  input: "text-term-cyan",
  sector: "text-term-dim",
} as const;

/**
 * Positions-window style table: every one of the 19 symbols the pipeline
 * reads -- symbol + role, fund name + what the formulas use it for, last
 * close, day change, trailing 52-week range, and (for sector ETFs) momentum
 * rank, score and 3/6/12-month returns. Two-line cells keep it fitting on
 * one screen at workstation widths; it scrolls sideways below that.
 */
export default function TrackedInstruments({
  prices,
  sectors,
  snapshot,
}: {
  prices: RawPriceRow[];
  sectors: SectorRankingRow[];
  snapshot: RegimeSnapshotRow[];
}) {
  const priceBy = new Map(prices.map((p) => [p.symbol, p]));
  const sectorBy = new Map(sectors.map((s) => [s.ticker, s]));
  const snapBy = new Map<string, RegimeSnapshotRow>(snapshot.map((s) => [s.index_symbol, s]));
  const covered = INSTRUMENTS.filter((i) => priceBy.has(i.symbol)).length;
  const cols =
    "grid-cols-[62px_minmax(150px,1.6fr)_64px_58px_60px_138px_30px_52px_52px_52px_52px_80px]";

  return (
    <div className="text-[11px]">
      <div className="overflow-x-auto">
        <div className="min-w-[900px]">
          <div className={`grid ${cols} items-center gap-x-1.5 border-b border-term-border bg-term-panel2 px-2 py-1 text-[10px] uppercase text-term-dim`}>
            <span>Symbol</span>
            <span>Description · used for</span>
            <span className="text-right">Last</span>
            <span className="text-right">Chg</span>
            <span className="text-right">Chg %</span>
            <span className="pl-1">52 Wk Range</span>
            <span className="text-right">Rank</span>
            <span className="text-right">Mom</span>
            <span className="text-right">3M</span>
            <span className="text-right">6M</span>
            <span className="text-right">12M</span>
            <span className="text-right">Updated</span>
          </div>
          {INSTRUMENTS.map((inst) => {
            const p = priceBy.get(inst.symbol);
            const sec = sectorBy.get(inst.symbol);
            const snap = snapBy.get(inst.symbol);
            return (
              <div
                key={inst.symbol}
                className={`row-hover grid ${cols} items-center gap-x-1.5 border-b border-term-border/60 px-2 py-[3px]`}
              >
                <span className="leading-tight">
                  <span className="block font-bold text-term-text">{inst.symbol}</span>
                  <span className={`block text-[9.5px] uppercase ${ROLE_COLOR[inst.role]}`}>{ROLE_LABEL[inst.role]}</span>
                </span>
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-term-text">{inst.name}</span>
                  <span className="block truncate text-[10px] text-term-dim">
                    {snap ? `Regime z ${fmtSigned(snap.score)} · ${snap.bucket}` : inst.usage}
                  </span>
                </span>
                <span className="text-right tabular-nums text-term-text">{p ? fmt(p.close) : "—"}</span>
                <span className={`text-right tabular-nums ${signColor(p?.chg)}`}>{fmtSigned(p?.chg)}</span>
                <span className={`text-right tabular-nums ${signColor(p?.chg_pct)}`}>{fmtSigned(p?.chg_pct, 2, "%")}</span>
                <span className="pl-1">
                  {p ? <RangeBar close={p.close} lo={p.lo_52w} hi={p.hi_52w} /> : <span className="text-term-dim">—</span>}
                </span>
                <span className={`text-right tabular-nums ${sec && sec.rank <= 3 ? "font-bold text-term-green" : "text-term-dim"}`}>
                  {sec ? sec.rank : "—"}
                </span>
                <span className={`text-right tabular-nums ${sec ? signColor(sec.score) : "text-term-dim"}`}>
                  {sec ? fmtSigned(sec.score) : "—"}
                </span>
                <span className={`text-right tabular-nums ${sec ? signColor(sec.r3) : "text-term-dim"}`}>{fmtRet(sec?.r3)}</span>
                <span className={`text-right tabular-nums ${sec ? signColor(sec.r6) : "text-term-dim"}`}>{fmtRet(sec?.r6)}</span>
                <span className={`text-right tabular-nums ${sec ? signColor(sec.r12) : "text-term-dim"}`}>{fmtRet(sec?.r12)}</span>
                <span className="text-right tabular-nums text-term-dim">{fmtUpdated(p?.updated_at)}</span>
              </div>
            );
          })}
          <div className="flex justify-between px-2 py-1 text-[10px] text-term-dim">
            <span>
              TOTALS · {INSTRUMENTS.length} symbols · {covered} reporting a current close
            </span>
            <span>day change = last close vs prior session · 52 wk = trailing 252 sessions · updated = last write (UTC)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
