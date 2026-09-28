-- =====================================================================
-- VIBA Terminal: real-data pipeline
--
-- Every dataset the terminal shows is fetched and computed by Supabase edge
-- functions on pg_cron schedules. Nothing is bundled, simulated or typed in:
--
--   sync-directory   Nasdaq screener (US stocks + ETFs) -> symbol_directory, market caps; SEC CIKs
--   sync-prices      Yahoo Finance daily OHLCV (Nasdaq fallback) -> raw_prices, symbol_stats
--   sync-options     CBOE delayed option chains -> options_daily
--   sync-congress    Senate eFD + House Clerk PTR filings -> congress_trades
--   sync-insiders    SEC EDGAR Form 4 (daily index) -> insider_trades
--   sync-13f         SEC EDGAR 13F-HR for tracked funds -> fund_holdings, smart_money_reports('funds')
--   compute-*        regime score, sector rotation, trade setups, backtest, smart money, stock plays
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------- pipeline config (service role only) ----------
create table if not exists public.pipeline_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.pipeline_config enable row level security;
insert into public.pipeline_config (key, value) values
  ('sec_user_agent', 'VIBA Terminal research dashboard')
on conflict (key) do nothing;

-- ---------- shared secret in Vault + invoker used by pg_cron ----------
-- A random value generated in the database; it never appears in source code
-- (see 20260927_edge_secret.sql for how the functions read it and rotate it).
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'refresh_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'refresh_secret',
      'x-refresh-secret header for VIBA edge functions');
  end if;
end $$;

create or replace function private.invoke_edge(fn text, body jsonb default '{}'::jsonb, timeout_ms integer default 150000)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  secret text;
  rid bigint;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'refresh_secret' limit 1;
  select net.http_post(
    url := 'https://pcvuajgqlfaxdaoijpqi.supabase.co/functions/v1/' || fn,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-refresh-secret', secret),
    body := body,
    timeout_milliseconds := timeout_ms
  ) into rid;
  return rid;
end $$;
revoke all on function private.invoke_edge(text, jsonb, integer) from public, anon, authenticated;

-- ---------- symbol_meta: sync bookkeeping ----------
alter table public.symbol_meta drop constraint if exists symbol_meta_kind_check;
alter table public.symbol_meta add constraint symbol_meta_kind_check
  check (kind = any (array['index', 'input', 'sector_etf', 'stock', 'flow_asset', 'adhoc']));
alter table public.symbol_meta
  add column if not exists cik bigint,
  add column if not exists industry text,
  add column if not exists market_cap numeric,
  add column if not exists prices_synced_at timestamptz,
  add column if not exists price_source text,
  add column if not exists first_bar date,
  add column if not exists last_bar date,
  add column if not exists bar_count integer,
  add column if not exists last_event_ts bigint,
  add column if not exists sync_error text,
  add column if not exists sync_fail_count integer not null default 0,
  add column if not exists options_synced_at timestamptz,
  add column if not exists optionable boolean;
create index if not exists symbol_meta_price_queue_idx on public.symbol_meta (prices_synced_at nulls first) where active;
create index if not exists symbol_meta_options_queue_idx on public.symbol_meta (options_synced_at nulls first) where active;
create index if not exists symbol_meta_cik_idx on public.symbol_meta (cik);

-- ETFs the Smart Money tab reads for flows and risk-appetite pairs
insert into public.symbol_meta (symbol, name, kind, sector_etf, active) values
  ('SMH', 'VanEck Semiconductor ETF', 'flow_asset', null, true),
  ('KRE', 'SPDR S&P Regional Banking ETF', 'flow_asset', null, true),
  ('XBI', 'SPDR S&P Biotech ETF', 'flow_asset', null, true),
  ('ITB', 'iShares U.S. Home Construction ETF', 'flow_asset', null, true),
  ('GLD', 'SPDR Gold Shares', 'flow_asset', null, true),
  ('SLV', 'iShares Silver Trust', 'flow_asset', null, true),
  ('TLT', 'iShares 20+ Year Treasury Bond ETF', 'flow_asset', null, true),
  ('LQD', 'iShares iBoxx $ Investment Grade Corporate Bond ETF', 'flow_asset', null, true),
  ('UUP', 'Invesco DB US Dollar Index Bullish Fund', 'flow_asset', null, true),
  ('USO', 'United States Oil Fund', 'flow_asset', null, true),
  ('IBIT', 'iShares Bitcoin Trust ETF', 'flow_asset', null, true)
on conflict (symbol) do update set active = true, updated_at = now();

-- ---------- raw_prices: provenance + dividend-adjusted close ----------
alter table public.raw_prices
  add column if not exists adj_close numeric,
  add column if not exists source text;
drop index if exists public.raw_prices_symbol_date_idx; -- duplicate of the primary key

-- bulk price writes must not fan out over Realtime; the UI listens to refresh_log instead
do $$
declare t text;
begin
  foreach t in array array['raw_prices', 'symbol_meta', 'regime_history', 'rotation_strength'] loop
    if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- per-symbol stats: quotes, screens, plays ----------
create table if not exists public.symbol_stats (
  symbol text primary key,
  d date not null,
  close numeric not null,
  prev_close numeric,
  chg numeric,
  chg_pct numeric,
  r1m numeric,
  r3m numeric,
  r6m numeric,
  r12m numeric,
  vol63 numeric,
  vol126 numeric,
  dma50 numeric,
  dma100 numeric,
  dma200 numeric,
  hi52 numeric,
  lo52 numeric,
  dollar_vol20 numeric,
  avg_vol20 numeric,
  bars integer not null,
  updated_at timestamptz not null default now()
);
alter table public.symbol_stats enable row level security;
drop policy if exists "public read" on public.symbol_stats;
create policy "public read" on public.symbol_stats for select using (true);

create or replace function public.refresh_symbol_stats(p_symbols text[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  with src as (
    select r.symbol, r.date, r.close, r.high, r.low, r.volume,
           row_number() over (partition by r.symbol order by r.date desc) as rn,
           r.close / nullif(lag(r.close) over (partition by r.symbol order by r.date), 0) - 1 as ret
    from public.raw_prices r
    where r.date > current_date - 430
      and (p_symbols is null or r.symbol = any (p_symbols))
  ), agg as (
    select symbol,
      max(date) filter (where rn = 1) as d,
      max(close) filter (where rn = 1) as close,
      max(close) filter (where rn = 2) as prev_close,
      max(close) filter (where rn = 22) as c21,
      max(close) filter (where rn = 64) as c63,
      max(close) filter (where rn = 127) as c126,
      max(close) filter (where rn = 253) as c252,
      avg(close) filter (where rn <= 50) as dma50,
      avg(close) filter (where rn <= 100) as dma100,
      avg(close) filter (where rn <= 200) as dma200,
      count(*) filter (where rn <= 200) as n200,
      max(coalesce(high, close)) filter (where rn <= 252) as hi52,
      min(coalesce(low, close)) filter (where rn <= 252) as lo52,
      avg(close * volume) filter (where rn <= 20) as dollar_vol20,
      avg(volume) filter (where rn <= 20) as avg_vol20,
      stddev_pop(ret) filter (where rn <= 63) * sqrt(252) as vol63,
      stddev_pop(ret) filter (where rn <= 126) * sqrt(252) as vol126,
      count(*) as bars
    from src
    group by symbol
  )
  insert into public.symbol_stats as s (
    symbol, d, close, prev_close, chg, chg_pct, r1m, r3m, r6m, r12m, vol63, vol126,
    dma50, dma100, dma200, hi52, lo52, dollar_vol20, avg_vol20, bars, updated_at)
  select symbol, d, close, prev_close,
    close - prev_close,
    (close / nullif(prev_close, 0) - 1) * 100,
    (close / nullif(c21, 0) - 1) * 100,
    (close / nullif(c63, 0) - 1) * 100,
    (close / nullif(c126, 0) - 1) * 100,
    (close / nullif(c252, 0) - 1) * 100,
    case when bars >= 64 then vol63 end,
    case when bars >= 127 then vol126 end,
    case when bars >= 50 then dma50 end,
    case when bars >= 100 then dma100 end,
    case when n200 >= 200 then dma200 end,
    hi52, lo52, dollar_vol20, avg_vol20, bars::integer, now()
  from agg
  where d is not null
  on conflict (symbol) do update set
    d = excluded.d, close = excluded.close, prev_close = excluded.prev_close, chg = excluded.chg,
    chg_pct = excluded.chg_pct, r1m = excluded.r1m, r3m = excluded.r3m, r6m = excluded.r6m,
    r12m = excluded.r12m, vol63 = excluded.vol63, vol126 = excluded.vol126, dma50 = excluded.dma50,
    dma100 = excluded.dma100, dma200 = excluded.dma200, hi52 = excluded.hi52, lo52 = excluded.lo52,
    dollar_vol20 = excluded.dollar_vol20, avg_vol20 = excluded.avg_vol20, bars = excluded.bars,
    updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- the quote cards / ticker read this; now backed by symbol_stats instead of a
-- window over the whole price table
drop view if exists public.latest_prices;
create view public.latest_prices with (security_invoker = true) as
  select symbol, d as date, close, updated_at, prev_close, chg, chg_pct, hi52 as hi_52w, lo52 as lo_52w
  from public.symbol_stats;

create or replace function public.after_price_sync(p_symbols text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.symbol_meta m set
    first_bar = s.first_bar, last_bar = s.last_bar, bar_count = s.n, updated_at = now()
  from (
    select symbol, min(date) as first_bar, max(date) as last_bar, count(*)::integer as n
    from public.raw_prices where symbol = any (p_symbols) group by symbol
  ) s
  where m.symbol = s.symbol;
  n := public.refresh_symbol_stats(p_symbols);
  return n;
end $$;

-- ---------- options (CBOE delayed chains, aggregated per symbol per session) ----------
create table if not exists public.options_daily (
  symbol text not null,
  d date not null,
  call_volume bigint not null default 0,
  put_volume bigint not null default 0,
  call_premium numeric not null default 0,
  put_premium numeric not null default 0,
  call_oi bigint not null default 0,
  put_oi bigint not null default 0,
  contracts integer not null default 0,
  underlying numeric,
  iv30 numeric,
  source text not null default 'cboe',
  fetched_at timestamptz not null default now(),
  primary key (symbol, d)
);
create index if not exists options_daily_d_idx on public.options_daily (d);
alter table public.options_daily enable row level security;
drop policy if exists "public read" on public.options_daily;
create policy "public read" on public.options_daily for select using (true);

create or replace view public.options_latest with (security_invoker = true) as
select symbol, d, call_volume, put_volume, call_premium, put_premium, call_oi, put_oi, contracts,
       underlying, iv30, fetched_at, call_vol_avg10, put_vol_avg10, call_oi_avg10, put_oi_avg10, hist_days
from (
  select o.*,
         avg(o.call_volume) over w as call_vol_avg10,
         avg(o.put_volume) over w as put_vol_avg10,
         avg(o.call_oi) over w as call_oi_avg10,
         avg(o.put_oi) over w as put_oi_avg10,
         count(*) over w as hist_days,
         row_number() over (partition by o.symbol order by o.d desc) as rn
  from public.options_daily o
  window w as (partition by o.symbol order by o.d rows between 10 preceding and 1 preceding)
) x
where rn = 1;

-- ---------- congress (STOCK Act periodic transaction reports) ----------
create table if not exists public.congress_members (
  bioguide text primary key,
  chamber text not null,
  first_name text,
  last_name text,
  full_name text,
  state text,
  district integer,
  party text,
  updated_at timestamptz not null default now()
);
create table if not exists public.congress_filings (
  id text primary key,
  chamber text not null,
  filer text not null,
  first_name text,
  last_name text,
  state_district text,
  filed date,
  url text not null,
  status text not null default 'pending',
  trades integer,
  attempts integer not null default 0,
  error text,
  updated_at timestamptz not null default now()
);
create index if not exists congress_filings_pending_idx on public.congress_filings (filed desc) where status = 'pending';
create table if not exists public.congress_trades (
  id text primary key,
  filing_id text not null references public.congress_filings (id) on delete cascade,
  symbol text not null,
  asset text,
  asset_type text,
  politician text not null,
  chamber text not null,
  party text,
  owner text,
  side text not null check (side in ('BUY', 'SELL')),
  amount text,
  amount_low numeric,
  amount_high numeric,
  traded date,
  disclosed date,
  source_url text,
  fetched_at timestamptz not null default now()
);
create index if not exists congress_trades_symbol_idx on public.congress_trades (symbol);
create index if not exists congress_trades_disclosed_idx on public.congress_trades (disclosed desc);
alter table public.congress_members enable row level security;
alter table public.congress_filings enable row level security;
alter table public.congress_trades enable row level security;
drop policy if exists "public read" on public.congress_trades;
create policy "public read" on public.congress_trades for select using (true);
drop policy if exists "public read" on public.congress_members;
create policy "public read" on public.congress_members for select using (true);

-- ---------- insiders (SEC Form 4, open-market buys and sells) ----------
create table if not exists public.sec_index_log (
  d date primary key,
  status text not null,
  form4 integer,
  queued integer,
  processed_at timestamptz not null default now()
);
create table if not exists public.sec_form4_queue (
  accession text primary key,
  cik bigint not null,
  path text not null,
  filed date not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  error text,
  updated_at timestamptz not null default now()
);
create index if not exists sec_form4_queue_pending_idx on public.sec_form4_queue (filed desc) where status = 'pending';
create table if not exists public.insider_trades (
  accession text not null,
  seq integer not null,
  symbol text not null,
  issuer_cik bigint,
  insider text,
  role text,
  code text not null,
  traded date,
  filed date,
  shares numeric,
  price numeric,
  value numeric,
  url text,
  primary key (accession, seq)
);
create index if not exists insider_trades_symbol_idx on public.insider_trades (symbol, traded desc);
alter table public.sec_index_log enable row level security;
alter table public.sec_form4_queue enable row level security;
alter table public.insider_trades enable row level security;
drop policy if exists "public read" on public.insider_trades;
create policy "public read" on public.insider_trades for select using (true);

-- ---------- 13F (tracked funds) ----------
create table if not exists public.fund_filings (
  fund_cik bigint not null,
  accession text not null,
  fund text,
  manager text,
  period date,
  filed date,
  positions integer,
  total_value numeric,
  primary key (fund_cik, accession)
);
create table if not exists public.fund_holdings (
  fund_cik bigint not null,
  accession text not null,
  cusip text not null,
  issuer text,
  ticker text,
  value numeric,
  shares numeric,
  primary key (fund_cik, accession, cusip)
);
alter table public.fund_filings enable row level security;
alter table public.fund_holdings enable row level security;
drop policy if exists "public read" on public.fund_filings;
create policy "public read" on public.fund_filings for select using (true);
drop policy if exists "public read" on public.fund_holdings;
create policy "public read" on public.fund_holdings for select using (true);

-- ---------- computed reports (smart money, fund positioning) ----------
create table if not exists public.smart_money_reports (
  kind text primary key,
  as_of date,
  generated_at timestamptz not null default now(),
  payload jsonb not null
);
alter table public.smart_money_reports enable row level security;
drop policy if exists "public read" on public.smart_money_reports;
create policy "public read" on public.smart_money_reports for select using (true);

-- ---------- computed stock plays ----------
create table if not exists public.stock_plays (
  symbol text primary key,
  list text not null check (list in ('play', 'watch')),
  rank integer not null,
  name text not null,
  sector text,
  sector_etf text,
  sector_rank integer,
  score numeric,
  vol numeric,
  r3m numeric,
  r6m numeric,
  r12m numeric,
  market_cap numeric,
  thesis text not null,
  chart_read text not null,
  risk text not null,
  note text,
  as_of date not null,
  generated_at timestamptz not null default now()
);
alter table public.stock_plays enable row level security;
drop policy if exists "public read" on public.stock_plays;
create policy "public read" on public.stock_plays for select using (true);

-- ---------- US symbol directory (search) ----------
create table if not exists public.symbol_directory (
  symbol text primary key,
  name text not null,
  type text not null,
  sector text,
  industry text,
  country text,
  market_cap numeric,
  updated_at timestamptz not null default now()
);
alter table public.symbol_directory enable row level security;
drop policy if exists "public read" on public.symbol_directory;
create policy "public read" on public.symbol_directory for select using (true);

create or replace function public.search_symbols(q text, lim integer default 10)
returns table (symbol text, name text, type text, in_library boolean)
language sql
stable
security invoker
set search_path = public
as $$
  with needle as (
    select upper(trim(q)) as u, lower(trim(q)) as l
  ), cand as (
    select m.symbol, coalesce(nullif(m.name, ''), m.symbol) as name,
           case when m.kind in ('stock', 'adhoc') then 'Stock' else 'ETF' end as type,
           true as in_library, m.market_cap as mcap
    from public.symbol_meta m, needle n
    where n.u <> '' and (m.symbol like n.u || '%' or lower(m.name) like '%' || n.l || '%')
    union all
    select d.symbol, d.name, d.type, false, d.market_cap
    from public.symbol_directory d, needle n
    where n.u <> '' and (d.symbol like n.u || '%' or lower(d.name) like '%' || n.l || '%')
  ), dedup as (
    select distinct on (c.symbol) c.symbol, c.name, c.type, c.in_library, c.mcap,
      case when c.symbol = n.u then 0
           when c.symbol like n.u || '%' then 1
           when lower(c.name) like n.l || '%' then 2
           else 3 end as score
    from cand c, needle n
    order by c.symbol, c.in_library desc
  )
  select symbol, name, type, in_library
  from dedup
  order by score, in_library desc, mcap desc nulls last, length(symbol), symbol
  limit greatest(1, least(coalesce(lim, 10), 25));
$$;

-- symbols the intraday price sync keeps fresh: market ETFs + everything the UI is showing
create or replace function public.core_symbols()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select symbol from public.symbol_meta where active and kind in ('index', 'input', 'sector_etf', 'flow_asset')
  union select symbol from public.stock_plays
  union select symbol from public.trade_setups
  union select jsonb_array_elements(payload -> 'plays') ->> 'symbol' from public.smart_money_reports where kind = 'smart_money'
$$;

-- ---------- pipeline status: latest run per job ----------
create index if not exists refresh_log_source_time_idx on public.refresh_log (source, refreshed_at desc);
create or replace view public.pipeline_status with (security_invoker = true) as
select distinct on (r.source) r.source, r.refreshed_at, r.ok, r.note,
  (select count(*) from public.refresh_log x where x.source = r.source and x.refreshed_at > now() - interval '24 hours')::integer as runs_24h,
  (select count(*) from public.refresh_log x where x.source = r.source and not x.ok and x.refreshed_at > now() - interval '24 hours')::integer as failures_24h
from public.refresh_log r
order by r.source, r.refreshed_at desc;

-- ---------- function privileges ----------
revoke execute on function public.refresh_symbol_stats(text[]) from public, anon, authenticated;
revoke execute on function public.after_price_sync(text[]) from public, anon, authenticated;
revoke execute on function public.core_symbols() from public, anon, authenticated;
grant execute on function public.refresh_symbol_stats(text[]) to service_role;
grant execute on function public.after_price_sync(text[]) to service_role;
grant execute on function public.core_symbols() to service_role;
grant execute on function public.search_symbols(text, integer) to anon, authenticated, service_role;
