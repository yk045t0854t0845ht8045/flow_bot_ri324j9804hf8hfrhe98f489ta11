-- Reset Hard do Status Page (versão 2 — limpa também o daily lock e deduplicação)
-- Execute no Supabase SQL Editor para zerar todos os cards e recomeçar do zero.

begin;

-- 1. Remove o lock diário primeiro (para não violar FKs)
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_incident_daily_lock'
  ) then
    execute 'truncate table public.system_incident_daily_lock restart identity cascade';
  end if;
end $$;

-- 2. Limpa incidentes e tudo relacionado
truncate table public.system_incident_components restart identity cascade;
truncate table public.system_incident_updates    restart identity cascade;
truncate table public.system_incidents           restart identity cascade;

-- 3. Limpa histórico e pings
truncate table public.system_status_history restart identity cascade;
truncate table public.system_health_pings   restart identity cascade;

-- 4. Tabelas opcionais (existem em alguns ambientes)
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_monitor_snapshots'
  ) then
    execute 'truncate table public.system_status_monitor_snapshots restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_audit'
  ) then
    execute 'truncate table public.system_status_audit restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_metric_points'
  ) then
    execute 'truncate table public.system_status_metric_points restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_maintenance_components'
  ) then
    execute 'truncate table public.system_maintenance_components restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_maintenances'
  ) then
    execute 'truncate table public.system_maintenances restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_incident_postmortems'
  ) then
    execute 'truncate table public.system_incident_postmortems restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_activity_log'
  ) then
    execute 'truncate table public.system_status_activity_log restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_notification_outbox'
  ) then
    execute 'truncate table public.system_status_notification_outbox restart identity cascade';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'system_status_runtime_leases'
  ) then
    execute 'truncate table public.system_status_runtime_leases restart identity cascade';
  end if;
end $$;

-- 5. Volta todos os componentes para operational
do $$
declare
  v_sql text := 'update public.system_components set status = ''operational''';
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'latency_ms'
  ) then
    v_sql := v_sql || ', latency_ms = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'status_message'
  ) then
    v_sql := v_sql || ', status_message = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_checked_at'
  ) then
    v_sql := v_sql || ', last_checked_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_raw_status'
  ) then
    v_sql := v_sql || ', last_raw_status = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_raw_checked_at'
  ) then
    v_sql := v_sql || ', last_raw_checked_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_failure_at'
  ) then
    v_sql := v_sql || ', last_failure_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_recovered_at'
  ) then
    v_sql := v_sql || ', last_recovered_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'status_changed_at'
  ) then
    v_sql := v_sql || ', status_changed_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'last_alerted_at'
  ) then
    v_sql := v_sql || ', last_alerted_at = null';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'today_failure_count'
  ) then
    v_sql := v_sql || ', today_failure_count = 0';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'system_components' and column_name = 'updated_at'
  ) then
    v_sql := v_sql || ', updated_at = timezone(''utc'', now())';
  end if;

  execute v_sql;
end $$;

commit;
