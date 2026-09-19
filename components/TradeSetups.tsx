import type { TradeSetupRow, RotationStrengthRow } from "@/lib/types";

function n(v: number | null | undefined, d = 2) {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d);
}

function strengthTone(s: number) {
  if (s >= 85) return "bg-term-green";
  if (s >= 70) return "bg-term-cyan";
  if (s >= 55) return "bg-term-yellow";
  return "bg-term-amber";
}

function StrengthBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <span className="flex items-center gap-1.5">
      <span className="relative block h-1.5 w-[38px] bg-term-panel2">
        <span className={`absolute inset-y-0 left-0 ${strengthTone(v)}`} style={{ width: `${v}%` }} />
      </span>
      <span className="w-[26px] text-right tabular-nums text-term-text">{v.toFixed(0)}</span>
    </span>
  );
}

/**
 * Compact price ladder: stop on the left, entry marked, T1 and T2 to the
 * right, scaled to the actual distances so an oversized stop is visible at a
 * glance rather than buried in the numbers.
 */
function LevelStrip({ s }: { s: TradeSetupRow }) {
  const lo = s.stop, hi = s.t2;
  const span = hi - lo;
  if (!(span > 0)) return <span className="text-term-dim">—</span>;
  const at = (v: number) => ((v - lo) / span) * 100;
  const eX = at(s.entry), t1X = at(s.t1);
  return (
    <span className="relative block h-3 w-full bg-term-panel2" title={`stop ${n(s.stop)} · entry ${n(s.entry)} · T1 ${n(s.t1)} · T2 ${n(s.t2)}`}>
      <span className="absolute inset-y-0 bg-term-red/35" style={{ left: 0, width: `${eX}%` }} />
      <span className="absolute inset-y-0 bg-term-green/30" style={{ left: `${eX}%`, width: `${100 - eX}%` }} />
      <span className="absolute inset-y-0 w-[2px] bg-term-text" style={{ left: `calc(${eX}% - 1px)` }} />
      <span className="absolute inset-y-0 w-px bg-term-green" style={{ left: `${t1X}%` }} />
    </span>
  );
}

/**
 * The play list: leading sector ETFs plus the strongest names inside them,
 * each with the levels the rules produce. Targets sit at a fixed 2R and 3R,
 * so the column that carries information is "ATR to T1" -- how many daily
 * ranges the move has to cover for the payoff to land.
 */
export default function TradeSetups({
  setups,
  rotation,
}: {
  setups: TradeSetupRow[];
  rotation: RotationStrengthRow[];
}) {
  const cur = rotation.length ? rotation[rotation.length - 1] : null;
  const cols =
    "grid-cols-[58px_minmax(130px,1.5fr)_84px_62px_62px_62px_54px_62px_62px_60px_50px_54px]";

  if (setups.length === 0) {
    return (
      <div className="p-2 text-[11px] text-term-dim">
        No candidates yet — compute-trade-setups has not written a run.
      </div>
    );
  }

  const etfs = setups.filter((s) => s.kind === "sector_etf").length;
  const stocks = setups.length - etfs;

  return (
    <div className="text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-border bg-term-panel2 px-2 py-1 text-[10px]">
        <span className="text-term-dim">
          {etfs} sector ETF{etfs === 1 ? "" : "s"} · {stocks} name{stocks === 1 ? "" : "s"} inside them
        </span>
        {cur && (
          <span className="text-term-dim">
            rotation{" "}
            <span className={cur.state === "strong" ? "text-term-green" : cur.state === "churn" ? "text-term-amber" : "text-term-yellow"}>
              {cur.strength.toFixed(0)}/100 {cur.state}
            </span>
          </span>
        )}
        <span className="ml-auto text-term-dim">long-only · daily bars · as of {setups[0].as_of}</span>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[860px]">
          <div className={`grid ${cols} items-center gap-x-1.5 border-b border-term-border px-2 py-1 text-[10px] uppercase text-term-dim`}>
            <span>Symbol</span>
            <span>Name · why</span>
            <span>Strength</span>
            <span className="text-right">Buy below</span>
            <span className="text-right">Ref entry</span>
            <span className="text-right">Stop</span>
            <span className="text-right">Risk</span>
            <span className="text-right">T1 (2R)</span>
            <span className="text-right">T2 (3R)</span>
            <span className="pl-1">Stop→T2</span>
            <span className="text-right">ATR→T1</span>
            <span className="text-right">Sh/$1k</span>
          </div>

          {setups.map((s) => {
            const isEtf = s.kind === "sector_etf";
            const shares = s.risk_per_share > 0 ? 1000 / s.risk_per_share : null;
            return (
              <div
                key={s.symbol}
                className={`row-hover grid ${cols} items-center gap-x-1.5 border-b border-term-border/60 px-2 py-[3px] ${
                  isEtf ? "bg-term-cyan/[0.05]" : ""
                }`}
              >
                <span className="leading-tight">
                  <span className="block font-bold text-term-text">{s.symbol}</span>
                  <span className={`block text-[9.5px] uppercase ${isEtf ? "text-term-cyan" : "text-term-dim"}`}>
                    {isEtf ? "sector" : s.sector_etf}
                  </span>
                </span>
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-term-text">{s.name}</span>
                  <span className="block truncate text-[10px] text-term-dim" title={s.note ?? undefined}>
                    {s.note ?? ""}
                  </span>
                </span>
                <StrengthBar value={s.strength} />
                <span className="text-right tabular-nums text-term-cyan">{n(s.buy_zone_low)}</span>
                <span className="text-right tabular-nums text-term-text">{n(s.entry)}</span>
                <span className="text-right tabular-nums text-term-red">{n(s.stop)}</span>
                <span className="text-right tabular-nums text-term-dim">{n(s.risk_pct, 1)}%</span>
                <span className="text-right tabular-nums text-term-green">{n(s.t1)}</span>
                <span className="text-right tabular-nums text-term-green">{n(s.t2)}</span>
                <span className="pl-1">
                  <LevelStrip s={s} />
                </span>
                <span
                  className={`text-right tabular-nums ${
                    (s.t1_atr ?? 0) > 8 ? "text-term-amber" : "text-term-dim"
                  }`}
                  title="daily ATRs the price must cover to reach T1"
                >
                  {n(s.t1_atr, 1)}
                </span>
                <span className="text-right tabular-nums text-term-text" title="shares per $1,000 of risk">
                  {shares === null ? "—" : shares.toFixed(shares >= 100 ? 0 : 1)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-term-border px-2 py-1.5 text-[10px] leading-snug text-term-dim">
        <span className="text-term-text">How these are built: </span>
        candidates are the top-3 momentum sectors plus the strongest names inside each. Stop = 2 ATR below,
        dropped under the 20-day low if structure sits lower, capped at 3 ATR. Targets are fixed multiples of
        that risk (2R / 3R). <span className="text-term-text">Sh/$1k</span> = shares per $1,000 you are willing
        to lose, so size it to your own account. <span className="text-term-text">ATR→T1</span> flags
        feasibility: this is a multi-week hold, so 4-6 daily ranges is normal and a double-digit figure means
        the stop is too wide for the payoff. Levels are arithmetic on daily closes, recomputed each run — they
        are not predictions, and nothing here accounts for earnings dates, news or gaps.
      </div>
    </div>
  );
}
