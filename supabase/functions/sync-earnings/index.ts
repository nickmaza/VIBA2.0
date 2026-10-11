// sync-earnings
//
// Upcoming earnings dates for the library from Nasdaq's public earnings
// calendar (api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD), one request
// per weekday for the next 60 days -> earnings_calendar. Rows are upserted, so
// past report dates stay (compute-predictive needs them to score outcomes);
// a future date that no longer appears is left with an older updated_at and
// ignored by readers after a few days.
//
// Body: { days?, wait? }. Auth: x-refresh-secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, httpGet, upsertChunks, readBody, runInBackground, sleep, isoDate } from "../_shared/common.ts";

const NASDAQ_HEADERS = {
  Accept: "application/json, text/plain, */*",
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
};

const TIME: Record<string, string> = {
  "time-pre-market": "pre-market",
  "time-after-hours": "after-hours",
  "time-not-supplied": "not supplied",
};

/** "$0.23" -> 0.23, "($0.12)" -> -0.12, "" -> null */
function money(s: unknown): number | null {
  const t = String(s ?? "").trim();
  if (!t || t === "N/A") return null;
  const neg = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[()$,\s]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

async function loadLibrary(): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("symbol_meta").select("symbol").eq("active", true).range(from, from + 999);
    if (error) throw new Error(`symbol_meta: ${error.message}`);
    for (const r of data ?? []) out.add(String(r.symbol));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function run(days: number) {
  const t0 = Date.now();
  const library = await loadLibrary();
  const rows = new Map<string, Record<string, unknown>>();
  let answered = 0;
  let failed = 0;
  let weekdays = 0;
  const now = new Date().toISOString();
  for (let i = 0; i <= days; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    weekdays++;
    const date = isoDate(d);
    let r = await httpGet(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, { headers: NASDAQ_HEADERS, timeoutMs: 20_000 });
    if (r.status !== 200) {
      await sleep(3_000);
      r = await httpGet(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, { headers: NASDAQ_HEADERS, timeoutMs: 20_000 });
    }
    if (r.status !== 200) {
      failed++;
      continue;
    }
    let list: Record<string, string>[] = [];
    try {
      list = (JSON.parse(r.text)?.data?.rows ?? []) as Record<string, string>[];
    } catch {
      failed++;
      continue;
    }
    answered++;
    for (const x of list) {
      const ticker = String(x.symbol ?? "").trim().toUpperCase().replace("/", ".");
      if (!library.has(ticker)) continue;
      rows.set(`${ticker}|${date}`, {
        ticker,
        report_date: date,
        time_of_day: TIME[String(x.time ?? "")] ?? null,
        fiscal_quarter: x.fiscalQuarterEnding || null,
        eps_forecast: money(x.epsForecast),
        n_estimates: Number(x.noOfEsts) || null,
        updated_at: now,
      });
    }
    await sleep(400);
  }
  const all = Array.from(rows.values());
  if (all.length) await upsertChunks("earnings_calendar", all, "ticker,report_date", 500);
  const ok = answered > 0 && failed <= Math.ceil(weekdays / 4);
  const note = `days=${days} weekdays=${weekdays} answered=${answered} failed=${failed} reports=${all.length} ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  await logRun("sync-earnings", ok, note);
  return { ok, note };
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  const days = Math.max(1, Math.min(90, Number(body.days ?? 60)));
  return runInBackground(async () => {
    try {
      return await run(days);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logRun("sync-earnings", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
