// ingest-prices
//
// Receives raw daily OHLCV close prices (pushed by the scheduled Robinhood-fetch
// task, since Edge Functions can't reach the Robinhood MCP connector themselves)
// and upserts them into raw_prices. This is the "data fetching / saving" entry
// point for the pipeline: it does not compute anything, it just stores clean,
// validated closes for the compute-* functions to read.
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

type PriceRow = { symbol: string; date: string; close: number };

function isValidRow(p: unknown): p is PriceRow {
  if (typeof p !== "object" || p === null) return false;
  const row = p as Record<string, unknown>;
  return (
    typeof row.symbol === "string" &&
    row.symbol.length > 0 &&
    typeof row.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
    typeof row.close === "number" &&
    Number.isFinite(row.close) &&
    row.close > 0
  );
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

  const bad: unknown[] = [];
  const good: PriceRow[] = [];
  for (const p of prices) {
    if (isValidRow(p)) good.push(p);
    else bad.push(p);
  }

  if (good.length === 0) {
    return new Response(JSON.stringify({ error: "no valid rows", rejected: bad.length }), {
      status: 400,
    });
  }

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

  return new Response(
    JSON.stringify({ ok: true, upserted, rejected: bad.length }),
    { headers: { "Content-Type": "application/json" } },
  );
});
