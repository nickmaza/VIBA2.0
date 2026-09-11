-- Regime & Sector Rotation Terminal -- Supabase schema
-- Run once against a new project (SQL editor, or `supabase db execute`).
-- Every table is public-read (anon key). Writes come from the three Edge
-- Functions in supabase/functions/ (service role key, bypasses RLS) -- the
-- browser client never writes. See the README for the full pipeline.

-- Raw daily close prices -- the only table written from *outside* Supabase
-- (by the scheduled ingest task, via the ingest-prices Edge Function). Every
-- other table below is derived from this one by compute-regime-score and
-- compute-sector-rotation, which run natively inside Supabase via pg_cron.
create table if not exists raw_prices (
  symbol text not null,
  date date not null,
  close numeric not null,
  updated_at timestamptz not null default now(),
  primary key (symbol, date)
);
alter table raw_prices enable row level security;
create policy "public read" on raw_prices for select using (true);
create index if not exists raw_prices_symbol_date_idx on raw_prices (symbol, date);

create table if not exists regime_snapshot (
  index_symbol text primary key check (index_symbol in ('SPY','QQQ','IWM')),
  score numeric not null,
  bucket text not null,
  as_of date not null,
  updated_at timestamptz not null default now(),
  -- The five weighted inputs that blend into `score` (each its own rolling
  -- 252-day z-score) -- exposed so the UI can show exactly what's being
  -- tracked, not just the final composite. Nullable so older rows written
  -- before this column existed don't break the upsert.
  z_trend numeric,
  z_breadth numeric,
  z_vol numeric,
  z_credit numeric,
  z_curve numeric
);

create table if not exists regime_history (
  d date primary key,
  spy numeric not null,
  qqq numeric not null,
  iwm numeric not null
);

create table if not exists sector_rankings (
  ticker text primary key,
  rank int not null,
  name text not null,
  score numeric not null,
  r3 numeric not null,
  r6 numeric not null,
  r12 numeric not null,
  as_of date not null
);

create table if not exists backtest_curves (
  strategy text not null check (strategy in ('baseline','top3','dual','bottom3')),
  month text not null, -- 'YYYY-MM'
  growth numeric not null,
  primary key (strategy, month)
);

create table if not exists backtest_stats (
  strategy text primary key check (strategy in ('baseline','top3','dual','bottom3')),
  label text not null,
  cagr numeric not null,
  ann_vol numeric not null,
  sharpe numeric not null,
  max_dd numeric not null,
  total_return numeric not null
);

create table if not exists refresh_log (
  id bigint generated always as identity primary key,
  refreshed_at timestamptz not null default now(),
  source text not null default 'scheduled_trigger_ingest',
  ok boolean not null default true,
  note text
);

-- Row Level Security: public can read, nobody can write via the anon key.
-- scripts/refresh.py uses the service role key, which bypasses RLS entirely.
alter table regime_snapshot enable row level security;
alter table regime_history enable row level security;
alter table sector_rankings enable row level security;
alter table backtest_curves enable row level security;
alter table backtest_stats enable row level security;
alter table refresh_log enable row level security;

create policy "public read" on regime_snapshot for select using (true);
create policy "public read" on regime_history for select using (true);
create policy "public read" on sector_rankings for select using (true);
create policy "public read" on backtest_curves for select using (true);
create policy "public read" on backtest_stats for select using (true);
create policy "public read" on refresh_log for select using (true);

-- One row per tracked symbol (latest close on file) -- lets the UI show
-- "everything we're tracking" cheaply, without ever downloading full
-- multi-year price histories to the browser. Views don't automatically
-- inherit RLS grants from their base tables, so anon/authenticated need an
-- explicit GRANT even though raw_prices itself is already public-read.
create or replace view latest_prices
with (security_invoker = true) as
select distinct on (symbol) symbol, date, close, updated_at
from raw_prices
order by symbol, date desc;

grant select on latest_prices to anon, authenticated;

-- Enable Realtime so the terminal updates live without polling. raw_prices +
-- refresh_log feed the "Tracked Instruments" / "Pipeline Status" panels, so
-- those are live too, not just the score/ranking tables.
alter publication supabase_realtime add table regime_snapshot;
alter publication supabase_realtime add table sector_rankings;
alter publication supabase_realtime add table regime_history;
alter publication supabase_realtime add table raw_prices;
alter publication supabase_realtime add table refresh_log;

-- ---------------------------------------------------------------------------
-- pg_cron + pg_net: run the two compute Edge Functions natively inside
-- Supabase, on a schedule, with zero dependency on any external process
-- (including a Claude chat session). This is what makes the deployed site
-- keep refreshing itself even if nothing else is running.
--
-- Requires the pg_cron and pg_net extensions enabled on the project
-- (Database -> Extensions in the dashboard, or below via SQL if you have
-- the privileges). Replace <YOUR_REFRESH_SECRET> with the same shared
-- secret baked into the Edge Functions' REFRESH_SECRET constant.
-- ---------------------------------------------------------------------------
create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.schedule(
  'compute-regime-score-refresh',
  '10 14-20 * * 1-5', -- 10 min past each hour, 10am-4pm ET weekdays (~market hours)
  $$
  select net.http_post(
    url := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/compute-regime-score',
    headers := '{"Content-Type":"application/json","x-refresh-secret":"<YOUR_REFRESH_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

select cron.schedule(
  'compute-sector-rotation-refresh',
  '12 14-20 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/compute-sector-rotation',
    headers := '{"Content-Type":"application/json","x-refresh-secret":"<YOUR_REFRESH_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- To check a pg_cron-triggered run's HTTP result later:
--   select id, status_code, content::text, created
--   from net._http_response order by created desc limit 5;
-- To list/unschedule jobs: select * from cron.job; select cron.unschedule('compute-regime-score-refresh');
