// sync-insiders
//
// Open-market insider buying and selling (SEC Form 4, transaction codes P and
// S) for every stock in the library, straight from SEC EDGAR:
//   index    EDGAR's daily form index lists every Form 4 filed that day; the
//            filings whose CIK belongs to a library stock are queued
//            (sec_form4_queue, deduped by accession number)
//   process  each queued filing's submission text is fetched and its
//            non-derivative P/S transactions are stored in insider_trades
//
// Body (all optional):
//   mode   "both" (default) | "index" | "process"
//   days   index lookback in days (default 4; use ~95 once for a backfill)
//   limit  filings to process this run (default 200)
//   wait   true = run inline and return the result
//
// Stays under SEC's 10 requests/second fair-access limit and identifies
// itself with pipeline_config.sec_user_agent. Auth: x-refresh-secret.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sb, authorized, json, logRun, httpGet, withRetry, readBody, runInBackground, pool, sleep, getConfig } from "../_shared/common.ts";

let UA = "VIBA Terminal research dashboard";

// ---- pacing: at most ~8 SEC requests per second across all workers ----
let nextSlot = 0;
async function paced() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 125;
  if (wait) await sleep(wait);
}
async function secGet(url: string) {
  await paced();
  return httpGet(url, { ua: UA, headers: { Accept: "text/plain, application/xml, */*" }, timeoutMs: 20000 });
}

async function libraryCiks(): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  for (let from = 0; from < 10000; from += 1000) {
    const rows = ((await withRetry("symbol_meta ciks", () =>
      sb.from("symbol_meta").select("symbol,cik").eq("kind", "stock").not("cik", "is", null).order("symbol").range(from, from + 999)
    )) ?? []) as { symbol: string; cik: number }[];
    for (const r of rows) map.set(Number(r.cik), [...(map.get(Number(r.cik)) ?? []), r.symbol]);
    if (rows.length < 1000) break;
  }
  return map;
}

// ---------------- index ----------------
function ymd(d: Date) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function indexDays(days: number, ciks: Map<number, string[]>, deadline: number) {
  const today = new Date();
  const dates: Date[] = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(today.getTime() - i * 86400e3);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    dates.push(d);
  }
  const iso = dates.map((d) => d.toISOString().slice(0, 10));
  const { data: done } = await sb.from("sec_index_log").select("d,status").in("d", iso);
  const doneSet = new Set(((done ?? []) as { d: string; status: string }[]).filter((r) => r.status === "done").map((r) => r.d));
  const recent = new Set(iso.slice(0, 2)); // today's and yesterday's indexes can still grow: always re-read
  let queued = 0, read = 0, missing = 0;
  for (const d of dates) {
    if (Date.now() > deadline) break; // the rest is picked up by the next run
    const key = d.toISOString().slice(0, 10);
    if (doneSet.has(key) && !recent.has(key)) continue;
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    const r = await secGet(`https://www.sec.gov/Archives/edgar/daily-index/${d.getUTCFullYear()}/QTR${q}/form.${ymd(d)}.idx`);
    if (r.status === 404 || r.status === 403) {
      missing++;
      await sb.from("sec_index_log").upsert({ d: key, status: r.status === 404 ? "missing" : `http_${r.status}`, processed_at: new Date().toISOString() }, { onConflict: "d" });
      continue;
    }
    if (r.status !== 200) continue;
    read++;
    const rows = new Map<string, Record<string, unknown>>();
    let form4 = 0;
    for (const line of r.text.split("\n")) {
      const m = /^4\s+.+?\s+(\d{1,10})\s+(\d{8})\s+(edgar\/\S+\.txt)\s*$/.exec(line);
      if (!m) continue;
      form4++;
      const cik = Number(m[1]);
      if (!ciks.has(cik)) continue;
      const path = m[3];
      const accession = path.split("/").pop()!.replace(/\.txt$/, "");
      if (rows.has(accession)) continue;
      rows.set(accession, {
        accession,
        cik,
        path,
        filed: `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`,
        status: "pending",
      });
    }
    const list = Array.from(rows.values());
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      await withRetry("sec_form4_queue insert", () => sb.from("sec_form4_queue").upsert(part, { onConflict: "accession", ignoreDuplicates: true }));
    }
    queued += list.length;
    await sb.from("sec_index_log").upsert({ d: key, status: "done", form4, queued: list.length, processed_at: new Date().toISOString() }, { onConflict: "d" });
  }
  return { read, queued, missing };
}

// ---------------- process ----------------
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`));
  return m ? m[1].trim() : null;
}
function val(xml: string, name: string): string | null {
  const inner = tag(xml, name);
  if (inner === null) return null;
  const v = tag(inner, "value");
  return (v ?? inner).replace(/<[^>]+>/g, "").trim();
}
function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
const numOf = (s: string | null) => {
  const n = s === null ? NaN : Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
function roleOf(owner: string): string {
  const rel = tag(owner, "reportingOwnerRelationship") ?? "";
  const parts: string[] = [];
  const t = tag(rel, "officerTitle");
  if (t) parts.push(t.replace(/&amp;/g, "&"));
  if (/<isDirector>\s*(1|true)/i.test(rel)) parts.push("Director");
  if (/<isTenPercentOwner>\s*(1|true)/i.test(rel)) parts.push("10% owner");
  return parts.join(", ") || "Insider";
}

async function processQueue(limit: number, ciks: Map<number, string[]>, deadline: number) {
  const { data } = await sb
    .from("sec_form4_queue")
    .select("accession,cik,path,filed,attempts")
    .eq("status", "pending")
    .order("filed", { ascending: false })
    .limit(limit);
  const items = (data ?? []) as { accession: string; cik: number; path: string; filed: string; attempts: number }[];
  const trades: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  let parsed = 0, failed = 0;
  await pool(items, 5, async (q) => {
    if (Date.now() > deadline) return;
    const r = await secGet(`https://www.sec.gov/Archives/${q.path}`);
    const now = new Date().toISOString();
    if (r.status !== 200) {
      failed++;
      updates.push({ ...q, status: q.attempts + 1 >= 4 ? "error" : "pending", attempts: q.attempts + 1, error: `HTTP ${r.status}`, updated_at: now });
      return;
    }
    const doc = r.text.match(/<ownershipDocument>([\s\S]*?)<\/ownershipDocument>/)?.[1];
    if (!doc) {
      updates.push({ ...q, status: "done", error: "no ownershipDocument", updated_at: now });
      return;
    }
    const issuer = tag(doc, "issuer") ?? "";
    const issuerCik = Number(tag(issuer, "issuerCik") ?? "0");
    const issuerSym = (tag(issuer, "issuerTradingSymbol") ?? "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
    const lib = ciks.get(issuerCik) ?? [];
    const symbol = lib.includes(issuerSym) ? issuerSym : lib[0];
    if (!symbol) {
      updates.push({ ...q, status: "done", error: "issuer not in library", updated_at: now });
      return;
    }
    const owners = blocks(doc, "reportingOwner");
    const names = owners.map((o) => (tag(o, "rptOwnerName") ?? "").replace(/&amp;/g, "&")).filter(Boolean);
    const role = owners.length ? roleOf(owners[0]) : "Insider";
    const accDir = q.path.replace(/\.txt$/, "-index.htm");
    let seq = 0;
    for (const t of blocks(doc, "nonDerivativeTransaction")) {
      seq++;
      const code = tag(tag(t, "transactionCoding") ?? "", "transactionCode");
      if (code !== "P" && code !== "S") continue;
      const shares = numOf(val(t, "transactionShares"));
      const price = numOf(val(t, "transactionPricePerShare"));
      trades.push({
        accession: q.accession,
        seq,
        symbol,
        issuer_cik: issuerCik || q.cik,
        insider: names.join(" / ").slice(0, 200) || "Insider",
        role: role.slice(0, 200),
        code,
        traded: (val(t, "transactionDate") ?? q.filed).slice(0, 10),
        filed: q.filed,
        shares,
        price,
        value: Math.round(shares * price * 100) / 100,
        url: `https://www.sec.gov/Archives/${accDir}`,
      });
    }
    parsed++;
    updates.push({ ...q, status: "done", error: null, updated_at: now });
  });
  for (let i = 0; i < trades.length; i += 500) {
    const part = trades.slice(i, i + 500);
    await withRetry("insider_trades upsert", () => sb.from("insider_trades").upsert(part, { onConflict: "accession,seq" }));
  }
  for (let i = 0; i < updates.length; i += 500) {
    const part = updates.slice(i, i + 500);
    await withRetry("sec_form4_queue update", () => sb.from("sec_form4_queue").upsert(part, { onConflict: "accession" }));
  }
  return { picked: items.length, parsed, failed, trades: trades.length };
}

async function run(body: Record<string, unknown>) {
  const t0 = Date.now();
  UA = await getConfig("sec_user_agent", UA);
  const mode = String(body.mode ?? "both");
  const ciks = await libraryCiks();
  const notes: string[] = [`library_ciks=${ciks.size}`];
  if (mode === "both" || mode === "index") {
    const ix = await indexDays(Math.min(120, Math.max(1, Number(body.days ?? 4))), ciks, t0 + 80000);
    notes.push(`indexes_read=${ix.read} queued=${ix.queued} not_published=${ix.missing}`);
  }
  if (mode === "both" || mode === "process") {
    const pr = await processQueue(Math.min(800, Math.max(1, Number(body.limit ?? 200))), ciks, t0 + 105000);
    const { count } = await sb.from("sec_form4_queue").select("accession", { count: "exact", head: true }).eq("status", "pending");
    notes.push(`filings_parsed=${pr.parsed}/${pr.picked} buys_sells=${pr.trades} failed=${pr.failed} pending=${count ?? "?"}`);
  }
  notes.push(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const note = notes.join(" ");
  await logRun("sync-insiders", true, note);
  return { ok: true, note };
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  const body = await readBody(req);
  return runInBackground(async () => {
    try {
      return await run(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logRun("sync-insiders", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
