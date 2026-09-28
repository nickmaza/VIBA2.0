-- RPC helpers used by the edge functions (service role) and the app (read-only ones).

-- copy market cap / industry from the Nasdaq directory onto the library
create or replace function public.apply_directory_to_library()
returns integer
language sql
security definer
set search_path = public
as $$
  with u as (
    update public.symbol_meta m
       set market_cap = d.market_cap,
           industry = coalesce(d.industry, m.industry),
           updated_at = now()
      from public.symbol_directory d
     where d.symbol = m.symbol
       and (m.market_cap is distinct from d.market_cap or (d.industry is not null and m.industry is distinct from d.industry))
    returning 1
  )
  select count(*)::integer from u;
$$;

-- SEC CIKs for library symbols: [{symbol, cik}]
create or replace function public.set_ciks(p_rows jsonb)
returns integer
language sql
security definer
set search_path = public
as $$
  with src as (
    select x ->> 'symbol' as symbol, (x ->> 'cik')::bigint as cik from jsonb_array_elements(p_rows) x
  ), u as (
    update public.symbol_meta m set cik = src.cik
      from src
     where m.symbol = src.symbol and m.cik is distinct from src.cik
    returning 1
  )
  select count(*)::integer from u;
$$;

-- price-sync bookkeeping: [{symbol, ok, source, error, last_event_ts}]
create or replace function public.mark_price_sync(p_rows jsonb)
returns integer
language sql
security definer
set search_path = public
as $$
  with src as (
    select x ->> 'symbol' as symbol,
           coalesce((x ->> 'ok')::boolean, false) as ok,
           x ->> 'source' as source,
           x ->> 'error' as error,
           (x ->> 'last_event_ts')::bigint as last_event_ts
      from jsonb_array_elements(p_rows) x
  ), u as (
    update public.symbol_meta m set
      prices_synced_at = now(),
      price_source = coalesce(src.source, m.price_source),
      sync_error = case when src.ok then null else left(src.error, 300) end,
      sync_fail_count = case when src.ok then 0 else m.sync_fail_count + 1 end,
      last_event_ts = coalesce(src.last_event_ts, m.last_event_ts),
      updated_at = now()
      from src
     where m.symbol = src.symbol
    returning 1
  )
  select count(*)::integer from u;
$$;

-- options-sync bookkeeping: [{symbol, optionable}]
create or replace function public.mark_options_sync(p_rows jsonb)
returns integer
language sql
security definer
set search_path = public
as $$
  with src as (
    select x ->> 'symbol' as symbol, (x ->> 'optionable')::boolean as optionable
      from jsonb_array_elements(p_rows) x
  ), u as (
    update public.symbol_meta m set
      options_synced_at = now(),
      optionable = coalesce(src.optionable, m.optionable)
      from src
     where m.symbol = src.symbol
    returning 1
  )
  select count(*)::integer from u;
$$;

-- the names with the most option premium in the latest session (intraday refresh set)
create or replace function public.options_top_symbols(n integer default 120)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select symbol from public.options_daily
   where d = (select max(d) from public.options_daily)
   order by call_premium + put_premium desc
   limit n
$$;

-- daily bars for several symbols as one compact JSON object:
-- { SYM: { t:[dates], o:[], h:[], l:[], c:[], v:[], a:[adj close] } }
create or replace function public.bars_json_many(p_symbols text[], p_since date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_object_agg(symbol, b), '{}'::jsonb)
  from (
    select symbol, jsonb_build_object(
      't', jsonb_agg(to_char(date, 'YYYY-MM-DD') order by date),
      'o', jsonb_agg(coalesce(open, close) order by date),
      'h', jsonb_agg(greatest(coalesce(high, close), coalesce(open, close), close) order by date),
      'l', jsonb_agg(least(coalesce(low, close), coalesce(open, close), close) order by date),
      'c', jsonb_agg(close order by date),
      'v', jsonb_agg(coalesce(volume, 0) order by date),
      'a', jsonb_agg(coalesce(adj_close, close) order by date)
    ) as b
    from public.raw_prices
    where symbol = any (p_symbols) and date >= p_since
    group by symbol
  ) s;
$$;

revoke execute on function public.apply_directory_to_library() from public, anon, authenticated;
revoke execute on function public.set_ciks(jsonb) from public, anon, authenticated;
revoke execute on function public.mark_price_sync(jsonb) from public, anon, authenticated;
revoke execute on function public.mark_options_sync(jsonb) from public, anon, authenticated;
revoke execute on function public.options_top_symbols(integer) from public, anon, authenticated;
grant execute on function public.apply_directory_to_library() to service_role;
grant execute on function public.set_ciks(jsonb) to service_role;
grant execute on function public.mark_price_sync(jsonb) to service_role;
grant execute on function public.mark_options_sync(jsonb) to service_role;
grant execute on function public.options_top_symbols(integer) to service_role;
grant execute on function public.bars_json_many(text[], date) to anon, authenticated, service_role;
