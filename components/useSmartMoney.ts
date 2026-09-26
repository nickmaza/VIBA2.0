"use client";

import { useEffect, useState } from "react";
import type { SmartMoneyPayload } from "@/lib/smartmoney";
import type { FundsPayload, InsiderSummary } from "@/lib/smartmoney/sec";

type State<T> = { data: T | null; error: string | null; loading: boolean };

// One in-flight request per endpoint, shared by every component on the page
// (Overview, Plays and Smart Money tabs all read the same payload).
const cache = new Map<string, Promise<unknown>>();

function load<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined;
  if (!p) {
    p = fetch(url).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string })?.error || `Request failed (${r.status})`);
      return j as T;
    });
    p.catch(() => cache.delete(url)); // let a later mount retry
    cache.set(url, p);
  }
  return p;
}

function useEndpoint<T>(url: string | null): State<T> {
  const [s, set] = useState<State<T>>({ data: null, error: null, loading: Boolean(url) });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    set((x) => ({ ...x, loading: true }));
    load<T>(url).then(
      (data) => alive && set({ data, error: null, loading: false }),
      (e) => alive && set({ data: null, error: e instanceof Error ? e.message : "Failed to load", loading: false })
    );
    return () => {
      alive = false;
    };
  }, [url]);
  return s;
}

export const useSmartMoney = () => useEndpoint<SmartMoneyPayload>("/api/smart-money");
export const useFunds = (enabled = true) => useEndpoint<FundsPayload>(enabled ? "/api/smart-money/funds" : null);
export const useInsiders = (symbols: string[]) =>
  useEndpoint<{ results: InsiderSummary[] }>(symbols.length ? `/api/smart-money/insiders?symbols=${symbols.join(",")}` : null);
