"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { DATA_EVENT, type DataEventDetail } from "@/components/useSmartMoney";

type Status = "connecting" | "live" | "error";

const MIN_REFRESH_MS = 60_000; // at most one server re-render a minute
const SETTLE_MS = 4_000; // let a burst of runs finish before re-rendering

/**
 * Keeps every open tab current without polling. Each pipeline run in Supabase
 * (a sync or compute edge function) appends a row to refresh_log; this
 * component listens for those inserts over Supabase Realtime and
 *   - re-runs the server-side data fetch (router.refresh()), debounced, and
 *   - tells the client-side panels (Smart Money, insiders, 13F) which dataset
 *     just changed so they re-read it.
 *
 * Also renders the "RT" badge in the menu bar: subscription state, how many
 * pipeline runs have arrived this session, and the latest one.
 */
export default function RealtimeRefresher() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("connecting");
  const [events, setEvents] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  const lastRefresh = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const scheduleRefresh = () => {
      if (timer.current) return;
      const wait = Math.max(SETTLE_MS, lastRefresh.current + MIN_REFRESH_MS - Date.now());
      timer.current = setTimeout(() => {
        timer.current = null;
        lastRefresh.current = Date.now();
        router.refresh();
      }, wait);
    };

    const channel = supabase
      .channel("terminal-refresh")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "refresh_log" }, (payload) => {
        const row = payload.new as { id?: number; source?: string; refreshed_at?: string };
        const source = String(row.source ?? "");
        setEvents((n) => n + 1);
        setLast(
          `${source} · ${new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }).format(row.refreshed_at ? new Date(row.refreshed_at) : new Date())}`
        );
        window.dispatchEvent(new CustomEvent<DataEventDetail>(DATA_EVENT, { detail: { id: Number(row.id ?? Date.now()), source } }));
        scheduleRefresh();
      })
      .subscribe((s) => {
        if (s === "SUBSCRIBED") setStatus("live");
        else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") setStatus("error");
        else if (s === "CLOSED") setStatus("connecting");
      });

    return () => {
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [router]);

  const dot = status === "live" ? "bg-term-green live-dot" : status === "connecting" ? "bg-term-yellow" : "bg-term-red";
  const label = status === "live" ? "RT LIVE" : status === "connecting" ? "RT CONNECTING" : "RT ERROR";

  return (
    <span className="flex items-center gap-1.5 text-[11px]" title="Supabase Realtime: new pipeline runs (refresh_log)">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className={status === "live" ? "text-term-green" : "text-term-dim"}>{label}</span>
      {status === "live" && (
        <span className="hidden text-term-dim lg:inline">
          · {events} run{events === 1 ? "" : "s"}
          {last ? ` · last ${last} ET` : ""}
        </span>
      )}
    </span>
  );
}
