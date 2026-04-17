-- Corrige o RPC public.system_status_ingest_check em ambientes que ainda
-- estao com a versao antiga da funcao (082) e tambem regrava a versao nova
-- (083+) quando a estrutura enterprise ja existe.

do $$
begin
  if to_regclass('public.system_status_monitor_policies') is not null
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'system_status_monitor_snapshots'
        and column_name = 'policy_snapshot'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'system_components'
        and column_name = 'monitoring_enabled'
    )
  then
    execute $fn$
create or replace function public.system_status_ingest_check(
  p_component_name text,
  p_raw_status public.system_status_type,
  p_latency_ms integer default null,
  p_message text default null,
  p_response_code integer default null,
  p_source_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_observed_at timestamptz default timezone('utc', now())
)
returns table (
  component_id uuid,
  stable_status public.system_status_type,
  raw_status public.system_status_type,
  should_alert boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $body$
declare
  v_component public.system_components%rowtype;
  v_policy public.system_status_monitor_policies%rowtype;
  v_snapshot_id uuid;
  v_previous_stable public.system_status_type;
  v_next_stable public.system_status_type;
  v_failures_recent integer := 0;
  v_majors_recent integer := 0;
  v_operational_recent integer := 0;
  v_degraded_recent integer := 0;
  v_today date := timezone('utc', coalesce(p_observed_at, timezone('utc', now())))::date;
  v_sample_size integer := greatest(coalesce(nullif(p_metadata ->> 'sampleSize', '')::integer, 1), 1);
  v_success_count integer := 0;
  v_degraded_count integer := 0;
  v_failure_count integer := 0;
  v_checker_key text := coalesce(nullif(p_metadata ->> 'checkerKey', ''), 'internal-status-monitor');
  v_checker_region text := nullif(p_metadata ->> 'checkerRegion', '');
  v_confidence_score numeric(5,2);
  v_has_active_maintenance boolean := false;
  v_should_alert boolean := false;
  v_success_ratio numeric(5,2);
  v_effective_message text;
begin
  select *
  into v_component
  from public.system_components
  where name = p_component_name
  limit 1;

  if not found then
    raise exception 'Componente de status nao encontrado: %', p_component_name;
  end if;

  select *
  into v_policy
  from public.system_status_monitor_policies p
  where p.component_id = v_component.id;

  if not found then
    insert into public.system_status_monitor_policies (component_id)
    values (v_component.id)
    returning * into v_policy;
  end if;

  v_success_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'successCount', '')::integer,
      case when p_raw_status = 'operational' then v_sample_size else 0 end
    ),
    0
  );
  v_degraded_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'degradedCount', '')::integer,
      case when p_raw_status = 'degraded_performance' then v_sample_size else 0 end
    ),
    0
  );
  v_failure_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'failureCount', '')::integer,
      case when p_raw_status in ('partial_outage', 'major_outage') then v_sample_size else 0 end
    ),
    0
  );

  v_confidence_score := coalesce(
    nullif(p_metadata ->> 'confidenceScore', '')::numeric(5,2),
    round(
      (
        greatest(v_success_count, v_degraded_count, v_failure_count)::numeric
        / greatest(v_sample_size, 1)::numeric
      ) * 100,
      2
    )::numeric(5,2)
  );

  v_success_ratio := round(
    (
      greatest(v_success_count, 0)::numeric
      / greatest(v_sample_size, 1)::numeric
    ) * 100,
    2
  )::numeric(5,2);

  select exists (
    select 1
    from public.system_maintenances sm
    join public.system_maintenance_components smc on smc.maintenance_id = sm.id
    where smc.component_id = v_component.id
      and sm.status in ('scheduled', 'in_progress')
      and coalesce(p_observed_at, timezone('utc', now())) between sm.scheduled_for and sm.scheduled_until
  )
  into v_has_active_maintenance;

  v_previous_stable := coalesce(v_component.status, 'operational');

  insert into public.system_status_monitor_snapshots (
    source_key,
    component_slug,
    component_id,
    component_name,
    status,
    stable_status,
    latency_ms,
    response_code,
    message,
    metadata,
    observed_at,
    sample_size,
    success_count,
    degraded_count,
    failure_count,
    checker_key,
    checker_region,
    confidence_score,
    policy_snapshot
  )
  values (
    coalesce(p_source_key, v_component.source_key, v_component.slug, lower(regexp_replace(v_component.name, '[^a-zA-Z0-9]+', '-', 'g'))),
    v_component.slug,
    v_component.id,
    v_component.name,
    p_raw_status,
    null,
    p_latency_ms,
    p_response_code,
    p_message,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    v_success_count,
    v_degraded_count,
    v_failure_count,
    v_checker_key,
    v_checker_region,
    v_confidence_score,
    to_jsonb(v_policy)
  )
  returning id into v_snapshot_id;

  with recent as (
    select
      s.status,
      row_number() over (order by s.observed_at desc, s.id desc) as rn
    from public.system_status_monitor_snapshots s
    where s.component_id = v_component.id
    order by s.observed_at desc, s.id desc
    limit greatest(v_policy.evaluation_window, 5)
  )
  select
    count(*) filter (where rn <= v_policy.evaluation_window and status in ('partial_outage', 'major_outage')),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'major_outage'),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'operational'),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'degraded_performance')
  into
    v_failures_recent,
    v_majors_recent,
    v_operational_recent,
    v_degraded_recent
  from recent;

  v_next_stable := v_previous_stable;

  if not coalesce(v_component.monitoring_enabled, true) then
    v_next_stable := v_previous_stable;
  elsif v_has_active_maintenance then
    v_next_stable := coalesce(v_previous_stable, 'operational');
  elsif p_raw_status = 'major_outage' and (
    v_failure_count >= v_policy.major_quorum
    or v_majors_recent >= v_policy.major_quorum
    or (
      v_policy.latency_major_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_major_ms
      and v_failure_count >= v_policy.failure_quorum
    )
  ) then
    v_next_stable := 'major_outage';
  elsif p_raw_status in ('partial_outage', 'major_outage') and (
    v_failure_count >= v_policy.failure_quorum
    or v_failures_recent >= v_policy.failure_quorum
    or (
      v_policy.latency_partial_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_partial_ms
      and (v_failure_count + v_degraded_count) >= v_policy.failure_quorum
    )
  ) then
    v_next_stable := 'partial_outage';
  elsif coalesce(v_policy.allow_degraded_status, true) and p_raw_status = 'degraded_performance' and (
    v_degraded_count >= v_policy.degraded_quorum
    or v_degraded_recent >= v_policy.degraded_quorum
    or (
      v_policy.latency_degraded_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_degraded_ms
    )
  ) then
    v_next_stable := 'degraded_performance';
  elsif p_raw_status = 'operational' and (
    v_success_count >= v_policy.recovery_quorum
    or v_operational_recent >= v_policy.recovery_quorum
  ) then
    v_next_stable := 'operational';
  end if;

  if v_component.name = 'Flow AI'
    and v_next_stable = 'degraded_performance'
    and v_confidence_score < greatest(v_policy.min_confidence_pct, 85.00::numeric)
  then
    v_next_stable := coalesce(v_previous_stable, 'operational');
  end if;

  v_effective_message := case
    when v_has_active_maintenance then coalesce(p_message, 'Componente em manutencao programada.')
    else p_message
  end;

  v_should_alert := public.system_status_is_incident_worthy(v_next_stable)
    and not v_has_active_maintenance
    and v_confidence_score >= coalesce(v_policy.min_confidence_pct, 66.67)
    and (
      v_previous_stable is distinct from v_next_stable
      or v_component.last_alerted_at is null
      or v_component.last_alerted_at <= coalesce(p_observed_at, timezone('utc', now())) - make_interval(mins => v_policy.alert_cooldown_minutes)
    );

  update public.system_status_monitor_snapshots
  set stable_status = v_next_stable
  where id = v_snapshot_id;

  update public.system_components
  set
    status = v_next_stable,
    latency_ms = p_latency_ms,
    source_key = coalesce(p_source_key, source_key),
    status_message = v_effective_message,
    last_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    last_raw_status = p_raw_status,
    last_raw_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    status_changed_at = case
      when status is distinct from v_next_stable then coalesce(p_observed_at, timezone('utc', now()))
      else status_changed_at
    end,
    last_failure_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_failure_at
    end,
    last_recovered_at = case
      when v_next_stable = 'operational' and status <> 'operational' then coalesce(p_observed_at, timezone('utc', now()))
      else last_recovered_at
    end,
    last_alerted_at = case
      when v_should_alert then coalesce(p_observed_at, timezone('utc', now()))
      else last_alerted_at
    end,
    last_incident_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_incident_at
    end,
    today_failure_count = case
      when public.system_status_is_incident_worthy(v_next_stable) and status = 'operational' then
        case
          when last_failure_at is not null
            and timezone('utc', last_failure_at)::date = v_today
          then coalesce(today_failure_count, 0) + 1
          else 1
        end
      when last_failure_at is not null
        and timezone('utc', last_failure_at)::date <> v_today
      then 0
      else coalesce(today_failure_count, 0)
    end,
    updated_at = timezone('utc', now()),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_raw_status', p_raw_status,
      'last_stable_status', v_next_stable,
      'last_message', v_effective_message,
      'last_response_code', p_response_code,
      'last_monitor_metadata', coalesce(p_metadata, '{}'::jsonb),
      'sample_size', v_sample_size,
      'success_count', v_success_count,
      'degraded_count', v_degraded_count,
      'failure_count', v_failure_count,
      'checker_key', v_checker_key,
      'checker_region', v_checker_region,
      'confidence_score', v_confidence_score
    )
  where id = v_component.id;

  insert into public.system_status_history (
    component_id,
    status,
    recorded_at
  )
  values (
    v_component.id,
    v_next_stable,
    v_today
  )
  on conflict (component_id, recorded_at) do update
  set status = case
    when public.get_status_severity_weight(excluded.status) > public.get_status_severity_weight(public.system_status_history.status)
    then excluded.status
    else public.system_status_history.status
  end;

  if p_latency_ms is not null then
    perform public.system_status_record_metric(
      v_component.name,
      'latency_ms',
      p_latency_ms,
      'ms',
      coalesce(p_observed_at, timezone('utc', now())),
      v_sample_size,
      jsonb_build_object('status', v_next_stable, 'checker_key', v_checker_key)
    );
  end if;

  perform public.system_status_record_metric(
    v_component.name,
    'confidence_pct',
    v_confidence_score,
    'percent',
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    jsonb_build_object('raw_status', p_raw_status)
  );

  perform public.system_status_record_metric(
    v_component.name,
    'success_ratio_pct',
    v_success_ratio,
    'percent',
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    jsonb_build_object('stable_status', v_next_stable)
  );

  if v_previous_stable is distinct from v_next_stable then
    perform public.system_status_insert_activity(
      'component',
      v_component.id::text,
      'policy_decision',
      format('%s estabilizou em %s a partir de %s.', v_component.name, v_next_stable, p_raw_status),
      jsonb_build_object(
        'raw_status', p_raw_status,
        'stable_status', v_next_stable,
        'confidence_score', v_confidence_score,
        'sample_size', v_sample_size,
        'failure_count', v_failure_count,
        'degraded_count', v_degraded_count,
        'success_count', v_success_count,
        'maintenance_active', v_has_active_maintenance
      )
    );
  end if;

  if v_should_alert then
    perform public.system_status_enqueue_outbox(
      format(
        'component:%s:%s:%s',
        v_component.id,
        v_next_stable,
        to_char(date_trunc('minute', coalesce(p_observed_at, timezone('utc', now()))), 'YYYYMMDDHH24MI')
      ),
      'component_alert',
      v_component.id,
      null,
      jsonb_build_object(
        'component_name', v_component.name,
        'stable_status', v_next_stable,
        'raw_status', p_raw_status,
        'message', v_effective_message,
        'confidence_score', v_confidence_score
      )
    );
  end if;

  return query
  select
    v_component.id,
    v_next_stable,
    p_raw_status,
    v_should_alert;
end;
$body$;
$fn$;
  else
    execute $fn$
create or replace function public.system_status_ingest_check(
  p_component_name text,
  p_raw_status public.system_status_type,
  p_latency_ms integer default null,
  p_message text default null,
  p_response_code integer default null,
  p_source_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_observed_at timestamptz default timezone('utc', now())
)
returns table (
  component_id uuid,
  stable_status public.system_status_type,
  raw_status public.system_status_type,
  should_alert boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $body$
declare
  v_component public.system_components%rowtype;
  v_snapshot_id uuid;
  v_previous_stable public.system_status_type;
  v_next_stable public.system_status_type;
  v_failures_last3 integer := 0;
  v_majors_last2 integer := 0;
  v_operational_last2 integer := 0;
  v_degraded_last3 integer := 0;
  v_today date := timezone('utc', coalesce(p_observed_at, timezone('utc', now())))::date;
begin
  select *
  into v_component
  from public.system_components
  where name = p_component_name
  limit 1;

  if not found then
    raise exception 'Componente de status nao encontrado: %', p_component_name;
  end if;

  v_previous_stable := coalesce(v_component.status, 'operational');

  insert into public.system_status_monitor_snapshots (
    source_key,
    component_slug,
    component_id,
    component_name,
    status,
    latency_ms,
    response_code,
    message,
    metadata,
    observed_at
  )
  values (
    coalesce(p_source_key, v_component.source_key, v_component.slug, lower(regexp_replace(v_component.name, '[^a-zA-Z0-9]+', '-', 'g'))),
    v_component.slug,
    v_component.id,
    v_component.name,
    p_raw_status,
    p_latency_ms,
    p_response_code,
    p_message,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_observed_at, timezone('utc', now()))
  )
  returning id into v_snapshot_id;

  with recent as (
    select
      s.status,
      row_number() over (order by s.observed_at desc, s.id desc) as rn
    from public.system_status_monitor_snapshots s
    where s.component_id = v_component.id
    order by s.observed_at desc, s.id desc
    limit 5
  )
  select
    count(*) filter (where rn <= 3 and status in ('partial_outage', 'major_outage')),
    count(*) filter (where rn <= 2 and status = 'major_outage'),
    count(*) filter (where rn <= 2 and status = 'operational'),
    count(*) filter (where rn <= 3 and status = 'degraded_performance')
  into
    v_failures_last3,
    v_majors_last2,
    v_operational_last2,
    v_degraded_last3
  from recent;

  v_next_stable := v_previous_stable;

  if p_raw_status = 'major_outage' and v_majors_last2 >= 2 then
    v_next_stable := 'major_outage';
  elsif p_raw_status in ('partial_outage', 'major_outage') and v_failures_last3 >= 2 then
    v_next_stable := case
      when v_majors_last2 >= 2 then 'major_outage'
      else 'partial_outage'
    end;
  elsif p_raw_status = 'degraded_performance' and v_degraded_last3 >= 3 then
    v_next_stable := 'degraded_performance';
  elsif p_raw_status = 'operational' and v_operational_last2 >= 2 then
    v_next_stable := 'operational';
  end if;

  if v_component.name = 'Flow AI' and v_next_stable = 'degraded_performance' then
    v_next_stable := 'operational';
  end if;

  update public.system_status_monitor_snapshots
  set stable_status = v_next_stable
  where id = v_snapshot_id;

  update public.system_components
  set
    status = v_next_stable,
    latency_ms = p_latency_ms,
    source_key = coalesce(p_source_key, source_key),
    status_message = p_message,
    last_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    last_raw_status = p_raw_status,
    last_raw_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    status_changed_at = case
      when status is distinct from v_next_stable then coalesce(p_observed_at, timezone('utc', now()))
      else status_changed_at
    end,
    last_failure_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_failure_at
    end,
    last_recovered_at = case
      when v_next_stable = 'operational' and status <> 'operational' then coalesce(p_observed_at, timezone('utc', now()))
      else last_recovered_at
    end,
    today_failure_count = case
      when public.system_status_is_incident_worthy(v_next_stable) and status = 'operational' then
        case
          when last_failure_at is not null
            and timezone('utc', last_failure_at)::date = v_today
          then coalesce(today_failure_count, 0) + 1
          else 1
        end
      when last_failure_at is not null
        and timezone('utc', last_failure_at)::date <> v_today
      then 0
      else coalesce(today_failure_count, 0)
    end,
    updated_at = timezone('utc', now()),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_raw_status', p_raw_status,
      'last_stable_status', v_next_stable,
      'last_message', p_message,
      'last_response_code', p_response_code,
      'last_monitor_metadata', coalesce(p_metadata, '{}'::jsonb)
    )
  where id = v_component.id;

  insert into public.system_status_history (
    component_id,
    status,
    recorded_at
  )
  values (
    v_component.id,
    v_next_stable,
    v_today
  )
  on conflict (component_id, recorded_at) do update
  set status = case
    when public.get_status_severity_weight(excluded.status) > public.get_status_severity_weight(public.system_status_history.status)
    then excluded.status
    else public.system_status_history.status
  end;

  return query
  select
    v_component.id,
    v_next_stable,
    p_raw_status,
    public.system_status_is_incident_worthy(v_next_stable);
end;
$body$;
$fn$;
  end if;
end
$$;
