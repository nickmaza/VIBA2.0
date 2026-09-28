// sync-congress
//
// STOCK Act periodic transaction reports (PTRs), straight from the official
// disclosure sites:
//   Senate  efdsearch.senate.gov -- electronic PTRs are HTML tables
//   House   disclosures-clerk.house.gov -- annual filing index (zip/XML) + PTR PDFs,
//           parsed to text
// Party affiliation comes from the public congress-legislators dataset
// (unitedstates.github.io/congress-legislators).
//
// Each run: refresh members weekly, discover new PTR filings (at most every
// 6 hours, or when {discover:true}), then parse up to `limit` pending filings
// into congress_trades. Scanned paper filings have no text and are marked
// 'paper'.
//
// Body (all optional): days (discovery window, default 120), limit (default 12),
// discover (force), wait.
// Auth: x-refresh-secret. Called by pg_cron.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { unzipSync, strFromU8 } from "npm:fflate@0.8.2";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";
import { sb, authorized, json, logRun, httpGet, withRetry, readBody, runInBackground, upsertChunks, UA_BROWSER } from "../_shared/common.ts";

const SENATE = "https://efdsearch.senate.gov";
const HOUSE = "https://disclosures-clerk.house.gov/public_disc";

// ---------------- helpers ----------------
const mdY = (s: string): string | null => {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};
const fmtUsd = (n: number) => (n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`);
function amountRange(raw: string): { text: string; low: number | null; high: number | null } {
  const nums = (raw.match(/\$[\d,]+/g) ?? []).map((x) => Number(x.replace(/[$,]/g, "")));
  if (/over/i.test(raw) && nums.length) return { text: `Over ${fmtUsd(nums[0])}`, low: nums[0], high: null };
  if (nums.length >= 2) return { text: `${fmtUsd(nums[0])}–${fmtUsd(nums[1])}`, low: nums[0], high: nums[1] };
  if (nums.length === 1) return { text: fmtUsd(nums[0]), low: nums[0], high: nums[0] };
  return { text: raw.trim(), low: null, high: null };
}
const normName = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|hon|dr|mr|mrs|ms)\b\.?/g, " ")
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const lastToken = (s: string) => normName(s).split(" ").filter(Boolean).pop() ?? "";

function cookieJar() {
  const jar = new Map<string, string>();
  return {
    take(res: Response) {
      // deno-lint-ignore no-explicit-any
      const list: string[] = (res.headers as any).getSetCookie?.() ?? [];
      for (const c of list) {
        const kv = c.split(";")[0];
        const i = kv.indexOf("=");
        if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
    },
    header: () => Array.from(jar).map(([k, v]) => `${k}=${v}`).join("; "),
    get: (k: string) => jar.get(k),
  };
}

// ---------------- members (party lookup) ----------------
interface Member {
  chamber: string;
  first: string;
  last: string;
  state: string;
  district: number | null;
  party: string;
}

async function refreshMembers(): Promise<number> {
  const { data } = await sb.from("congress_members").select("updated_at").order("updated_at", { ascending: false }).limit(1);
  const newest = (data as { updated_at: string }[] | null)?.[0]?.updated_at;
  if (newest && Date.now() - Date.parse(newest) < 7 * 86400e3) return 0;
  const r = await httpGet("https://unitedstates.github.io/congress-legislators/legislators-current.json", { timeoutMs: 30000 });
  if (r.status !== 200) return 0;
  // deno-lint-ignore no-explicit-any
  const list = JSON.parse(r.text) as any[];
  const now = new Date().toISOString();
  const rows = list.map((x) => {
    const t = x.terms?.[x.terms.length - 1] ?? {};
    return {
      bioguide: x.id?.bioguide,
      chamber: t.type === "sen" ? "senate" : "house",
      first_name: x.name?.first ?? null,
      last_name: x.name?.last ?? null,
      full_name: x.name?.official_full ?? `${x.name?.first ?? ""} ${x.name?.last ?? ""}`.trim(),
      state: t.state ?? null,
      district: typeof t.district === "number" ? t.district : null,
      party: t.party ?? null,
      updated_at: now,
    };
  }).filter((r) => r.bioguide);
  await upsertChunks("congress_members", rows, "bioguide", 500);
  return rows.length;
}

async function loadMembers(): Promise<Member[]> {
  const { data } = await sb.from("congress_members").select("chamber,first_name,last_name,state,district,party").limit(1000);
  return ((data ?? []) as Record<string, unknown>[]).map((m) => ({
    chamber: String(m.chamber),
    first: String(m.first_name ?? ""),
    last: String(m.last_name ?? ""),
    state: String(m.state ?? ""),
    district: typeof m.district === "number" ? m.district : null,
    party: String(m.party ?? ""),
  }));
}

function partyFor(members: Member[], chamber: string, first: string, last: string, stateDst?: string | null): string | null {
  const L = lastToken(last);
  const pool = members.filter((m) => m.chamber === chamber && lastToken(m.last) === L);
  if (pool.length === 1) return pool[0].party || null;
  if (stateDst) {
    const st = stateDst.slice(0, 2);
    const byState = pool.filter((m) => m.state === st);
    if (byState.length === 1) return byState[0].party || null;
  }
  const F = normName(first).split(" ")[0] ?? "";
  const byFirst = pool.filter((m) => normName(m.first).startsWith(F) || F.startsWith(normName(m.first)));
  return byFirst.length === 1 ? byFirst[0].party || null : null;
}

// ---------------- Senate ----------------
async function senateSession() {
  const jar = cookieJar();
  const home = await fetch(`${SENATE}/search/home/`, { headers: { "User-Agent": UA_BROWSER }, redirect: "manual" });
  jar.take(home);
  const html = await home.text();
  const token = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1] ?? "";
  const agree = await fetch(`${SENATE}/search/home/`, {
    method: "POST",
    headers: { "User-Agent": UA_BROWSER, "Content-Type": "application/x-www-form-urlencoded", Referer: `${SENATE}/search/home/`, Cookie: jar.header() },
    body: new URLSearchParams({ prohibition_agreement: "1", csrfmiddlewaretoken: token }).toString(),
    redirect: "manual",
  });
  jar.take(agree);
  await agree.text();
  if (!jar.get("sessionid")) throw new Error("senate eFD: agreement did not create a session");
  return jar;
}

async function discoverSenate(days: number): Promise<Record<string, unknown>[]> {
  const jar = await senateSession();
  const since = new Date(Date.now() - days * 86400e3);
  const start = `${String(since.getUTCMonth() + 1).padStart(2, "0")}/${String(since.getUTCDate()).padStart(2, "0")}/${since.getUTCFullYear()} 00:00:00`;
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const csrf = jar.get("csrftoken") ?? "";
    const res = await fetch(`${SENATE}/search/report/data/`, {
      method: "POST",
      headers: {
        "User-Agent": UA_BROWSER,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${SENATE}/search/`,
        "X-CSRFToken": csrf,
        Cookie: jar.header(),
      },
      body: new URLSearchParams({
        start: String(offset), length: "100", report_types: "[11]", filer_types: "[]",
        submitted_start_date: start, submitted_end_date: "", candidate_state: "", senator_state: "",
        office_id: "", first_name: "", last_name: "", csrfmiddlewaretoken: csrf,
      }).toString(),
    });
    if (res.status !== 200) throw new Error(`senate eFD search HTTP ${res.status}`);
    const rows = ((await res.json())?.data ?? []) as string[][];
    for (const r of rows) {
      const href = String(r[3] ?? "").match(/href="([^"]+)"/)?.[1];
      if (!href) continue;
      const uuid = href.split("/").filter(Boolean).pop();
      const paper = /\/paper\//.test(href);
      out.push({
        id: `senate:${uuid}`,
        chamber: "senate",
        filer: `${r[0]} ${r[1]}`.replace(/\s+/g, " ").trim(),
        first_name: r[0],
        last_name: r[1],
        state_district: null,
        filed: mdY(String(r[4] ?? "")),
        url: `${SENATE}${href}`,
        status: paper ? "paper" : "pending",
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}

async function processSenate(f: Record<string, string>, members: Member[], jar: ReturnType<typeof cookieJar>) {
  const res = await fetch(f.url, { headers: { "User-Agent": UA_BROWSER, Cookie: jar.header(), Referer: `${SENATE}/search/` } });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  const party = partyFor(members, "senate", f.first_name ?? "", f.last_name ?? "");
  const politician = `Sen. ${f.filer}`;
  const trades: Record<string, unknown>[] = [];
  const trs = tbody.split(/<tr[^>]*>/).slice(1);
  trs.forEach((tr, i) => {
    const td = tr.split(/<td[^>]*>/).slice(1).map((x) => x.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim());
    if (td.length < 8) return;
    const [, date, owner, ticker, asset, assetType, type, amount] = td;
    const sym = ticker.toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
    if (!sym || sym === "--" || !/^[A-Z]{1,5}([.\-][A-Z])?$/.test(sym)) return;
    const side = /purchase/i.test(type) ? "BUY" : /sale/i.test(type) ? "SELL" : null;
    if (!side) return;
    const amt = amountRange(amount);
    trades.push({
      id: `${f.id}:${i}`,
      filing_id: f.id,
      symbol: sym.replace("-", "."),
      asset: asset.slice(0, 200),
      asset_type: assetType || null,
      politician,
      chamber: "senate",
      party,
      owner: owner || null,
      side,
      amount: amt.text,
      amount_low: amt.low,
      amount_high: amt.high,
      traded: mdY(date),
      disclosed: f.filed,
      source_url: f.url,
    });
  });
  return trades;
}

// ---------------- House ----------------
async function discoverHouse(days: number): Promise<Record<string, unknown>[]> {
  const now = new Date();
  const years = [now.getUTCFullYear()];
  if (now.getUTCMonth() < 5) years.push(now.getUTCFullYear() - 1);
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const out: Record<string, unknown>[] = [];
  for (const y of years) {
    const r = await httpGet(`${HOUSE}/financial-pdfs/${y}FD.zip`, { binary: true, timeoutMs: 30000 });
    if (r.status !== 200 || !r.bytes) continue;
    const files = unzipSync(r.bytes);
    const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".xml"));
    if (!name) continue;
    const xml = strFromU8(files[name]);
    for (const m of xml.split("<Member>").slice(1)) {
      const tag = (t: string) => m.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1]?.trim() ?? "";
      if (tag("FilingType") !== "P") continue;
      const filed = mdY(tag("FilingDate"));
      if (!filed || filed < cutoff) continue;
      const doc = tag("DocID");
      if (!doc) continue;
      const first = tag("First"), last = tag("Last"), suffix = tag("Suffix");
      out.push({
        id: `house:${doc}`,
        chamber: "house",
        filer: `${first} ${last}${suffix ? `, ${suffix}` : ""}`.trim(),
        first_name: first,
        last_name: last,
        state_district: tag("StateDst") || null,
        filed,
        url: `${HOUSE}/ptr-pdfs/${y}/${doc}.pdf`,
        status: "pending",
      });
    }
  }
  return out;
}

const HOUSE_TX =
  /(?:\b(SP|JT|DC)\s+)?([^()\[\]]{2,200}?)\s*\(([A-Z][A-Z0-9.\-]{0,9})\)\s*\[([A-Z]{2})\]\s*(P|S\s*\(partial\)|S|E)\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+((?:Spouse\/DC\s+)?Over\s+\$[\d,]+|\$[\d,]+\s*-\s*\$[\d,]+|\$[\d,]+)/g;

async function processHouse(f: Record<string, string>, members: Member[]) {
  const r = await httpGet(f.url, { binary: true, timeoutMs: 30000 });
  if (r.status !== 200 || !r.bytes) throw new Error(`HTTP ${r.status}`);
  const pdf = await getDocumentProxy(r.bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  const flat = String(text).replace(/\u0000/g, "").replace(/\s+/g, " ");
  if (flat.length < 80 || !/Transaction|Asset/i.test(flat)) return null; // scanned image, no text layer
  const party = partyFor(members, "house", f.first_name ?? "", f.last_name ?? "", f.state_district);
  const politician = `Rep. ${f.filer}`;
  const trades: Record<string, unknown>[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  HOUSE_TX.lastIndex = 0;
  while ((m = HOUSE_TX.exec(flat))) {
    const [, ownerLead, assetRaw, ticker, code, type, traded, , amount] = m;
    if (!["ST", "OP", "EF"].includes(code)) continue;
    const side = type.startsWith("P") ? "BUY" : type.startsWith("S") ? "SELL" : null;
    if (!side) continue;
    // The text run before "(TICKER)" also carries the previous row's filing-status /
    // sub-account lines; the owner code (SP spouse, JT joint, DC dependent) sits right
    // before the asset name, so the last code in the run is this row's owner.
    let owner: string | null = ownerLead ?? null;
    let asset = assetRaw;
    const codes = [...assetRaw.matchAll(/(?:^|\s)(SP|JT|DC)\s+/g)];
    if (codes.length) {
      const last = codes[codes.length - 1];
      owner = last[1];
      asset = assetRaw.slice((last.index ?? 0) + last[0].length);
    }
    asset = asset
      .replace(/^.*?(Cap\. Gains > \$200\?|Filing ID #\d+|Amount Cap\.?)\s*/i, "")
      .replace(/^.*\bS O:\s*/i, "")
      .trim()
      .slice(-120);
    const amt = amountRange(amount);
    trades.push({
      id: `${f.id}:${i++}`,
      filing_id: f.id,
      symbol: ticker.replace("-", "."),
      asset,
      asset_type: code === "OP" ? "Option" : code === "EF" ? "ETF" : "Stock",
      politician,
      chamber: "house",
      party,
      owner: owner === "SP" ? "Spouse" : owner === "JT" ? "Joint" : owner === "DC" ? "Dependent" : owner,
      side,
      amount: amt.text,
      amount_low: amt.low,
      amount_high: amt.high,
      traded: mdY(traded),
      disclosed: f.filed,
      source_url: f.url,
    });
  }
  return trades;
}

// ---------------- run ----------------
async function run(body: Record<string, unknown>) {
  const t0 = Date.now();
  const days = Math.min(400, Math.max(7, Number(body.days ?? 120)));
  const limit = Math.min(40, Math.max(1, Number(body.limit ?? 12)));
  const notes: string[] = [];

  const membersRefreshed = await refreshMembers().catch(() => 0);
  if (membersRefreshed) notes.push(`members=${membersRefreshed}`);

  // discovery at most every 6 hours unless forced
  const { data: lastDisc } = await sb.from("refresh_log").select("refreshed_at").eq("source", "sync-congress").like("note", "%discovered%").order("refreshed_at", { ascending: false }).limit(1);
  const lastAt = (lastDisc as { refreshed_at: string }[] | null)?.[0]?.refreshed_at;
  if (body.discover || !lastAt || Date.now() - Date.parse(lastAt) > 6 * 3600e3) {
    let found: Record<string, unknown>[] = [];
    const errs: string[] = [];
    try {
      found = found.concat(await discoverSenate(days));
    } catch (e) {
      errs.push(`senate: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      found = found.concat(await discoverHouse(days));
    } catch (e) {
      errs.push(`house: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (found.length) {
      for (let i = 0; i < found.length; i += 500) {
        const part = found.slice(i, i + 500);
        await withRetry("congress_filings insert", () => sb.from("congress_filings").upsert(part, { onConflict: "id", ignoreDuplicates: true }));
      }
    }
    notes.push(`discovered=${found.length}${errs.length ? ` (${errs.join("; ")})` : ""}`);
  }

  // process pending filings, newest first
  const { data: pend } = await sb
    .from("congress_filings")
    .select("id,chamber,filer,first_name,last_name,state_district,filed,url,attempts")
    .eq("status", "pending")
    .lt("attempts", 4)
    .order("filed", { ascending: false })
    .limit(limit);
  const pending = (pend ?? []) as Record<string, string>[];
  const members = await loadMembers();
  let jar: ReturnType<typeof cookieJar> | null = null;
  let parsed = 0, tradesN = 0, paper = 0, failed = 0;
  for (const f of pending) {
    if (Date.now() - t0 > 100000) break;
    try {
      let trades: Record<string, unknown>[] | null;
      if (f.chamber === "senate") {
        jar = jar ?? (await senateSession());
        trades = await processSenate(f, members, jar);
      } else {
        trades = await processHouse(f, members);
      }
      if (trades === null) {
        paper++;
        await sb.from("congress_filings").update({ status: "paper", updated_at: new Date().toISOString() }).eq("id", f.id);
        continue;
      }
      // a re-parsed filing replaces its earlier rows
      await withRetry("congress_trades clear", () => sb.from("congress_trades").delete().eq("filing_id", f.id));
      if (trades.length) await withRetry("congress_trades upsert", () => sb.from("congress_trades").upsert(trades as Record<string, unknown>[], { onConflict: "id" }));
      await sb.from("congress_filings").update({ status: "done", trades: trades.length, error: null, updated_at: new Date().toISOString() }).eq("id", f.id);
      parsed++;
      tradesN += trades.length;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      await sb.from("congress_filings").update({ attempts: Number(f.attempts ?? 0) + 1, error: msg.slice(0, 300), status: Number(f.attempts ?? 0) + 1 >= 4 ? "error" : "pending", updated_at: new Date().toISOString() }).eq("id", f.id);
    }
  }
  const { count } = await sb.from("congress_filings").select("id", { count: "exact", head: true }).eq("status", "pending");
  notes.push(`parsed=${parsed} trades=${tradesN} paper=${paper} failed=${failed} pending=${count ?? "?"} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const note = notes.join(" ");
  await logRun("sync-congress", failed === 0 || parsed > 0, note);
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
      await logRun("sync-congress", false, msg);
      return { ok: false, error: msg };
    }
  }, Boolean(body.wait));
});
