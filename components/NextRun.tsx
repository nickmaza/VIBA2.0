"use client";

import { useEffect, useState } from "react";
import { CRON_JOBS } from "@/lib/instruments";

/** Next fire time (UTC) of a pg_cron schedule of the form "M H1-H2 * * 1-5". */
function nextFire(job: (typeof CRON_JOBS)[number], from: Date): Date {
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 24 * 8 * 60; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    const day = t.getUTCDay();
    if (job.weekdaysOnly && (day === 0 || day === 6)) continue;
    if (t.getUTCMinutes() !== job.minute) continue;
    if (!job.hours.includes(t.getUTCHours())) continue;
    return t;
  }
  return t;
}

function fmtCountdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(sec).padStart(2, "0")}s`;
}

/** Live countdown to the next scheduled compute job, from the pg_cron schedules. */
export default function NextRun() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!now) return <span className="text-term-dim">calculating…</span>;

  return (
    <div className="space-y-0.5">
      {CRON_JOBS.map((job) => {
        const n = nextFire(job, now);
        const et = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(n);
        return (
          <div key={job.name} className="flex justify-between gap-2">
            <span className="truncate text-term-dim">{job.name}</span>
            <span className="whitespace-nowrap tabular-nums text-term-text">
              {et} ET <span className="text-term-cyan">· in {fmtCountdown(n.getTime() - now.getTime())}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
