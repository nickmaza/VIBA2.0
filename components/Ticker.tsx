import type { RegimeSnapshotRow, RawPriceRow } from "@/lib/types";
import { INSTRUMENTS } from "@/lib/instruments";
import { LivePrice } from "@/lib/live";

function fmtSigned(v: number, digits = 2, suffix = "") {
  return (v >= 0 ? "+" : "") + v.toFixed(digits) + suffix;
}

/**
 * Bottom status strip: every tracked symbol's live price and day change
 * (live_quotes over Realtime; the last daily close until a live quote arrives),
 * plus the three composite regime z-scores, scrolling like a workstation's
 * ticker bar. Pauses on hover.
 */
export default function Ticker({ snapshot, prices }: { snapshot: RegimeSnapshotRow[]; prices: RawPriceRow[] }) {
  const priceBy = new Map(prices.map((p) => [p.symbol, p]));
  const items: { label: string; value: string; sub?: string; positive: boolean; live?: { symbol: string; close: number; chg: number | null; pct: number | null } }[] = [];

  for (const s of snapshot) {
    items.push({ label: `${s.index_symbol} REGIME`, value: `${fmtSigned(s.score)}z`, sub: s.bucket, positive: s.score >= 0 });
  }
  for (const inst of INSTRUMENTS) {
    const p = priceBy.get(inst.symbol);
    if (!p) continue;
    const chg = p.chg ?? 0;
    items.push({
      label: inst.symbol,
      value: p.close.toFixed(2),
      sub: p.chg_pct === null ? undefined : `${fmtSigned(chg)} (${fmtSigned(p.chg_pct, 2, "%")})`,
      positive: chg >= 0,
      live: { symbol: inst.symbol, close: p.close, chg: p.chg, pct: p.chg_pct },
    });
  }
  const loop = items.length ? [...items, ...items] : [];

  return (
    <div className="fixed bottom-0 left-0 right-0 z-20 flex h-[24px] items-center border-t border-term-border bg-[#1a1a1a]">
      <span className="flex h-full shrink-0 items-center border-r border-term-border px-2 text-[10px] uppercase text-term-dim">
        Ticker ▾
      </span>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="ticker-track flex w-max gap-7 whitespace-nowrap">
          {loop.map((it, i) => (
            <span key={i} className="flex items-center gap-1.5 text-[11px]">
              <span className="text-term-dim">{it.label}</span>
              {it.live ? (
                <>
                  <LivePrice symbol={it.live.symbol} field="price" fallback={it.live.close} fallbackChange={it.live.chg} colorize />
                  <LivePrice symbol={it.live.symbol} field="change_pct" fallback={it.live.pct} fallbackChange={it.live.chg} className="text-[10px]" />
                </>
              ) : (
                <>
                  <span className={it.positive ? "text-term-green" : "text-term-red"}>{it.value}</span>
                  {it.sub && <span className="text-[10px] text-term-dim">{it.sub}</span>}
                </>
              )}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
