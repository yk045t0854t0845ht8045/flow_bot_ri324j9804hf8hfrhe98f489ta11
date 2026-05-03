-- Hardening: test variable tables with RLS enabled must have explicit policies.
-- These tables can contain sensitive runtime/test values, so only service_role receives direct table access.
-- Run once after the tables exist. This script is idempotent and skips missing tables.

do $$
declare
  v_table regclass;
  v_table_name text;
  v_policy_name text;
  v_tables text[] := array[
    'public.test_variables',
    'public.test_variable_read_logs',
    'public.test_variable_projects',
    'public.test_variable_groups'
  ];
begin
  foreach v_table_name in array v_tables loop
    v_table := to_regclass(v_table_name);

    if v_table is null then
      raise notice 'Skipping missing table: %', v_table_name;
      continue;
    end if;

    v_policy_name := 'service_role_all_' || split_part(v_table_name, '.', 2);

    execute format('alter table %s enable row level security', v_table);
    execute format('drop policy if exists %I on %s', v_policy_name, v_table);

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format(
        'create policy %I on %s for all to service_role using (true) with check (true)',
        v_policy_name,
        v_table
      );
    else
      raise notice 'Role service_role not found; policy not created for %', v_table_name;
    end if;
  end loop;
end
$$;
