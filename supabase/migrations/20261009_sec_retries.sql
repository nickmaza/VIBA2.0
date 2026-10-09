-- Hourly retries for the SEC-backed weekly and daily jobs.
--
-- SEC EDGAR rate-limits by client address, and Supabase edge functions share
-- egress addresses with other projects, so sync-directory (weekly) and
-- sync-13f (daily) can be refused even though they send only a few requests.
-- Both functions retry with backoff and then log the run as failed (nothing
-- already stored is removed). These jobs re-run a failed job every hour until
-- it succeeds, and stop after 12 failures in a row; the next regular run
-- starts over.

create or replace function private.retry_due(p_source text, p_max_failures integer)
returns boolean
language sql
stable
set search_path = ''
as $$
  with last_ok as (
    select max(refreshed_at) as at from public.refresh_log where source = p_source and ok
  )
  select coalesce((select not r.ok from public.refresh_log r
                    where r.source = p_source order by r.refreshed_at desc limit 1), false)
     and (select count(*) from public.refresh_log r, last_ok
           where r.source = p_source and not r.ok
             and r.refreshed_at > coalesce(last_ok.at, '-infinity'::timestamptz)) < p_max_failures
$$;

revoke all on function private.retry_due(text, integer) from public;

do $$
begin
  perform cron.unschedule(jobname) from cron.job where jobname in ('directory-retry', 'funds-13f-retry');
end $$;

select cron.schedule('directory-retry', '45 * * * *', $$
  select private.invoke_edge('sync-directory', '{}'::jsonb, 30000) where private.retry_due('sync-directory', 12)
$$);

select cron.schedule('funds-13f-retry', '55 * * * *', $$
  select private.invoke_edge('sync-13f', '{}'::jsonb, 30000) where private.retry_due('sync-13f', 12)
$$);
