"use client";

import { useEffect, useState } from "react";
import { CRON_JOBS, type CronJob } from "@/lib/instruments";

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

/** Minutes New York is ahead of UTC at `d` (negative: -240 in summer, -300 in winter). */
function nyOffsetMinutes(d: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
  return Math.round((asUtc - Math.floor(d.getTime() / 60000) * 60000) / 60000);
}

/** Next time the job fires: a listed minute, inside its New York window, on an allowed day. */
function nextFire(job: CronJob, now: Date, offset: number): Date | null {
  const from = hm(job.from), to = hm(job.to);
  const start = Math.floor(now.getTime() / 60000) + 1; // whole minutes since the epoch, UTC
  for (let m = start; m < start + 8 * 24 * 60; m++) {
    const utcMinute = ((m % 60) + 60) % 60;
    if (!job.minutes.includes(utcMinute)) continue;
    const local = new Date((m + offset) * 60000); // New York wall time, read with getUTC*
    const day = local.getUTCDay();
    if (job.weekdays && (day === 0 || day === 6)) continue;
    const mod = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (mod < from || mod > to) continue;
    return new Date(m * 60000);
  }
  return null;
}

function fmtCountdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(sec).padStart(2, "0")}s`;
}

/** Live countdown to each scheduled pipeline job (pg_cron, New York market hours). */
export default function NextRun() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!now) return <span className="text-term-dim">calculating…</span>;
  const offset = nyOffsetMinutes(now);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <div className="space-y-0.5">
      {CRON_JOBS.map((job) => {
        const n = nextFire(job, now, offset);
        return (
          <div key={`${job.name}-${job.label}`} className="flex justify-between gap-2">
            <span className="truncate text-term-dim" title={job.name}>
              {job.label}
            </span>
            <span className="whitespace-nowrap tabular-nums text-term-text">
              {n ? (
                <>
                  {fmt.format(n)} ET <span className="text-term-cyan">· in {fmtCountdown(n.getTime() - now.getTime())}</span>
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
