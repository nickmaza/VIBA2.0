import type { RefreshLogRow } from "@/lib/types";

function fmtTs(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ") + "z";
}

/**
 * Recent runs of the ingest + compute jobs, straight from refresh_log --
 * live proof that the pipeline is actually executing on its own schedule,
 * not just a badge that says LIVE.
 */
export default function PipelineStatus({ log }: { log: RefreshLogRow[] }) {
  if (log.length === 0) {
    return (
      <div className="border border-term-border bg-term-panel p-3 text-[11.5px] text-term-dim">
        No refresh runs recorded yet.
      </div>
    );
  }

  return (
    <div className="border border-term-border bg-term-panel">
      <div className="grid grid-cols-[14px_1fr_120px_1.4fr] gap-2 border-b border-term-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-term-dim">
        <span></span>
        <span>Job</span>
        <span>When (UTC)</span>
        <span>Note</span>
      </div>
      <div>
        {log.map((r) => (
          <div
            key={r.id}
            className="grid grid-cols-[14px_1fr_120px_1.4fr] items-start gap-2 border-b border-term-border/60 px-3 py-1.5 text-[11.5px] last:border-b-0"
          >
            <span
              className={`mt-1 inline-block h-1.5 w-1.5 rounded-full ${
                r.ok ? "bg-term-green" : "bg-term-red"
              }`}
            />
            <span className="font-medium text-term-text">{r.source}</span>
            <span className="tabular-nums text-term-dim">{fmtTs(r.refreshed_at)}</span>
            <span className="truncate text-term-dim" title={r.note ?? undefined}>
              {r.note ?? "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
