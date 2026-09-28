-- Read-side helpers for the app (anon role).

-- How far the Form 4 backfill has got: sync-insiders parses the newest filings
-- first, so the Smart Money tab can say which filing dates are covered. Only
-- aggregates are exposed; the queue itself stays private.
create or replace function public.insider_coverage()
returns table (first_filed date, last_filed date, parsed integer, pending integer)
language sql
stable
security definer
set search_path = ''
as $$
  select min(filed) filter (where status = 'done'),
         max(filed) filter (where status = 'done'),
         (count(*) filter (where status = 'done'))::integer,
         (count(*) filter (where status = 'pending'))::integer
    from public.sec_form4_queue
$$;

revoke all on function public.insider_coverage() from public;
grant execute on function public.insider_coverage() to anon, authenticated, service_role;

-- The app only reads. Table-level write grants are removed from the public
-- roles as well (row-level security already blocks those writes).
do $$
declare
  r record;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from anon, authenticated', r.relname);
  end loop;
end $$;

-- The old Robinhood-fed feed table is gone (options and congress data now
-- come from sync-options and sync-congress).
drop table if exists public.smart_money_feed;

-- Every pipeline run names the function that wrote it; the old default
-- ('scheduled_trigger_ingest', from the retired external ingest) is dropped.
alter table public.refresh_log alter column source drop default;
