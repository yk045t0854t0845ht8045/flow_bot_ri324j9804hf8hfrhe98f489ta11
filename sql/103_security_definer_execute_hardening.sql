-- Hardening: SECURITY DEFINER functions must not be callable from public API roles.
-- Run once after the functions exist. This script is idempotent and skips missing functions.

do $$
declare
  v_proc regprocedure;
  v_proc_name text;
  v_procs text[] := array[
    'public.apply_user_plan_flow_points_event(bigint,text,numeric,text,text,bigint,jsonb)',
    'public.rls_auto_enable()',
    'public.system_status_acquire_runtime_lease(text,text,integer,jsonb)',
    'public.system_status_claim_outbox_batch(text,integer,integer)',
    'public.system_status_complete_outbox_item(uuid,jsonb)',
    'public.system_status_enqueue_outbox(text,text,uuid,uuid,jsonb)',
    'public.system_status_fail_outbox_item(uuid,text,integer,integer,jsonb)',
    'public.system_status_ingest_check(text,public.system_status_type,integer,text,integer,text,jsonb,timestamptz)',
    'public.system_status_insert_activity(text,text,text,text,jsonb)',
    'public.system_status_record_metric(text,text,numeric,text,timestamptz,integer,jsonb)',
    'public.system_status_release_runtime_lease(text,text)',
    'public.system_status_reconcile_open_incidents()'
  ];
begin
  foreach v_proc_name in array v_procs loop
    v_proc := to_regprocedure(v_proc_name);

    if v_proc is null then
      raise notice 'Skipping missing function: %', v_proc_name;
      continue;
    end if;

    execute format('revoke execute on function %s from public', v_proc);

    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', v_proc);
    end if;

    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke execute on function %s from authenticated', v_proc);
    end if;

    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', v_proc);
    end if;
  end loop;
end
$$;
