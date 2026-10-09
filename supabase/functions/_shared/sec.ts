// SEC EDGAR access shared by sync-directory and sync-13f.
//
// SEC allows 10 requests a second per client and answers HTTP 429 above that
// (the block lifts after traffic stays under the limit for a few minutes).
// Supabase edge functions leave through egress addresses shared with other
// projects, so SEC can refuse a request even when this project sends very
// little. Requests here are spaced out, a refused request is retried with
// backoff, and once SEC is still refusing after the retries the rest of the
// run fails fast instead of waiting on every remaining request. The callers
// report the failure and pg_cron retries the job (private.retry_due).
import { sleep, getConfig } from "./common.ts";
import type { Fetched } from "./common.ts";

const DEFAULT_UA = "VIBA Terminal research dashboard";
const RETRY_STATUS = new Set([-1, 429, 500, 502, 503, 504]);
const WAITS_MS = [3_000, 10_000, 25_000];
const MIN_GAP_MS = 150; // about 6 requests a second at most
const BLOCK_MS = 5 * 60_000;

let lastRequestAt = 0;
let blockedUntil = 0;
let uaCache: string | null = null;

export interface SecFetched extends Fetched {
  attempts: number;
}

/** The User-Agent SEC sees (pipeline_config.sec_user_agent). */
export async function secUserAgent(): Promise<string> {
  if (!uaCache) uaCache = await getConfig("sec_user_agent", DEFAULT_UA);
  return uaCache;
}

/** GET an SEC URL: requests are spaced out; 429s and server errors are retried with backoff. */
export async function secGet(url: string, opts: { timeoutMs?: number } = {}): Promise<SecFetched> {
  if (Date.now() < blockedUntil) return { status: 429, text: "skipped: SEC is rate-limiting this run", attempts: 0 };
  const ua = await secUserAgent();
  let last: SecFetched = { status: -1, text: "", attempts: 0 };
  for (let attempt = 0; attempt <= WAITS_MS.length; attempt++) {
    const gap = lastRequestAt + MIN_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastRequestAt = Date.now();
    let retryAfterMs = 0;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": ua, Accept: "application/json, application/xml, text/xml, text/plain, */*" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = Math.min(retryAfter, 60) * 1000;
      last = { status: res.status, text: await res.text(), attempts: attempt + 1 };
    } catch (e) {
      last = { status: -1, text: e instanceof Error ? e.message : String(e), attempts: attempt + 1 };
    }
    if (!RETRY_STATUS.has(last.status)) return last;
    if (attempt < WAITS_MS.length) await sleep(Math.max(WAITS_MS[attempt], retryAfterMs));
  }
  if (last.status === 429) blockedUntil = Date.now() + BLOCK_MS;
  return last;
}

/** One-line description of a failed SEC request for refresh_log notes. */
export function secError(what: string, r: SecFetched): string {
  if (r.attempts === 0) return `${what}: skipped (SEC rate limit)`;
  const why =
    r.status === 429 ? "SEC rate limit (HTTP 429)" : r.status === -1 ? `network error (${r.text.slice(0, 80)})` : `HTTP ${r.status}`;
  return `${what}: ${why} after ${r.attempts} attempt${r.attempts === 1 ? "" : "s"}`;
}
