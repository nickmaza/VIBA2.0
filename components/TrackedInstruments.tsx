import type { RawPriceRow } from "@/lib/types";

// Every ticker the pipeline reads, grouped by the role it plays in the math --
// so "everything we're tracking" is genuinely visible, not just the 3 index
// scores and 11 sector ranks that come out the other end.
const GROUPS: { title: string; items: { symbol: string; label: string }[] }[] = [
  {
    title: "Regime Indices",
    items: [
      { symbol: "SPY", label: "S&P 500 — composite score computed here" },
      { symbol: "QQQ", label: "Nasdaq 100 — composite score computed here" },
      { symbol: "IWM", label: "Russell 2000 — composite score computed here" },
    ],
  },
  {
    title: "Regime Inputs",
    items: [
      { symbol: "RSP", label: "Equal-weight S&P — feeds breadth (25%)" },
      { symbol: "VIXY", label: "VIX short-term futures — feeds volatility (20%)" },
      { symbol: "HYG", label: "High-yield corp bonds — feeds credit (20%)" },
      { symbol: "IEF", label: "7-10yr Treasuries — feeds credit + curve" },
      { symbol: "SHY", label: "1-3yr Treasuries — feeds rate curve (10%)" },
    ],
  },
  {
    title: "Sector ETFs (SPDR)",
    items: [
      { symbol: "XLK", label: "Technology" },
      { symbol: "XLF", label: "Financials" },
      { symbol: "XLE", label: "Energy" },
      { symbol: "XLV", label: "Health Care" },
      { symbol: "XLY", label: "Consumer Discretionary" },
      { symbol: "XLP", label: "Consumer Staples" },
      { symbol: "XLI", label: "Industrials" },
      { symbol: "XLB", label: "Materials" },
      { symbol: "XLU", label: "Utilities" },
      { symbol: "XLRE", label: "Real Estate" },
      { symbol: "XLC", label: "Communication Services" },
    ],
  },
];

function fmtUpdated(iso: string | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 16) + "z";
}

export default function TrackedInstruments({ prices }: { prices: RawPriceRow[] }) {
  const bySymbol = new Map(prices.map((p) => [p.symbol, p]));
  const total = GROUPS.reduce((n, g) => n + g.items.length, 0);
  const covered = GROUPS.reduce(
    (n, g) => n + g.items.filter((it) => bySymbol.has(it.symbol)).length,
    0
  );

  return (
    <div className="border border-term-border bg-term-panel">
      <div className="grid grid-cols-[64px_1fr_82px_54px] gap-2 border-b border-term-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-term-dim">
        <span>Symbol</span>
        <span>Tracked As</span>
        <span className="text-right">Last Close</span>
        <span className="text-right">Updated</span>
      </div>
      <div>
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="border-b border-term-border/60 bg-term-panel2 px-3 py-1 text-[10px] uppercase tracking-wide text-term-cyan">
              {g.title}
            </div>
            {g.items.map((it) => {
              const row = bySymbol.get(it.symbol);
              return (
                <div
                  key={it.symbol}
                  className="grid grid-cols-[64px_1fr_82px_54px] items-center gap-2 border-b border-term-border/60 px-3 py-1.5 text-[12px] last:border-b-0 hover:bg-term-panel2"
                >
                  <span className="font-semibold text-term-text">{it.symbol}</span>
                  <span className="text-term-dim">{it.label}</span>
                  <span className="text-right tabular-nums text-term-text">
                    {row ? `$${row.close.toFixed(2)}` : "—"}
                  </span>
                  <span className="text-right tabular-nums text-term-dim">
                    {fmtUpdated(row?.updated_at)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="border-t border-term-border px-3 py-1.5 text-[10.5px] text-term-dim">
        {covered}/{total} symbols reporting a current close
      </div>
    </div>
  );
}
