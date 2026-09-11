"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, hasSupabase } from "@/lib/supabase";

type Status = "off" | "connecting" | "live" | "error";

/**
 * Subscribes to Supabase Realtime on every table the pipeline writes to and
 * re-runs the server-side data fetch (router.refresh()) whenever a row
 * changes -- so every open tab picks up a new regime score, sector ranking,
 * ingested price, or pipeline-run log entry the moment it's written, with no
 * polling.
 *
 * Also renders the "RT" status badge in the menu bar: subscription state,
 * how many change events have arrived this session, and when the last one
 * landed -- visible proof the feed is live rather than a static badge.
 */
export default function RealtimeRefresher() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(hasSupabase ? "connecting" : "off");
  const [events, setEvents] = useState(0);
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSupabase || !supabase) return;

    const onChange = () => {
      setEvents((n) => n + 1);
      setLastEvent(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date())
      );
      router.refresh();
    };

    const tables = ["regime_snapshot", "sector_rankings", "regime_history", "raw_prices", "refresh_log"];
    let channel = supabase.channel("terminal-refresh");
    for (const table of tables) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, onChange);
    }
    channel.subscribe((s) => {
      if (s === "SUBSCRIBED") setStatus("live");
      else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") setStatus("error");
      else if (s === "CLOSED") setStatus("connecting");
    });

    return () => {
      supabase?.removeChannel(channel);
    };
  }, [router]);

  const dot =
    status === "live"
      ? "bg-term-green live-dot"
      : status === "connecting"
      ? "bg-term-yellow"
      : status === "error"
      ? "bg-term-red"
      : "bg-term-dim";
  const label =
    status === "live"
      ? "RT LIVE"
      : status === "connecting"
      ? "RT CONNECTING"
      : status === "error"
      ? "RT ERROR"
      : "RT OFF";

  return (
    <span className="flex items-center gap-1.5 text-[11px]" title="Supabase Realtime: postgres_changes on 5 tables">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className={status === "live" ? "text-term-green" : "text-term-dim"}>{label}</span>
      {status === "live" && (
        <span className="hidden text-term-dim sm:inline">
          · {events} evt{events === 1 ? "" : "s"}
          {lastEvent ? ` · last ${lastEvent}` : ""}
        </span>
      )}
    </span>
  );
}
