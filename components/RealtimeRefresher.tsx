"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase, hasSupabase } from "@/lib/supabase";

/**
 * Invisible component: subscribes to Supabase Realtime on the tables the
 * refresh job writes to, and re-runs the server-side data fetch (via
 * router.refresh()) whenever a row changes -- so every open tab picks up a
 * new regime score / sector ranking the moment the scheduled job writes it,
 * with no polling.
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
      .subscribe();

    return () => {
      supabase?.removeChannel(channel);
    };
  }, [router]);

  return null;
}
