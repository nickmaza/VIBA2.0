// ingest-prices
//
// Receives daily OHLCV bars (pushed by the scheduled Robinhood-fetch task,
// since Edge Functions can't reach the Robinhood MCP connector themselves)
// and upserts them into raw_prices. This is the "data fetching / saving"
// entry point for the pipeline: it does not compute anything, it just stores
// clean, validated bars for the compute-* functions to read.
//
// close is required. open/high/low/volume are optional so the long
// close-only history stays ingestible, but senders should include high and
// low whenever they have them -- compute-trade-setups needs a real high/low
// to compute true range, and silently falls back to a cruder close-to-close
// proxy when they're missing.
//
// Auth: custom shared-secret header (x-refresh-secret), not Supabase JWT --
// this endpoint performs writes and is called by an automated job, not a
// browser, so verify_jwt is disabled and this check replaces it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REFRESH_SECRET = "Jl1kt0BO-VQC4xywXdrHuAV9pxgRiTxBjbZDMpDvZXI";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type PriceRow = {
  symbol: string;
  date: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
};

/** Optional numeric field: absent/null is fine, present-but-garbage is not. */
function optNum(v: unknown, opts: { positive?: boolean } = {}): number | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return undefined; // signals "invalid"
  if (opts.positive && n < 0) return undefined;
  return n;
}

function parseRow(p: unknown): PriceRow | null {
  if (typeof p !== "object" || p === null) return null;
  const row = p as Record<string, unknown>;
  if (typeof row.symbol !== "string" || row.symbol.length === 0) return null;
  if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;

  const close = typeof row.close === "number" ? row.close : Number(row.close);
  if (!Number.isFinite(close) || close <= 0) return null;

  const open = optNum(row.open, { positive: true });
  const high = optNum(row.high, { positive: true });
  const low = optNum(row.low, { positive: true });
  const volume = optNum(row.volume, { positive: true });
  if (open === undefined || high === undefined || low === undefined || volume === undefined) return null;

  // A high below its own low is corrupt data, not a rounding artifact -- drop
  // the bar rather than let it poison an ATR.
  if (high !== null && low !== null && high < low) return null;

  const out: PriceRow = { symbol: row.symbol.toUpperCase().trim(), date: row.date, close };
  if (open !== null) out.open = open;
  if (high !== null) out.high = high;
  if (low !== null) out.low = low;
  if (volume !== null) out.volume = Math.round(volume);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  if (req.headers.get("x-refresh-secret") !== REFRESH_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let body: { prices?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json body" }), { status: 400 });
  }

  const prices = body.prices;
  if (!Array.isArray(prices) || prices.length === 0) {
    return new Response(JSON.stringify({ error: "body.prices must be a non-empty array" }), {
      status: 400,
    });
  }

  let rejected = 0;
  const good: PriceRow[] = [];
  for (const p of prices) {
    const row = parseRow(p);
    if (row) good.push(row);
    else rejected++;
  }

  if (good.length === 0) {
    return new Response(JSON.stringify({ error: "no valid rows", rejected }), { status: 400 });
  }

  const withHL = good.filter((r) => r.high !== undefined && r.low !== undefined).length;

  // upsert in chunks to stay well under any single-request payload/row limits
  const CHUNK = 2000;
  let upserted = 0;
  for (let i = 0; i < good.length; i += CHUNK) {
    const chunk = good.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("raw_prices")
      .upsert(chunk, { onConflict: "symbol,date" });
    if (error) {
      return new Response(
        JSON.stringify({ ok: false, upserted, error: error.message }),
        { status: 500 },
      );
    }
    upserted += chunk.length;
  }

  const symbols = new Set(good.map((r) => r.symbol)).size;
  return new Response(
    JSON.stringify({ ok: true, upserted, symbols, with_high_low: withHL, rejected }),
    { headers: { "Content-Type": "application/json" } },
  );
});
