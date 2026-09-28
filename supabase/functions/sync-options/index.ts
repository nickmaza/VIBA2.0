// sync-options
//
// Real option-market activity for the library, from CBOE's delayed quotes
// (consolidated volume and open interest per contract, 15-minute delayed).
// Each chain is aggregated into one row per symbol per session in
// options_daily:
//   call/put volume, call/put open interest,
//   call/put premium = sum over contracts of volume x last trade price x 100
//   (last trade is the best public proxy for the average fill),
//   IV30 and the underlying price.
// 10-day averages come from the options_latest view as history accumulates.
//
// Body (all optional):
//   group    "queue" (default): stalest optionable symbols first
//            "top": the most active names of the latest session (intraday refresh)
//   symbols  explicit list
//   limit    symbols per run (default 60, max 400; at most ~2.5 chains/second)
//   staleMinutes  queue only: skip chains fetched more recently (default 360;
//            pg_cron passes the minutes since the last close)
//   wait     true = run inline and return the result
//
// Auth: x-refresh-secret. Called by pg_cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, httpGet, withRetry, readBody, runInBackground, pool, sleep } from "../_shared/common.ts";

const KINDS = ["stock", "sector_etf", "index", "input", "flow_asset"];
const CONTRACT_RE = /^(.*?)(\d{6})([CP])(\d{8})$/;

// CBOE's CDN throttles bursts. Requests are spaced out (about 2.5 a second to
// start); every 429 doubles the spacing (up to 4s) and pauses, so a run keeps
// making progress at whatever rate the CDN allows.
let nextSlot = 0;
let gapMs = 400;
async function paced() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + gapMs;
  if (wait) await sleep(wait);
}
async function cboe(sym: string) {
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await paced();
    const r = await httpGet(url, { headers: { Accept: "application/json" }, timeoutMs: 25000 });
    if (r.status !== 429) return r;
    gapMs = Math.min(4000, gapMs * 2);
    nextSlot = Date.now() + 5000 * (attempt + 1);
    await sleep(5000 * (attempt + 1));
  }
  return { status: 429, text: "" };
}

interface Agg {
  d: string;
  call_volume: number;
  put_volume: number;
  call_premium: number;
  put_premium: number;
  call_oi: number;
  put_oi: number;
  contracts: number;
  underlying: number | null;
  iv30: number | null;
}

const num = (x: unknown) => {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
};

// deno-lint-ignore no-explicit-any
function aggregate(j: any): Agg | null {
  const data = j?.data;
  const opts = (data?.options ?? []) as Record<string, unknown>[];
  if (!data || !opts.length) return null;
  let cv = 0, pv = 0, cp = 0, pp = 0, coi = 0, poi = 0, n = 0;
  let lastTrade = "";
  for (const o of opts) {
    const m = CONTRACT_RE.exec(String(o.option ?? ""));
    if (!m) continue;
    n++;
    const call = m[3] === "C";
    const vol = num(o.volume);
    const oi = num(o.open_interest);
    let px = num(o.last_trade_price);
    if (!(px > 0)) {
      const b = num(o.bid), a = num(o.ask);
      px = a > 0 ? (b + a) / 2 : 0;
    }
    const prem = vol * px * 100;
    if (call) {
      cv += vol; cp += prem; coi += oi;
    } else {
      pv += vol; pp += prem; poi += oi;
    }
    const lt = String(o.last_trade_time ?? "");
    if (vol > 0 && lt > lastTrade) lastTrade = lt;
  }
  const session = (String(data.last_trade_time ?? "") || lastTrade || String(j.timestamp ?? "")).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(session)) return null;
  const px = num(data.current_price) || num(data.close);
  const iv = num(data.iv30);
  return {
    d: session,
    call_volume: Math.round(cv),
    put_volume: Math.round(pv),
    call_premium: Math.round(cp),
    put_premium: Math.round(pp),
    call_oi: Math.round(coi),
    put_oi: Math.round(poi),
    contracts: n,
    underlying: px > 0 ? px : null,
    iv30: iv > 0 ? iv : null,
  };
}

async function pickSymbols(body: Record<string, unknown>): Promise<string[]> {
  const limit = Math.min(400, Math.max(1, Number(body.limit ?? 60)));
  if (Array.isArray(body.symbols) && body.symbols.length) {
    return (body.symbols as unknown[]).map((s) => String(s).toUpperCase()).slice(0, 400);
  }
  if (body.group === "top") {
    const top = ((await withRetry("options_top_symbols", () => sb.rpc("options_top_symbols", { n: limit }))) ?? []) as unknown[];
    return top.map((x) => (typeof x === "string" ? x : String((x as Record<string, unknown>).options_top_symbols ?? ""))).filter(Boolean);
  }
  const fresh = new Date(Date.now() - Math.max(1, Number(body.staleMinutes ?? 360)) * 60000).toISOString();
  const recheck = new Date(Date.now() - 7 * 86400e3).toISOString();
  const rows = ((await withRetry("symbol_meta options queue", () =>
    sb
      .from("symbol_meta")
      .select("symbol")
      .eq("active", true)
      .in("kind", KINDS)
      .or(`optionable.is.null,optionable.is.true,options_synced_at.lt.${recheck}`)
      .or(`options_synced_at.is.null,options_synced_at.lt.${fresh}`)
      .order("options_synced_at", { ascending: true, nullsFirst: true })
      .order("symbol")
      .limit(limit)
  )) ?? []) as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

async function run(body: Record<string, unknown>) {
  const t0 = Date.now();
  gapMs = 400;
  const group = Array.isArray(body.symbols) && body.symbols.length ? "symbols" : body.group === "top" ? "top" : "queue";
  const symbols = await pickSymbols(body);
  if (!symbols.length) return { ok: true, note: `group=${group} nothing to sync` };

  const out: Record<string, unknown>[] = [];
  const marks: { symbol: string; optionable: boolean | null }[] = [];
  const errors: string[] = [];
  let none = 0;
  let throttled = 0;

  await pool(symbols, 3, async (sym) => {
    if (Date.now() - t0 > 100000 || throttled >= 6) return; // leave the rest for the next run
    const r = await cboe(sym);
    if (r.status === 429) {
      throttled++;
      return;
    }
    if (r.status === 403 || r.status === 404) {
      none++;
      marks.push({ symbol: sym, optionable: false });
      return;
    }
    if (r.status !== 200) {
      // counted as attempted (retried after the next close) so one bad chain
      // cannot keep the evening sweep looping
      errors.push(`${sym}: HTTP ${r.status}`);
      marks.push({ symbol: sym, optionable: null });
      return;
    }
    let agg: Agg | null = null;
    try {
      agg = aggregate(JSON.parse(r.text));
    } catch (e) {
      errors.push(`${sym}: ${e instanceof Error ? e.message : String(e)}`);
      marks.push({ symbol: sym, optionable: null });
      return;
    }
    if (!agg) {
      none++;
      marks.push({ symbol: sym, optionable: false });
      return;
    }
    out.push({ symbol: sym, ...agg, source: "cboe", fetched_at: new Date().toISOString() });
    marks.push({ symbol: sym, optionable: true });
  });

  if (out.length) {
    await withRetry("options_daily upsert", () => sb.from("options_daily").upsert(out, { onConflict: "symbol,d" }));
  }
  if (marks.length) await withRetry("mark_options_sync", () => sb.rpc("mark_options_sync", { p_rows: marks }));

  const sessions = Array.from(new Set(out.map((o) => String(o.d)))).sort();
  const note =
    `group=${group} chains=${out.length}/${symbols.length} no_options=${none} sessions=${sessions.join(",") || "-"} ` +
    (throttled ? `throttled=${throttled} ` : "") +
    `${((Date.now() - t0) / 1000).toFixed(1)}s` +
    (errors.length ? ` errors=${errors.length} [${errors.slice(0, 6).join("; ")}]` : "");
  const ok = out.length > 0 || errors.length === 0;
  await logRun("sync-options", ok, note);
  return { ok, chains: out.length, attempted: symbols.length, errors, note };
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  return runInBackground(async () => {
    try {
      return await run(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logRun("sync-options", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
