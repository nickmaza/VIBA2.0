"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase, hasSupabase } from "@/lib/supabase";

/**
 * Invisible component: subscribes to Supabase Realtime on every table the
 * pipeline writes to, and re-runs the server-side data fetch (via
 * router.refresh()) whenever a row changes -- so every open tab picks up a
 * new regime score, sector ranking, ingested price, or pipeline-run log
 * entry the moment it's written, with no polling. raw_prices + refresh_log
 * are what make the "Tracked Instruments" and "Pipeline Status" panels
 * genuinely live rather than just badge-live.
 */
export default function RealtimeRefresher() {
  const router = useRouter();

  useEffect(() => {
    if (!hasSupabase || !supabase) return;

    const channel = supabase
      .channel("terminal-refresh")
      .on("postgres_changes", { event: "*", schema: "public", table: "regime_snapshot" }, () =>
        router.refresh()
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "sector_rankings" }, () =>
        router.refresh()
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "regime_history" }, () =>
        router.refresh()
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "raw_prices" }, () =>
        router.refresh()
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "refresh_log" }, () =>
        router.refresh()
      )
      .subscribe();

    return () => {
      supabase?.removeChannel(channel);
    };
  }, [router]);

  return null;
}
