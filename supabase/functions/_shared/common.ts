// Shared helpers for the VIBA Terminal edge functions.
//
// Every function that writes data is guarded by the x-refresh-secret header
// and is meant to be called by pg_cron (through private.invoke_edge) or by an
// operator -- never by a browser. The secret lives only in Supabase Vault
// ("refresh_secret"); functions read it through the service-role-only RPC
// public.edge_refresh_secret(), so it never appears in source code.
import { createClient } from "jsr:@supabase/supabase-js@2";

export const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The REST gateway occasionally answers a good request with an instant 504 or
// a cold-start "JWT issued at future"; both clear within seconds.
function isTransient(msg: string): boolean {
  return /timeout|gateway|\b50[234]\b|fetch failed|network|connection|ECONNRESET|EPIPE|issued at future|jwt/i.test(msg);
}

export async function withRetry<T>(
  label: string,
  fn: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
  attempts = 4,
): Promise<T | null> {
  let lastMsg = "";
  for (let i = 0; i < attempts; i++) {
    let res: { data: T | null; error: { message: string } | null };
    try {
      res = await fn();
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e);
      if (!isTransient(lastMsg)) throw new Error(`${label}: ${lastMsg}`);
      await sleep(800 * (i + 1));
      continue;
    }
    if (!res.error) return res.data;
    lastMsg = res.error.message;
    if (!isTransient(lastMsg)) throw new Error(`${label}: ${lastMsg}`);
    await sleep(800 * (i + 1));
  }
  throw new Error(`${label}: ${lastMsg} (gave up after ${attempts} attempts)`);
}

let secretCache: { value: string; at: number } | null = null;
async function loadSecret(maxAgeMs: number): Promise<string | null> {
  if (secretCache && Date.now() - secretCache.at < maxAgeMs) return secretCache.value;
  try {
    const { data, error } = await sb.rpc("edge_refresh_secret");
    if (!error && typeof data === "string" && data) secretCache = { value: data, at: Date.now() };
  } catch {
    /* keep the cached value */
  }
  return secretCache?.value ?? null;
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** True when the request carries the refresh secret stored in Vault. */
export async function authorized(req: Request): Promise<boolean> {
  const got = req.headers.get("x-refresh-secret");
  if (!got) return false;
  const want = await loadSecret(600_000);
  if (want && sameText(got, want)) return true;
  const fresh = await loadSecret(30_000); // the secret may have just been rotated
  return !!fresh && sameText(got, fresh);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Append a run to refresh_log. Logging must never fail the run. */
export async function logRun(source: string, ok: boolean, note: string): Promise<void> {
  try {
    await sb.from("refresh_log").insert({ source, ok, note: note.slice(0, 1500) });
  } catch {
    /* ignore */
  }
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const t = await req.text();
    return t ? (JSON.parse(t) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Run async jobs with a concurrency cap. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

export interface Fetched {
  status: number;
  text: string;
  bytes?: Uint8Array;
}

export async function httpGet(
  url: string,
  opts: { ua?: string; headers?: Record<string, string>; timeoutMs?: number; binary?: boolean } = {},
): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": opts.ua ?? UA_BROWSER, ...(opts.headers ?? {}) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
    if (opts.binary) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, text: "", bytes };
    }
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: -1, text: e instanceof Error ? e.message : String(e) };
  }
}

/** Upsert in chunks (PostgREST requests stay small and fast). */
export async function upsertChunks(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  chunk = 1000,
): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    await withRetry(`${table} upsert`, () => sb.from(table).upsert(part, { onConflict }));
    n += part.length;
  }
  return n;
}

export async function getConfig(key: string, fallback: string): Promise<string> {
  try {
    const { data } = await sb.from("pipeline_config").select("value").eq("key", key).maybeSingle();
    return (data as { value?: string } | null)?.value ?? fallback;
  } catch {
    return fallback;
  }
}

/** Library symbols use "." for share classes (BRK.B); Yahoo uses "-" (BRK-B). */
export const yahooSymbol = (s: string) => s.replace(/\./g, "-");

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** US equity session state in New York time. */
export function marketClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  const weekday = get("weekday");
  const weekend = weekday === "Sat" || weekday === "Sun";
  return {
    nyDate: `${get("year")}-${get("month")}-${get("day")}`,
    open: !weekend && minutes >= 570 && minutes < 960, // 09:30-16:00 ET
    weekend,
    minutes,
  };
}

/** Run `work` after answering, unless the caller asked to wait for the result. */
export function runInBackground(work: () => Promise<unknown>, wait: boolean): Promise<Response> | Response {
  if (wait) {
    return work().then(
      (r) => json(r),
      (e) => json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500),
    );
  }
  const p = work().catch(() => {});
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
  return json({ ok: true, accepted: true });
}
