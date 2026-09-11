import type { RegimeSnapshotRow, RefreshLogRow, RegimeHistoryRow, SectorRankingRow } from "@/lib/types";

type Level = "red" | "amber" | "green" | "info";
interface Alert {
  level: Level;
  title: string;
  detail: string;
}

const DOT: Record<Level, string> = {
  red: "bg-term-red",
  amber: "bg-term-amber",
  green: "bg-term-green",
  info: "bg-term-cyan",
};

function bucketOf(score: number) {
  if (score >= 1.25) return "strong risk-on";
  if (score >= 0.4) return "risk-on";
  if (score > -0.4) return "neutral";
  if (score > -1.25) return "risk-off / caution";
  return "elevated risk / crash-warning";
}

/**
 * Alerts derived from the live tables at render time (re-derived on every
 * realtime refresh): regime bucket state per index, recent bucket flips,
 * failed pipeline runs, stale data, and the current top-3 sector holdings.
 */
export function deriveAlerts({
  snapshot,
  history,
  sectors,
  log,
  now,
}: {
  snapshot: RegimeSnapshotRow[];
  history: RegimeHistoryRow[];
  sectors: SectorRankingRow[];
  log: RefreshLogRow[];
  now: Date;
}): Alert[] {
  const alerts: Alert[] = [];

  for (const s of snapshot) {
    const z = (s.score >= 0 ? "+" : "") + s.score.toFixed(2);
    if (s.bucket.includes("crash")) {
      alerts.push({ level: "red", title: `${s.index_symbol} · ${s.bucket}`, detail: `composite z ${z} — below −1.25` });
    } else if (s.bucket.includes("caution")) {
      alerts.push({ level: "amber", title: `${s.index_symbol} · ${s.bucket}`, detail: `composite z ${z} — between −1.25 and −0.40` });
    } else if (s.bucket.includes("risk-on")) {
      alerts.push({ level: "green", title: `${s.index_symbol} · ${s.bucket}`, detail: `composite z ${z}` });
    }
  }

  // bucket flips inside the last 5 sessions
  const recent = history.slice(-6);
  if (recent.length >= 2) {
    for (const key of ["spy", "qqq", "iwm"] as const) {
      const prev = bucketOf(recent[0][key]);
      const cur = bucketOf(recent[recent.length - 1][key]);
      if (prev !== cur) {
        alerts.push({
          level: "info",
          title: `${key.toUpperCase()} regime flip`,
          detail: `${prev} → ${cur} over the last ${recent.length - 1} sessions`,
        });
      }
    }
  }

  const fails = log.filter((r) => !r.ok).slice(0, 3);
  for (const f of fails) {
    alerts.push({ level: "red", title: `${f.source} failed`, detail: f.note ?? "no detail" });
  }

  const asOf = snapshot[0]?.as_of;
  if (asOf) {
    const ageDays = (now.getTime() - new Date(asOf + "T21:00:00Z").getTime()) / 86400000;
    if (ageDays > 4) {
      alerts.push({ level: "amber", title: "Data may be stale", detail: `snapshot as-of ${asOf} is ${Math.floor(ageDays)} days old` });
    }
  }

  const top3 = [...sectors].sort((a, b) => a.rank - b.rank).slice(0, 3);
  if (top3.length === 3) {
    alerts.push({
      level: "info",
      title: "Top-3 momentum holdings",
      detail: top3.map((s) => s.ticker).join(" · "),
    });
  }

  return alerts;
}

export default function AlertsPanel({ alerts }: { alerts: Alert[] }) {
  return (
    <div className="text-[11px]">
      <div className="flex items-center gap-2 border-b border-term-border bg-term-panel2 px-2 py-1 text-[10px] text-term-dim">
        <span className="uppercase">Alert</span>
        <span className="border border-term-borderStrong bg-term-panel px-1.5 text-term-text">Regime · Pipeline · Sectors</span>
        <span className="ml-auto">{alerts.length} active</span>
      </div>
      {alerts.length === 0 ? (
        <div className="p-2 text-term-dim">No active alerts.</div>
      ) : (
        <ul>
          {alerts.map((a, i) => (
            <li key={i} className="row-hover flex items-start gap-1.5 border-b border-term-border/60 px-2 py-1">
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[a.level]}`} />
              <span className="min-w-0 leading-snug">
                <span className="block truncate font-semibold text-term-text">{a.title}</span>
                <span className="block text-[10px] text-term-dim">{a.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
