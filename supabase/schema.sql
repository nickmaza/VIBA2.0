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
  -- OHLCV is nullable: the long close-only history predates these columns and
  -- stays valid (momentum only reads closes). compute-trade-setups needs high
  -- and low for true range and quietly falls back to a close-to-close proxy
  -- where they're missing, so senders should include them when they have them.
  open numeric,
  high numeric,
  low numeric,
  volume bigint,
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

-- What each tracked symbol is, and for individual stocks which SPDR sector
-- they sit in. This is what lets the rotation name actual tickers inside the
-- leading sectors rather than only the sector ETFs themselves. It is also the
-- list the scheduled ingest task reads, so adding a symbol here (plus its
-- history) is all it takes to bring a new name into the universe.
create table if not exists symbol_meta (
  symbol text primary key,
  name text not null,
  kind text not null check (kind in ('index','input','sector_etf','stock')),
  sector_etf text,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create index if not exists symbol_meta_sector_idx on symbol_meta (sector_etf) where kind = 'stock';

-- Daily "is this rotation worth trading" series, written by
-- compute-trade-setups. dispersion = cross-sectional stdev of the 11 sector
-- scores; spread = mean(top 3) - mean(bottom 3); persistence = Spearman rank
-- correlation against 21 sessions ago. strength blends the three into 0-100.
-- High dispersion with low persistence is 'churn' -- sectors are spread out
-- but leadership keeps reshuffling, which is the worst case to trade into.
create table if not exists rotation_strength (
  d date primary key,
  dispersion numeric not null,
  spread numeric not null,
  persistence numeric not null,
  strength numeric not null,
  state text not null,
  leaders text,
  laggards text
);

-- The current candidate long list with mechanically derived levels. Fully
-- replaced on every run. Stop = 2 ATR back, dropped under the 20-day low when
-- structure sits lower, then capped at 3 ATR; targets are fixed multiples of
-- that risk (2R / 3R), which makes rr1/rr2 constant and makes t1_atr/t2_atr
-- (daily ATRs to the target) the number that actually carries information.
create table if not exists trade_setups (
  symbol text primary key,
  name text not null,
  kind text not null,
  sector_etf text,
  sector_name text,
  sector_rank int,
  score numeric not null,
  strength numeric not null,
  close numeric not null,
  atr numeric not null,
  atr_pct numeric not null,
  entry numeric not null,
  buy_zone_low numeric not null,
  stop numeric not null,
  t1 numeric not null,
  t2 numeric not null,
  risk_per_share numeric not null,
  risk_pct numeric,
  rr1 numeric not null,
  rr2 numeric not null,
  t1_atr numeric,
  t2_atr numeric,
  ext_pct numeric,
  trend_ok boolean not null,
  atr_true boolean not null,
  r3 numeric, r6 numeric, r12 numeric,
  as_of date not null,
  note text,
  updated_at timestamptz not null default now()
);

-- Row Level Security: public can read, nobody can write via the anon key.
-- scripts/refresh.py uses the service role key, which bypasses RLS entirely.
alter table regime_snapshot enable row level security;
alter table regime_history enable row level security;
alter table sector_rankings enable row level security;
alter table backtest_curves enable row level security;
alter table backtest_stats enable row level security;
alter table refresh_log enable row level security;
alter table symbol_meta enable row level security;
alter table rotation_strength enable row level security;
alter table trade_setups enable row level security;

create policy "public read" on regime_snapshot for select using (true);
create policy "public read" on regime_history for select using (true);
create policy "public read" on sector_rankings for select using (true);
create policy "public read" on backtest_curves for select using (true);
create policy "public read" on backtest_stats for select using (true);
create policy "public read" on refresh_log for select using (true);
create policy "public read" on symbol_meta for select using (true);
create policy "public read" on rotation_strength for select using (true);
create policy "public read" on trade_setups for select using (true);

-- One row per tracked symbol (latest close on file), plus what a quote window
-- needs: previous close, day change (abs + %), and the trailing-52-week
-- (252-session) high/low. Lets the UI show "everything we're tracking"
-- cheaply, without ever downloading full multi-year price histories to the
-- browser. Views don't automatically inherit RLS grants from their base
-- tables, so anon/authenticated need an explicit GRANT even though
-- raw_prices itself is already public-read.
create or replace view latest_prices
with (security_invoker = true) as
select
  symbol,
  date,
  close,
  updated_at,
  prev_close,
  case when prev_close is null then null else close - prev_close end as chg,
  case when prev_close is null or prev_close = 0 then null else (close / prev_close - 1.0) * 100.0 end as chg_pct,
  hi_52w,
  lo_52w
from (
  select
    symbol,
    date,
    close,
    updated_at,
    lag(close) over (partition by symbol order by date) as prev_close,
    max(close) over (partition by symbol order by date rows between 251 preceding and current row) as hi_52w,
    min(close) over (partition by symbol order by date rows between 251 preceding and current row) as lo_52w,
    row_number() over (partition by symbol order by date desc) as rn
  from raw_prices
) t
where rn = 1;

grant select on latest_prices to anon, authenticated;

-- Enable Realtime so the terminal updates live without polling. raw_prices +
-- refresh_log feed the "Tracked Instruments" / "Pipeline Status" panels, so
-- those are live too, not just the score/ranking tables.
alter publication supabase_realtime add table regime_snapshot;
alter publication supabase_realtime add table sector_rankings;
alter publication supabase_realtime add table regime_history;
alter publication supabase_realtime add table raw_prices;
alter publication supabase_realtime add table refresh_log;
alter publication supabase_realtime add table rotation_strength;
alter publication supabase_realtime add table trade_setups;
alter publication supabase_realtime add table symbol_meta;

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

select cron.schedule(
  'compute-trade-setups-refresh',
  '14 14-20 * * 1-5', -- runs after the sector ranking it depends on
  $$
  select net.http_post(
    url := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/compute-trade-setups',
    headers := '{"Content-Type":"application/json","x-refresh-secret":"<YOUR_REFRESH_SECRET>"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- To check a pg_cron-triggered run's HTTP result later:
--   select id, status_code, content::text, created
--   from net._http_response order by created desc limit 5;
-- To list/unschedule jobs: select * from cron.job; select cron.unschedule('compute-regime-score-refresh');

-- Smart Money feed: data only a Robinhood-connected job can fetch (options
-- premium/volume/open interest for the most active large caps, and STOCK Act
-- congressional trades). One row per kind ('options', 'congress'), fully
-- replaced each run by the scheduled Claude task; payload is the JSON array
-- the app expects (see lib/smartmoney/index.ts: OptionsRow[] / CongressSummary[]).
-- When this table is empty the app falls back to lib/smartmoney/snapshot.json.
create table if not exists smart_money_feed (
  kind text primary key check (kind in ('options','congress')),
  as_of date not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table smart_money_feed enable row level security;
create policy "public read" on smart_money_feed for select using (true);
