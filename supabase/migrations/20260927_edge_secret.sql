-- Edge-function refresh secret, kept only in Supabase Vault.
--
-- pg_cron calls the data functions through private.invoke_edge, which reads
-- the secret from Vault and sends it as the x-refresh-secret header. The edge
-- functions read the same secret through public.edge_refresh_secret(), which
-- only the service role can execute. No copy of the secret lives in source
-- code, and running this migration generates a fresh random value (rotating
-- any earlier secret).

do $$
declare
  v_id uuid;
  v_new text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  select id into v_id from vault.secrets where name = 'refresh_secret' limit 1;
  if v_id is null then
    perform vault.create_secret(v_new, 'refresh_secret', 'x-refresh-secret for the VIBA Terminal edge functions');
  else
    perform vault.update_secret(v_id, v_new);
  end if;
end $$;

create or replace function public.edge_refresh_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'refresh_secret' limit 1
$$;

revoke all on function public.edge_refresh_secret() from public, anon, authenticated;
grant execute on function public.edge_refresh_secret() to service_role;
