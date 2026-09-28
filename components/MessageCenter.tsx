import type { PipelineStatusRow } from "@/lib/types";
import NextRun from "@/components/NextRun";

function fmtTs(iso: string | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d) + " ET"
  );
}

// Every job that feeds the terminal, in pipeline order (refresh_log.source).
const STAGES: { source: string; label: string }[] = [
  { source: "sync-prices", label: "Prices · Yahoo Finance" },
  { source: "sync-options", label: "Options · CBOE" },
  { source: "compute-regime-score", label: "Regime score" },
  { source: "compute-sector-rotation", label: "Sector rotation" },
  { source: "compute-trade-setups", label: "Trade setups" },
  { source: "compute-plays", label: "Stock plays" },
  { source: "compute-smart-money", label: "Smart money" },
  { source: "sync-insiders", label: "Insiders · SEC Form 4" },
  { source: "sync-13f", label: "Funds · SEC 13F" },
  { source: "sync-congress", label: "Congress · STOCK Act" },
  { source: "compute-backtest", label: "Backtest" },
  { source: "sync-directory", label: "Symbol directory" },
];

/**
 * Pipeline health at a glance: where the data comes from, when each job last
 * ran (and whether it succeeded), and when the next scheduled run fires.
 */
export default function MessageCenter({
  asOf,
  errors,
  pipeline,
  symbolsReporting,
  symbolsTracked,
}: {
  asOf: string | null;
  errors: string[];
  pipeline: PipelineStatusRow[];
  symbolsReporting: number;
  symbolsTracked: number;
}) {
  const by = new Map(pipeline.map((p) => [p.source, p]));

  return (
    <div className="space-y-2 p-2 text-[11px]">
      <div>
        <div className="mb-1 text-[10px] uppercase text-term-dim">Data source</div>
        <div className="flex justify-between">
          <span className="text-term-dim">Database</span>
          <span className={errors.length ? "text-term-red" : "text-term-green"}>
            {errors.length ? `Supabase · ${errors.length} failed` : "Supabase · all reads ok"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-term-dim">Scores as of</span>
          <span className="tabular-nums text-term-text">{asOf ?? "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-term-dim">Instruments reporting</span>
          <span className="tabular-nums text-term-text">
            {symbolsReporting} / {symbolsTracked}
          </span>
        </div>
        {errors.length > 0 && (
          <ul className="m-0 mt-1 list-none p-0 text-[10px] text-term-red">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase text-term-dim">Last run of each job</div>
        <div className="space-y-0.5">
          {STAGES.map(({ source, label }) => {
            const row = by.get(source);
            return (
              <div key={source} className="flex items-center justify-between gap-2" title={row?.note ?? undefined}>
                <span className="flex min-w-0 items-center gap-1.5 text-term-dim">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${!row ? "bg-term-dim" : row.ok ? "bg-term-green" : "bg-term-red"}`} />
                  <span className="truncate">{label}</span>
                </span>
                <span className={`whitespace-nowrap tabular-nums ${row && !row.ok ? "text-term-red" : "text-term-text"}`}>
                  {row ? `${fmtTs(row.refreshed_at)} · ${row.ok ? "ok" : "FAILED"}` : "no run yet"}
                  {row && row.runs_24h > 0 && (
                    <span className="text-term-dim">
                      {" "}
                      · {row.runs_24h}/24h{row.failures_24h ? `, ${row.failures_24h} failed` : ""}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase text-term-dim">Next scheduled runs (pg_cron)</div>
        <NextRun />
      </div>

      <div className="border-t border-term-border pt-1.5 text-[10px] leading-snug text-term-dim">
        Every number comes from Supabase. Edge functions on pg_cron pull the market data (Yahoo Finance daily bars, CBOE
        option chains, SEC EDGAR Form 4 and 13F filings, Senate and House STOCK Act reports) and compute the scores inside
        the project. After each close the whole library and every option chain are re-synced from 16:30 ET. Each run is
        logged to refresh_log and pushed to this page over Supabase Realtime.
      </div>
    </div>
  );
}
