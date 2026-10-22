-- Live quotes, on-screen watch interest and the news feed.
--
-- Modeled on how Yahoo Finance runs its quote page (traced 2026-10-22):
--   * Prices: Yahoo keeps one streaming connection and subscribes only the
--     symbols visible on screen, pausing when the tab is in the background.
--     Here the browser registers what it is showing (watch_symbols), the
--     sync-quotes edge function refreshes those plus the core set every ~30s
--     from Yahoo's batch spark endpoint (20 symbols per request), and
--     Supabase Realtime pushes each changed row to every open tab.
--   * News: Yahoo serves a per-ticker story stream (headline, publisher,
--     time, related tickers) with a sector/market fallback and "load more"
--     paging deduplicated by story id. sync-news pulls the same stories per
--     symbol into news_items (keyed by Yahoo's uuid), Realtime announces new
--     ones, and the app pages with a published_at cursor.
-- Everything stays read-only for the anon role except watch_symbols(), a
-- validated, rate-capped RPC that only records interest.

-- ---------------------------------------------------------------- live_quotes
create table if not exists public.live_quotes (
  symbol text primary key,             -- library form (BRK.B, not BRK-B)
  name text,
  price numeric not null,              -- regular-session price
  prev_close numeric,
  change numeric,
  change_pct numeric,                  -- percent (1.23 = +1.23%)
  day_high numeric,
  day_low numeric,
  volume bigint,
  market_state text not null default 'CLOSED' check (market_state in ('PRE', 'REGULAR', 'POST', 'CLOSED')),
  ext_price numeric,                   -- latest pre/post-market print, when there is one
  ext_change numeric,
  ext_change_pct numeric,
  ext_time timestamptz,
  quote_time timestamptz,              -- exchange time of the regular price
  source text not null default 'yahoo',
  updated_at timestamptz not null default now()
);
alter table public.live_quotes enable row level security;
drop policy if exists "public read" on public.live_quotes;
create policy "public read" on public.live_quotes for select using (true);
revoke insert, update, delete, truncate, references, trigger on public.live_quotes from anon, authenticated;

-- ---------------------------------------------------------------- watch interest
-- Symbols an open tab is showing right now. Private: the anon role can't read
-- or write it directly, only through watch_symbols().
create table if not exists public.quote_interest (
  symbol text primary key,
  last_seen timestamptz not null default now()
);
alter table public.quote_interest enable row level security;
revoke all on public.quote_interest from anon, authenticated;

create or replace function public.watch_symbols(p_symbols text[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  -- at most 60 per call; only real listed symbols are accepted
  with req as (
    select distinct upper(trim(s)) as symbol
      from unnest(coalesce(p_symbols, '{}'::text[])) as s
     where upper(trim(s)) ~ '^[A-Z][A-Z0-9.\-]{0,9}$'
     limit 60
  ), ok as (
    select r.symbol from req r
     where exists (select 1 from public.symbol_meta m where m.symbol = r.symbol)
        or exists (select 1 from public.symbol_directory d where d.symbol = r.symbol)
  )
  insert into public.quote_interest (symbol, last_seen)
  select symbol, now() from ok
  on conflict (symbol) do update set last_seen = excluded.last_seen
   where public.quote_interest.last_seen < now() - interval '20 seconds';
  get diagnostics n = row_count;
  -- keep the table small
  delete from public.quote_interest where last_seen < now() - interval '1 day';
  return n;
end $$;
revoke all on function public.watch_symbols(text[]) from public;
grant execute on function public.watch_symbols(text[]) to anon, authenticated, service_role;

-- What sync-quotes refreshes: everything the app always shows, plus whatever
-- an open tab registered in the last three minutes. Capped at 300 symbols
-- (15 spark requests).
create or replace function public.quote_symbols()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select symbol from (
    select symbol, 0 as pri from public.core_symbols() as c(symbol)
    union all
    select symbol, 1 from public.quote_interest where last_seen > now() - interval '3 minutes'
  ) s
  group by symbol
  order by min(pri), symbol
  limit 300
$$;
revoke all on function public.quote_symbols() from public, anon, authenticated;
grant execute on function public.quote_symbols() to service_role;

-- ---------------------------------------------------------------- news
create table if not exists public.news_items (
  uuid text primary key,               -- Yahoo story id (dedup key, like Yahoo's own paging)
  title text not null,
  publisher text,
  link text not null,
  kind text not null default 'STORY',  -- STORY | VIDEO | PRESS (press releases by wire publisher)
  published_at timestamptz not null,
  tickers text[] not null default '{}',-- related tickers, library form
  thumb text,                          -- small thumbnail URL
  first_seen timestamptz not null default now()
);
create index if not exists news_items_published_idx on public.news_items (published_at desc);
create index if not exists news_items_tickers_idx on public.news_items using gin (tickers);
alter table public.news_items enable row level security;
drop policy if exists "public read" on public.news_items;
create policy "public read" on public.news_items for select using (true);
revoke insert, update, delete, truncate, references, trigger on public.news_items from anon, authenticated;

-- per-symbol sync bookkeeping (stalest first)
create table if not exists public.news_sync (
  symbol text primary key,
  synced_at timestamptz,
  stories integer,
  error text
);
alter table public.news_sync enable row level security;
revoke all on public.news_sync from anon, authenticated;

-- Which symbols sync-news should cover, stalest first: the market feed, the
-- core set (plays, setups, smart money, sector ETFs) and anything an open tab
-- is showing. A symbol is due after p_stale_minutes.
create or replace function public.news_queue(p_limit integer default 20, p_stale_minutes integer default 10)
returns table (symbol text, synced_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with wanted as (
    select unnest(array['^GSPC', '^IXIC', '^DJI']) as symbol, 0 as pri
    union all select s, 1 from public.core_symbols() as c(s)
    union all select q.symbol, 1 from public.quote_interest q where q.last_seen > now() - interval '10 minutes'
  ), w as (select symbol, min(pri) as pri from wanted group by symbol)
  select w.symbol, ns.synced_at
    from w left join public.news_sync ns on ns.symbol = w.symbol
   where ns.synced_at is null or ns.synced_at < now() - make_interval(mins => p_stale_minutes)
   order by ns.synced_at nulls first, w.pri, w.symbol
   limit greatest(1, least(p_limit, 60))
$$;
revoke all on function public.news_queue(integer, integer) from public, anon, authenticated;
grant execute on function public.news_queue(integer, integer) to service_role;

-- Insert new stories; for a story already stored, add any new related tickers
-- (the same story arrives once per symbol it mentions). Returns how many were new.
create or replace function public.upsert_news(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  with src as (
    select distinct on (r.uuid) r.*
      from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
           as r(uuid text, title text, publisher text, link text, kind text, published_at timestamptz, tickers text[], thumb text)
     where r.uuid is not null and r.title is not null and r.link is not null and r.published_at is not null
  ), ins as (
    insert into public.news_items (uuid, title, publisher, link, kind, published_at, tickers, thumb)
    select uuid, title, publisher, link, coalesce(kind, 'STORY'), published_at, coalesce(tickers, '{}'), thumb from src
    on conflict (uuid) do update
      set tickers = (select array_agg(distinct t order by t) from unnest(public.news_items.tickers || excluded.tickers) as t)
      where not (public.news_items.tickers @> excluded.tickers)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into n from ins;
  return coalesce(n, 0);
end $$;
revoke all on function public.upsert_news(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_news(jsonb) to service_role;

-- keep 30 days of stories
create or replace function private.prune_news()
returns void
language sql
security definer
set search_path = ''
as $$ delete from public.news_items where published_at < now() - interval '30 days' $$;

-- ---------------------------------------------------------------- realtime
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_quotes') then
    execute 'alter publication supabase_realtime add table public.live_quotes';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'news_items') then
    execute 'alter publication supabase_realtime add table public.news_items';
  end if;
end $$;

-- ---------------------------------------------------------------- schedule
-- 04:00-20:00 New York on weekdays covers pre-market, the session and
-- after-hours. Outside it, one refresh every 30 minutes keeps the closing
-- prices on screen.
create or replace function private.extended_hours()
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.ny_weekday()
     and private.ny_now()::time >= time '04:00'
     and private.ny_now()::time < time '20:05'
$$;

do $$
begin
  perform cron.unschedule(jobname) from cron.job where jobname in ('quotes-live', 'quotes-offhours', 'news-live', 'news-offhours', 'news-prune', 'intraday-cache-prune');
end $$;

select cron.schedule('quotes-live', '30 seconds', $$
  select private.invoke_edge('sync-quotes', '{}'::jsonb, 25000) where private.extended_hours()
$$);
select cron.schedule('quotes-offhours', '*/30 * * * *', $$
  select private.invoke_edge('sync-quotes', '{}'::jsonb, 25000) where not private.extended_hours()
$$);
select cron.schedule('news-live', '*/2 * * * *', $$
  select private.invoke_edge('sync-news', '{"limit": 20, "staleMinutes": 8}'::jsonb, 60000) where private.extended_hours()
$$);
select cron.schedule('news-offhours', '1-59/15 * * * *', $$
  select private.invoke_edge('sync-news', '{"limit": 20, "staleMinutes": 45}'::jsonb, 60000) where not private.extended_hours()
$$);
select cron.schedule('news-prune', '20 6 * * *', $$ select private.prune_news() $$);

-- ---------------------------------------------------------------- intraday cache
-- fetch-intraday answers chart requests for 1m-1h bars. Many open tabs on
-- the same symbol share one Yahoo request: the payload is cached here for
-- 30 seconds in the session (10 minutes otherwise).
create table if not exists public.intraday_cache (
  symbol text not null,
  interval text not null,
  range text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (symbol, interval, range)
);
alter table public.intraday_cache enable row level security;
revoke all on public.intraday_cache from anon, authenticated;
select cron.schedule('intraday-cache-prune', '40 * * * *', $$
  delete from public.intraday_cache where fetched_at < now() - interval '2 hours'
$$);
