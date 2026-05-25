-- Harden every project-owned SECURITY DEFINER function that currently exists in public.
-- Safe to run more than once.

do $$
declare
  fn record;
  has_anon boolean;
  has_authenticated boolean;
  has_service_role boolean;
begin
  select exists(select 1 from pg_roles where rolname = 'anon') into has_anon;
  select exists(select 1 from pg_roles where rolname = 'authenticated') into has_authenticated;
  select exists(select 1 from pg_roles where rolname = 'service_role') into has_service_role;

  for fn in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
      and not exists (
        select 1
        from pg_depend d
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
      )
  loop
    execute format(
      'alter function %s set search_path = pg_catalog, public',
      fn.signature
    );

    execute format('revoke all on function %s from public', fn.signature);

    if has_anon then
      execute format('revoke all on function %s from anon', fn.signature);
    end if;

    if has_authenticated then
      execute format('revoke all on function %s from authenticated', fn.signature);
    end if;

    if has_service_role then
      execute format('grant execute on function %s to service_role', fn.signature);
    end if;
  end loop;
end
$$;
