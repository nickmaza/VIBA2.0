// ingest-prices (retired)
//
// This endpoint used to accept bars pushed in from outside Supabase. Prices
// now come only from sync-prices (Yahoo Finance, Nasdaq fallback), which runs
// inside Supabase on pg_cron, so this function refuses every request.
Deno.serve(() =>
  new Response(
    JSON.stringify({ error: "ingest-prices is retired; prices are synced by the sync-prices function" }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
);
