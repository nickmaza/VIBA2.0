-- pg_cron schedule for the VIBA Terminal data pipeline.
--
-- Every job calls an edge function through private.invoke_edge (which sends
-- the Vault-held refresh secret). pg_cron runs in UTC, so market-hours gating
-- is done in New York time inside each command; that keeps the schedule right
-- through daylight-saving changes. Exchange holidays are not modeled: on a
-- holiday the jobs simply re-read the previous session.

-- ---------------------------------------------------------------- clock helpers
create or replace function private.ny_now()
returns timestamp
language sql
stable
as $$ select now() at time zone 'America/New_York' $$;

create or replace function private.ny_weekday()
returns boolean
language sql
stable
as $$ select extract(isodow from private.ny_now()) between 1 and 5 $$;

-- 09:30-16:00 New York time on weekdays
create or replace function private.market_open()
returns boolean
language sql
stable
as $$
  select private.ny_weekday()
     and private.ny_now()::time >= time '09:30'
     and private.ny_now()::time < time '16:00'
$$;

-- The most recent weekday 16:30 New York time at or before now: by then a
-- session's final daily bar and option volumes are published.
create or replace function private.last_close()
returns timestamptz
language sql
stable
as $$
  select (max(g.d) + interval '16 hours 30 minutes') at time zone 'America/New_York'
    from generate_series((private.ny_now()::date - 7)::timestamp, private.ny_now()::date::timestamp, interval '1 day') as g(d)
   where extract(isodow from g.d) between 1 and 5
     and g.d + interval '16 hours 30 minutes' <= private.ny_now()
$$;

-- symbols still waiting for the latest session
create or replace function private.stale_prices()
returns integer
language sql
stable
as $$
  select count(*)::integer from public.symbol_meta
   where active and (prices_synced_at is null or prices_synced_at < private.last_close())
$$;

create or replace function private.stale_options()
returns integer
language sql
stable
as $$
  select count(*)::integer from public.symbol_meta
   where active
     and kind in ('stock', 'sector_etf', 'index', 'input', 'flow_asset')
     and optionable is distinct from false
     and (options_synced_at is null or options_synced_at < private.last_close())
$$;

create or replace function private.minutes_since_close()
returns integer
language sql
stable
as $$ select greatest(1, floor(extract(epoch from now() - private.last_close()) / 60))::integer $$;

-- ---------------------------------------------------------------- old jobs
-- (the original three jobs sent a hard-coded secret; they are replaced below)
do $$
begin
  perform cron.unschedule(jobname) from cron.job
   where jobname in ('compute-regime-score-refresh', 'compute-sector-rotation-refresh', 'compute-trade-setups-refresh');
end $$;

-- ---------------------------------------------------------------- prices
-- market ETFs, regime inputs and every name on screen, every 15 minutes in the
-- session and until 16:50 so the final bar lands
select cron.schedule('prices-core', '*/15 * * * 1-5', $job$
  select private.invoke_edge('sync-prices', '{"group":"core"}'::jsonb, 30000)
   where private.ny_weekday() and private.ny_now()::time between time '09:30' and time '16:50'
$job$);

-- the whole library after each close (150 symbols per run until none is stale)
select cron.schedule('prices-library', '*/3 * * * *', $job$
  select private.invoke_edge('sync-prices',
           jsonb_build_object('limit', 150, 'staleMinutes', private.minutes_since_close()), 30000)
   where not private.market_open() and private.stale_prices() > 0
$job$);

-- ---------------------------------------------------------------- options (CBOE)
-- most active chains, hourly in the session
select cron.schedule('options-top', '40 * * * 1-5', $job$
  select private.invoke_edge('sync-options', '{"group":"top","limit":100}'::jsonb, 30000)
   where private.market_open()
$job$);

-- every optionable library name after each close
select cron.schedule('options-sweep', '*/2 * * * *', $job$
  select private.invoke_edge('sync-options',
           jsonb_build_object('limit', 400, 'staleMinutes', private.minutes_since_close()), 30000)
   where not private.market_open() and private.stale_options() > 0
$job$);

-- ---------------------------------------------------------------- disclosures
select cron.schedule('congress', '7,37 * * * *', $job$
  select private.invoke_edge('sync-congress', '{"limit":40}'::jsonb, 30000)
$job$);

select cron.schedule('insiders-index', '20 */2 * * *', $job$
  select private.invoke_edge('sync-insiders', '{"mode":"index","days":4}'::jsonb, 30000)
$job$);

select cron.schedule('insiders-process', '*/5 * * * *', $job$
  select private.invoke_edge('sync-insiders', '{"mode":"process","limit":800}'::jsonb, 30000)
   where exists (select 1 from public.sec_form4_queue where status = 'pending')
$job$);

select cron.schedule('funds-13f', '25 10 * * *', $job$
  select private.invoke_edge('sync-13f', '{}'::jsonb, 30000)
$job$);

select cron.schedule('directory', '30 9 * * 0', $job$
  select private.invoke_edge('sync-directory', '{}'::jsonb, 30000)
$job$);

-- ---------------------------------------------------------------- computes
select cron.schedule('compute-regime', '5,20,35,50 * * * 1-5', $job$
  select private.invoke_edge('compute-regime-score', '{}'::jsonb, 120000)
   where private.ny_weekday() and private.ny_now()::time between time '09:30' and time '17:00'
$job$);

-- weekly full rebuild (absorbs split/dividend history revisions)
select cron.schedule('compute-regime-full', '40 9 * * 0', $job$
  select private.invoke_edge('compute-regime-score', '{"full":true}'::jsonb, 150000)
$job$);

select cron.schedule('compute-rotation', '6,21,36,51 * * * 1-5', $job$
  select private.invoke_edge('compute-sector-rotation', '{}'::jsonb, 120000)
   where private.ny_weekday() and private.ny_now()::time between time '09:30' and time '17:00'
$job$);

select cron.schedule('compute-setups', '7,22,37,52 * * * 1-5', $job$
  select private.invoke_edge('compute-trade-setups', '{}'::jsonb, 120000)
   where private.ny_weekday() and private.ny_now()::time between time '09:30' and time '17:00'
$job$);

select cron.schedule('compute-plays', '8,38 * * * 1-5', $job$
  select private.invoke_edge('compute-plays', '{}'::jsonb, 120000)
   where private.ny_weekday() and private.ny_now()::time between time '09:30' and time '17:00'
$job$);

select cron.schedule('compute-smart-money', '45 * * * 1-5', $job$
  select private.invoke_edge('compute-smart-money', '{}'::jsonb, 150000)
   where private.ny_weekday() and private.ny_now()::time between time '10:00' and time '17:00'
$job$);

-- once the evening sweeps are (nearly) done, rebuild everything that reads the
-- whole library; runs again only when newer data has arrived
select cron.schedule('compute-after-sweep', '*/10 * * * *', $job$
  select private.invoke_edge('compute-trade-setups', '{}'::jsonb, 120000),
         private.invoke_edge('compute-plays', '{}'::jsonb, 120000),
         private.invoke_edge('compute-smart-money', '{}'::jsonb, 150000)
   where not private.market_open()
     and private.stale_prices() < 25
     and private.stale_options() < 50
     and coalesce((select generated_at from public.smart_money_reports where kind = 'smart_money'), '-infinity'::timestamptz)
         < (select greatest(max(prices_synced_at), max(options_synced_at)) from public.symbol_meta where active)
$job$);

select cron.schedule('compute-backtest', '55 * * * 1-5', $job$
  select private.invoke_edge('compute-backtest', '{}'::jsonb, 120000)
   where private.ny_weekday() and private.ny_now()::time between time '16:50' and time '17:10'
$job$);

-- ---------------------------------------------------------------- housekeeping
select cron.schedule('cleanup-refresh-log', '15 4 * * *', $job$
  delete from public.refresh_log where refreshed_at < now() - interval '30 days'
$job$);
