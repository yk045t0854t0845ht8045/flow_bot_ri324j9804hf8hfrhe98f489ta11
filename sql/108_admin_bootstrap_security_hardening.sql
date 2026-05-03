-- Hardening: admin bootstrap functions must not be exposed through public API roles.
-- Run once after the functions exist. This script is idempotent and skips missing functions.

do $$
declare
  v_guard_proc regprocedure;
  v_bootstrap_proc regprocedure;
begin
  v_guard_proc := to_regprocedure('public.flowdesk_guard_singleton_admin_role()');

  if v_guard_proc is null then
    raise notice 'Skipping missing function: public.flowdesk_guard_singleton_admin_role()';
  else
    execute format('alter function %s set search_path = pg_catalog, public', v_guard_proc);
  end if;

  v_bootstrap_proc := to_regprocedure('public.flowdesk_bootstrap_admin(text)');

  if v_bootstrap_proc is null then
    raise notice 'Skipping missing function: public.flowdesk_bootstrap_admin(text)';
  else
    execute format('alter function %s set search_path = pg_catalog, public', v_bootstrap_proc);
    execute format('revoke execute on function %s from public', v_bootstrap_proc);

    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', v_bootstrap_proc);
    end if;

    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke execute on function %s from authenticated', v_bootstrap_proc);
    end if;

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', v_bootstrap_proc);
    end if;
  end if;
end
$$;
