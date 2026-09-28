"use client";

import { useEffect, useState } from "react";
import type { SmartMoneyPayload } from "@/lib/smartmoney";
import type { FundsPayload, InsidersPayload } from "@/lib/smartmoney/sec";

type State<T> = { data: T | null; error: string | null; loading: boolean };

/** Fired by RealtimeRefresher whenever a pipeline run is logged (detail: { id, source }). */
export const DATA_EVENT = "viba:data";
export type DataEventDetail = { id: number; source: string };

// Which pipeline runs (refresh_log.source) make each endpoint's data stale.
const STALE_ON: Record<string, string[]> = {
  "/api/smart-money": ["compute-smart-money"],
  "/api/smart-money/insiders": ["sync-insiders"],
  "/api/smart-money/funds": ["sync-13f"],
};

// One in-flight request per endpoint, shared by every component on the page
// (Overview, Plays and Smart Money tabs all read the same payload).
const cache = new Map<string, Promise<unknown>>();
const invalidatedBy = new Map<string, number>();

function load<T>(url: string, bust?: number): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined;
  if (!p) {
    const href = bust ? `${url}${url.includes("?") ? "&" : "?"}v=${bust}` : url;
    p = fetch(href).then(async (r) => {
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
  const [version, setVersion] = useState(0);

  // re-read when the pipeline logs a run that changed this endpoint's data
  useEffect(() => {
    if (!url) return;
    const sources = STALE_ON[url.split("?")[0]] ?? [];
    const onData = (e: Event) => {
      const d = (e as CustomEvent<DataEventDetail>).detail;
      if (!d || !sources.includes(d.source)) return;
      if (invalidatedBy.get(url) !== d.id) {
        invalidatedBy.set(url, d.id);
        cache.delete(url);
      }
      setVersion(d.id);
    };
    window.addEventListener(DATA_EVENT, onData);
    return () => window.removeEventListener(DATA_EVENT, onData);
  }, [url]);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    set((x) => ({ ...x, loading: !x.data }));
    load<T>(url, version || undefined).then(
      (data) => alive && set({ data, error: null, loading: false }),
      (e) => alive && set((x) => ({ data: x.data, error: e instanceof Error ? e.message : "Failed to load", loading: false }))
    );
    return () => {
      alive = false;
    };
  }, [url, version]);
  return s;
}

export const useSmartMoney = () => useEndpoint<SmartMoneyPayload>("/api/smart-money");
export const useFunds = (enabled = true) => useEndpoint<FundsPayload>(enabled ? "/api/smart-money/funds" : null);
export const useInsiders = (symbols: string[]) =>
  useEndpoint<InsidersPayload>(symbols.length ? `/api/smart-money/insiders?symbols=${symbols.join(",")}` : null);
