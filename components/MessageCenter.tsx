import type { RefreshLogRow } from "@/lib/types";
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

function lastOf(log: RefreshLogRow[], sources: string[]) {
  return log.find((r) => sources.includes(r.source));
}

/**
 * Pipeline health at a glance: what data the terminal is showing, when each
 * stage last ran (and whether it succeeded), when the next automated compute
 * fires, and how the page stays live.
 */
export default function MessageCenter({
  asOf,
  isLive,
  log,
  symbolsReporting,
}: {
  asOf: string;
  isLive: boolean;
  log: RefreshLogRow[];
  symbolsReporting: number;
}) {
  const ingest = lastOf(log, ["scheduled_trigger_ingest", "ingest-prices"]);
  const regime = lastOf(log, ["compute-regime-score"]);
  const sector = lastOf(log, ["compute-sector-rotation"]);

  const Stage = ({ label, row }: { label: string; row?: RefreshLogRow }) => (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-term-dim">
        <span className={`h-1.5 w-1.5 rounded-full ${!row ? "bg-term-dim" : row.ok ? "bg-term-green" : "bg-term-red"}`} />
        {label}
      </span>
      <span className={`whitespace-nowrap tabular-nums ${row && !row.ok ? "text-term-red" : "text-term-text"}`}>
        {row ? `${fmtTs(row.refreshed_at)} · ${row.ok ? "ok" : "FAILED"}` : "no run yet"}
      </span>
    </div>
  );

  return (
    <div className="space-y-2 p-2 text-[11px]">
      <div>
        <div className="mb-1 text-[10px] uppercase text-term-dim">Data source</div>
        <div className="flex justify-between">
          <span className="text-term-dim">Mode</span>
          <span className={isLive ? "text-term-green" : "text-term-yellow"}>{isLive ? "LIVE · Supabase" : "DEMO dataset"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-term-dim">Scores as of</span>
          <span className="tabular-nums text-term-text">{asOf}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-term-dim">Symbols reporting</span>
          <span className="tabular-nums text-term-text">{symbolsReporting} / 19</span>
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase text-term-dim">Last pipeline runs</div>
        <div className="space-y-0.5">
          <Stage label="1 · Ingest closes" row={ingest} />
          <Stage label="2 · Regime score" row={regime} />
          <Stage label="3 · Sector rotation" row={sector} />
        </div>
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase text-term-dim">Next scheduled compute (pg_cron)</div>
        <NextRun />
      </div>

      <div className="border-t border-term-border pt-1.5 text-[10px] leading-snug text-term-dim">
        Ingest runs hourly during market hours; the two compute jobs follow at :10 and :12 past the hour
        inside Postgres. Every write to the five source tables pushes to this page over Supabase Realtime —
        no polling, no chat session required.
      </div>
    </div>
  );
}
