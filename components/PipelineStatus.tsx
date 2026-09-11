import type { RefreshLogRow } from "@/lib/types";

function fmtTs(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${et} ET`;
}

const SOURCE_LABEL: Record<string, string> = {
  scheduled_trigger_ingest: "INGEST · Robinhood → raw_prices",
  "ingest-prices": "INGEST · raw_prices",
  "compute-regime-score": "COMPUTE · regime score",
  "compute-sector-rotation": "COMPUTE · sector rotation",
};

/**
 * News-window style feed of the pipeline's own activity, straight from
 * refresh_log: each run is a "headline" (its note), with the job name and
 * timestamp as the source line -- live proof the automation is executing.
 */
export default function PipelineStatus({ log }: { log: RefreshLogRow[] }) {
  const ok = log.filter((r) => r.ok).length;
  const failed = log.length - ok;

  return (
    <div className="flex h-full flex-col text-[11px]">
      <div className="flex items-center gap-2 border-b border-term-border bg-term-panel2 px-2 py-1 text-[10px]">
        <span className="border border-term-borderStrong bg-term-panel px-1.5 text-term-text">All Jobs</span>
        <span className="text-term-dim">
          <span className="text-term-green">{ok} ok</span> ·{" "}
          <span className={failed ? "text-term-red" : "text-term-dim"}>{failed} failed</span>
        </span>
        <span className="ml-auto text-term-dim">last {log.length}</span>
      </div>
      {log.length === 0 ? (
        <div className="p-2 text-term-dim">No refresh runs recorded yet.</div>
      ) : (
        <ul className="max-h-[420px] flex-1 overflow-y-auto">
          {log.map((r) => (
            <li key={r.id} className="row-hover border-b border-term-border/60 px-2 py-1.5">
              <div className="flex items-start gap-1.5">
                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${r.ok ? "bg-term-green" : "bg-term-red"}`} />
                <span className={`line-clamp-2 leading-snug ${r.ok ? "text-term-text" : "text-term-red"}`} title={r.note ?? undefined}>
                  {r.note ?? (r.ok ? "completed" : "failed")}
                </span>
              </div>
              <div className="mt-0.5 pl-3 text-[10px] uppercase text-term-dim">
                {SOURCE_LABEL[r.source] ?? r.source} · {fmtTs(r.refreshed_at)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
