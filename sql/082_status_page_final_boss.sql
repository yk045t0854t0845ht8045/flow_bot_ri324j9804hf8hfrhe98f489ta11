begin;

create extension if not exists pgcrypto;

alter table public.system_components
  add column if not exists latency_ms integer,
  add column if not exists source_key text,
  add column if not exists last_failure_at timestamptz,
  add column if not exists today_failure_count integer not null default 0,
  add column if not exists last_recovered_at timestamptz,
  add column if not exists status_changed_at timestamptz;

alter table public.system_incidents
  add column if not exists started_at timestamptz not null default timezone('utc', now()),
  add column if not exists resolved_at timestamptz,
  add column if not exists incident_day date,
  add column if not exists public_summary text,
  add column if not exists ai_summary text,
  add column if not exists component_summary text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists signal_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists false_alarm_score numeric(5,2) not null default 0;

create table if not exists public.system_status_monitor_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  component_slug text,
  component_id uuid references public.system_components(id) on delete set null,
  component_name text,
  status public.system_status_type not null,
  stable_status public.system_status_type,
  latency_ms integer,
  response_code integer,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.system_incident_daily_lock (
  id bigint generated always as identity primary key,
  day_key date not null,
  incident_id uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_incident_daily_lock_day_key_unique unique (day_key)
);

do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_incident_daily_lock_incident'
      and conrelid = 'public.system_incident_daily_lock'::regclass
  ) then
    alter table public.system_incident_daily_lock
      add constraint fk_incident_daily_lock_incident
      foreign key (incident_id)
      references public.system_incidents (id)
      on delete set null
      deferrable initially deferred;
  end if;
end $$;

alter table public.system_incident_daily_lock enable row level security;

do $$ begin
  create policy "service_role_all"
  on public.system_incident_daily_lock
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

create index if not exists idx_system_components_status_changed_at
on public.system_components (status_changed_at desc nulls last);

create index if not exists idx_system_status_monitor_snapshots_component_observed
on public.system_status_monitor_snapshots (component_id, observed_at desc);

create index if not exists idx_system_status_monitor_snapshots_source_observed
on public.system_status_monitor_snapshots (source_key, observed_at desc);

create index if not exists idx_system_status_monitor_snapshots_stable_observed
on public.system_status_monitor_snapshots (stable_status, observed_at desc);

create index if not exists idx_incident_daily_lock_day_key
on public.system_incident_daily_lock (day_key desc);

alter table public.system_status_monitor_snapshots enable row level security;

do $$ begin
  create policy "Public can view status monitor snapshots"
  on public.system_status_monitor_snapshots
  for select
  using (true);
exception when duplicate_object then null; end $$;

create or replace function public.get_status_severity_weight(s public.system_status_type)
returns integer
language plpgsql
immutable
as $$
begin
  return case s
    when 'operational' then 1
    when 'degraded_performance' then 2
    when 'partial_outage' then 3
    when 'major_outage' then 4
    else 0
  end;
end;
$$;

create or replace function public.normalize_status_message(p_text text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(
      regexp_replace(lower(trim(coalesce(p_text, ''))), '\s+', ' ', 'g'),
      ''
    ),
    ''
  );
$$;

create or replace function public.system_status_is_incident_worthy(s public.system_status_type)
returns boolean
language sql
immutable
as $$
  select s in ('partial_outage', 'major_outage');
$$;

create or replace function public.system_status_refresh_incident_copy(p_incident_id uuid)
returns void
language plpgsql
as $$
declare
  v_incident_status public.incident_status_type;
  v_has_major boolean := false;
  v_has_partial boolean := false;
  v_component_names text[] := array[]::text[];
  v_component_list text := 'componentes monitorados';
  v_title text;
  v_summary text;
  v_impact public.incident_impact_type;
begin
  select status
  into v_incident_status
  from public.system_incidents
  where id = p_incident_id;

  if not found then
    return;
  end if;

  select
    coalesce(array_agg(sc.name order by sc.display_order, sc.name), array[]::text[]),
    bool_or(sc.status = 'major_outage'),
    bool_or(sc.status = 'partial_outage')
  into v_component_names, v_has_major, v_has_partial
  from public.system_incident_components sic
  join public.system_components sc on sc.id = sic.component_id
  where sic.incident_id = p_incident_id;

  if array_length(v_component_names, 1) is not null then
    v_component_list := array_to_string(v_component_names, ', ');
  end if;

  if v_incident_status = 'resolved' then
    v_title := 'Incidente resolvido';
    v_summary := format(
      'Os sinais voltaram ao normal para %s.',
      v_component_list
    );
    v_impact := 'info';
  elsif v_has_major then
    v_title := 'Falha crítica detectada';
    v_summary := format(
      'Detectamos indisponibilidade crítica em %s e estamos investigando.',
      v_component_list
    );
    v_impact := 'critical';
  elsif v_has_partial then
    v_title := 'Instabilidade detectada';
    v_summary := format(
      'Detectamos instabilidade ou indisponibilidade parcial em %s e estamos investigando.',
      v_component_list
    );
    v_impact := 'warning';
  else
    v_title := 'Investigando instabilidade';
    v_summary := format(
      'Estamos acompanhando sinais recentes em %s.',
      v_component_list
    );
    v_impact := 'warning';
  end if;

  update public.system_incidents
  set
    title = v_title,
    public_summary = v_summary,
    component_summary = v_component_list,
    impact = v_impact,
    updated_at = timezone('utc', now())
  where id = p_incident_id;
end;
$$;

create or replace function public.system_status_insert_incident_update(
  p_incident_id uuid,
  p_status public.incident_status_type,
  p_message text
)
returns uuid
language plpgsql
as $$
declare
  v_update_id uuid;
begin
  if p_incident_id is null or coalesce(trim(p_message), '') = '' then
    return null;
  end if;

  insert into public.system_incident_updates (
    incident_id,
    message,
    status
  )
  values (
    p_incident_id,
    trim(p_message),
    p_status
  )
  on conflict do nothing
  returning id into v_update_id;

  return v_update_id;
end;
$$;

update public.system_incidents
set
  started_at = coalesce(started_at, created_at, timezone('utc', now())),
  incident_day = coalesce(
    incident_day,
    timezone('utc', coalesce(started_at, created_at, timezone('utc', now())))::date
  );

do $$
declare
  v_day date;
  v_canonical_id uuid;
  v_status public.incident_status_type;
  v_impact public.incident_impact_type;
  v_created_at timestamptz;
  v_started_at timestamptz;
  v_updated_at timestamptz;
  v_resolved_at timestamptz;
  v_public_summary text;
  v_ai_summary text;
  v_component_summary text;
  v_metadata jsonb;
  v_signal_snapshot jsonb;
  v_false_alarm_score numeric(5,2);
begin
  for v_day in
    select incident_day
    from public.system_incidents
    where incident_day is not null
    group by incident_day
    having count(*) > 1
  loop
    select id
    into v_canonical_id
    from public.system_incidents
    where incident_day = v_day
    order by created_at asc, id asc
    limit 1;

    insert into public.system_incident_components (incident_id, component_id, created_at)
    select
      v_canonical_id,
      sic.component_id,
      min(sic.created_at)
    from public.system_incident_components sic
    join public.system_incidents si on si.id = sic.incident_id
    where si.incident_day = v_day
      and sic.incident_id <> v_canonical_id
    group by sic.component_id
    on conflict (incident_id, component_id) do nothing;

    update public.system_incident_updates
    set incident_id = v_canonical_id
    where incident_id in (
      select id
      from public.system_incidents
      where incident_day = v_day
        and id <> v_canonical_id
    );

    with ranked_updates as (
      select
        id,
        row_number() over (
          partition by
            incident_id,
            status,
            public.normalize_status_message(message)
          order by created_at asc, id asc
        ) as rn
      from public.system_incident_updates
      where incident_id = v_canonical_id
    )
    delete from public.system_incident_updates
    where id in (
      select id
      from ranked_updates
      where rn > 1
    );

    select
      case
        when count(*) filter (where status = 'investigating') > 0 then 'investigating'::public.incident_status_type
        when count(*) filter (where status = 'identified') > 0 then 'identified'::public.incident_status_type
        when count(*) filter (where status = 'monitoring') > 0 then 'monitoring'::public.incident_status_type
        else 'resolved'::public.incident_status_type
      end,
      case
        when count(*) filter (where impact = 'critical') > 0 then 'critical'::public.incident_impact_type
        when count(*) filter (where impact = 'warning') > 0 then 'warning'::public.incident_impact_type
        else 'info'::public.incident_impact_type
      end,
      min(created_at),
      min(coalesce(started_at, created_at)),
      max(updated_at),
      case
        when count(*) filter (where status <> 'resolved') = 0 then max(resolved_at)
        else null
      end,
      (array_agg(public_summary order by updated_at desc) filter (where public_summary is not null))[1],
      (array_agg(ai_summary order by updated_at desc) filter (where ai_summary is not null))[1],
      (array_agg(component_summary order by updated_at desc) filter (where component_summary is not null))[1],
      coalesce((array_agg(metadata order by updated_at desc) filter (where metadata is not null))[1], '{}'::jsonb),
      coalesce((array_agg(signal_snapshot order by updated_at desc) filter (where signal_snapshot is not null))[1], '{}'::jsonb),
      max(false_alarm_score)
    into
      v_status,
      v_impact,
      v_created_at,
      v_started_at,
      v_updated_at,
      v_resolved_at,
      v_public_summary,
      v_ai_summary,
      v_component_summary,
      v_metadata,
      v_signal_snapshot,
      v_false_alarm_score
    from public.system_incidents
    where incident_day = v_day;

    update public.system_incidents
    set
      status = v_status,
      impact = v_impact,
      created_at = v_created_at,
      started_at = coalesce(v_started_at, v_created_at, timezone('utc', now())),
      updated_at = coalesce(v_updated_at, timezone('utc', now())),
      resolved_at = v_resolved_at,
      public_summary = coalesce(v_public_summary, public_summary),
      ai_summary = coalesce(v_ai_summary, ai_summary),
      component_summary = coalesce(v_component_summary, component_summary),
      metadata = coalesce(metadata, '{}'::jsonb) || coalesce(v_metadata, '{}'::jsonb),
      signal_snapshot = coalesce(signal_snapshot, '{}'::jsonb) || coalesce(v_signal_snapshot, '{}'::jsonb),
      false_alarm_score = greatest(coalesce(false_alarm_score, 0), coalesce(v_false_alarm_score, 0))
    where id = v_canonical_id;

    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'system_incident_daily_lock'
    ) then
      insert into public.system_incident_daily_lock (day_key, incident_id)
      values (v_day, v_canonical_id)
      on conflict (day_key) do update
      set
        incident_id = excluded.incident_id,
        updated_at = timezone('utc', now());
    end if;

    delete from public.system_incidents
    where incident_day = v_day
      and id <> v_canonical_id;
  end loop;
end;
$$;

with ranked_updates as (
  select
    id,
    row_number() over (
      partition by
        incident_id,
        status,
        public.normalize_status_message(message)
      order by created_at asc, id asc
    ) as rn
  from public.system_incident_updates
)
delete from public.system_incident_updates
where id in (
  select id
  from ranked_updates
  where rn > 1
);

alter table public.system_incidents
  alter column incident_day set not null;

do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'system_incidents_incident_day_key'
      and conrelid = 'public.system_incidents'::regclass
  ) then
    alter table public.system_incidents
      add constraint system_incidents_incident_day_key unique (incident_day);
  end if;
end $$;

create unique index if not exists idx_system_incident_updates_dedupe
on public.system_incident_updates (
  incident_id,
  status,
  public.normalize_status_message(message)
);

create or replace function public.sync_system_incident_dates()
returns trigger
language plpgsql
as $$
begin
  if new.started_at is null then
    new.started_at := coalesce(new.created_at, timezone('utc', now()));
  end if;

  if new.incident_day is null then
    new.incident_day := timezone('utc', coalesce(new.started_at, new.created_at, timezone('utc', now())))::date;
  end if;

  if new.status = 'resolved' then
    new.resolved_at := coalesce(new.resolved_at, timezone('utc', now()));
  else
    new.resolved_at := null;
  end if;

  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_incidents_sync_dates on public.system_incidents;
create trigger tr_system_incidents_sync_dates
before insert or update on public.system_incidents
for each row
execute function public.sync_system_incident_dates();

create or replace function public.system_status_sync_daily_lock()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
      from information_schema.tables
      where table_schema = 'public'
        and table_name = 'system_incident_daily_lock'
    ) then
      update public.system_incident_daily_lock
      set
        incident_id = null,
        updated_at = timezone('utc', now())
      where day_key = old.incident_day
        and incident_id = old.id;
    end if;
    return old;
  end if;

  if new.incident_day is not null and exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'system_incident_daily_lock'
  ) then
    insert into public.system_incident_daily_lock (day_key, incident_id)
    values (new.incident_day, new.id)
    on conflict (day_key) do update
    set
      incident_id = excluded.incident_id,
      updated_at = timezone('utc', now());
  end if;

  return new;
end;
$$;

drop trigger if exists tr_system_incidents_daily_lock_sync on public.system_incidents;
create trigger tr_system_incidents_daily_lock_sync
after insert or update or delete on public.system_incidents
for each row
execute function public.system_status_sync_daily_lock();

create or replace function public.system_status_touch_incident_from_update()
returns trigger
language plpgsql
as $$
begin
  update public.system_incidents
  set
    status = new.status,
    resolved_at = case
      when new.status = 'resolved' then coalesce(resolved_at, new.created_at, timezone('utc', now()))
      else null
    end,
    updated_at = coalesce(new.created_at, timezone('utc', now()))
  where id = new.incident_id;

  perform public.system_status_refresh_incident_copy(new.incident_id);
  return new;
end;
$$;

drop trigger if exists tr_system_incident_updates_sync_parent on public.system_incident_updates;
create trigger tr_system_incident_updates_sync_parent
after insert or update on public.system_incident_updates
for each row
execute function public.system_status_touch_incident_from_update();

create or replace function public.system_status_handle_component_transition()
returns trigger
language plpgsql
as $$
declare
  v_incident_id uuid;
  v_incident_day date;
  v_has_open_failures boolean := false;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  v_incident_day := timezone('utc', coalesce(new.last_checked_at, timezone('utc', now())))::date;

  if public.system_status_is_incident_worthy(new.status) then
    insert into public.system_incidents (
      title,
      impact,
      status,
      started_at,
      incident_day,
      public_summary,
      component_summary,
      signal_snapshot
    )
    values (
      'Investigando instabilidade',
      case when new.status = 'major_outage' then 'critical'::public.incident_impact_type else 'warning'::public.incident_impact_type end,
      'investigating',
      coalesce(new.last_checked_at, timezone('utc', now())),
      v_incident_day,
      null,
      new.name,
      jsonb_build_object(
        'source', 'component-trigger',
        'component_id', new.id,
        'component_name', new.name,
        'status', new.status,
        'observed_at', coalesce(new.last_checked_at, timezone('utc', now()))
      )
    )
    on conflict (incident_day) do update
    set
      status = case
        when public.system_incidents.status = 'resolved' then 'investigating'::public.incident_status_type
        else public.system_incidents.status
      end,
      impact = case
        when public.system_incidents.impact = 'critical' or excluded.impact = 'critical' then 'critical'::public.incident_impact_type
        when public.system_incidents.impact = 'warning' or excluded.impact = 'warning' then 'warning'::public.incident_impact_type
        else public.system_incidents.impact
      end,
      resolved_at = null,
      updated_at = timezone('utc', now()),
      signal_snapshot = coalesce(public.system_incidents.signal_snapshot, '{}'::jsonb) || excluded.signal_snapshot
    returning id into v_incident_id;

    insert into public.system_incident_components (incident_id, component_id)
    values (v_incident_id, new.id)
    on conflict (incident_id, component_id) do nothing;

    perform public.system_status_refresh_incident_copy(v_incident_id);
    perform public.system_status_insert_incident_update(
      v_incident_id,
      'investigating',
      format('Detectamos instabilidade no %s e estamos investigando.', new.name)
    );

    return new;
  end if;

  select si.id
  into v_incident_id
  from public.system_incidents si
  join public.system_incident_components sic on sic.incident_id = si.id
  where sic.component_id = new.id
    and si.status <> 'resolved'
  order by si.incident_day desc, si.updated_at desc
  limit 1;

  if v_incident_id is null then
    return new;
  end if;

  select exists (
    select 1
    from public.system_incident_components sic
    join public.system_components sc on sc.id = sic.component_id
    where sic.incident_id = v_incident_id
      and public.system_status_is_incident_worthy(sc.status)
  )
  into v_has_open_failures;

  if not v_has_open_failures then
    update public.system_incidents
    set
      status = 'resolved',
      resolved_at = coalesce(new.last_checked_at, timezone('utc', now())),
      updated_at = coalesce(new.last_checked_at, timezone('utc', now()))
    where id = v_incident_id;

    perform public.system_status_insert_incident_update(
      v_incident_id,
      'resolved',
      'Os sinais voltaram ao normal e o incidente foi resolvido.'
    );

    perform public.system_status_refresh_incident_copy(v_incident_id);
  end if;

  return new;
end;
$$;

drop trigger if exists tr_system_components_manage_daily_incident on public.system_components;
create trigger tr_system_components_manage_daily_incident
after update on public.system_components
for each row
execute function public.system_status_handle_component_transition();

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
set search_path = public
as $$
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
      status,
      row_number() over (order by observed_at desc, id desc) as rn
    from public.system_status_monitor_snapshots
    where component_id = v_component.id
    order by observed_at desc, id desc
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
$$;

create or replace view public.system_incident_feed as
with canonical as (
  select
    si.*,
    row_number() over (
      partition by si.incident_day
      order by si.created_at asc, si.id asc
    ) as rn
  from public.system_incidents si
)
select
  si.id,
  si.title,
  si.impact,
  si.status,
  si.created_at,
  si.updated_at,
  si.started_at,
  si.resolved_at,
  si.incident_day,
  coalesce(
    si.public_summary,
    si.ai_summary,
    si.component_summary,
    last_update.message,
    'Ocorrencia registrada e monitorada pela equipe.'
  ) as summary,
  coalesce(component_names.names, array[]::text[]) as affected_components
from canonical si
left join lateral (
  select siu.message
  from public.system_incident_updates siu
  where siu.incident_id = si.id
  order by siu.created_at desc, siu.id desc
  limit 1
) as last_update on true
left join lateral (
  select array_agg(distinct sc.name order by sc.name) as names
  from public.system_incident_components sic
  join public.system_components sc on sc.id = sic.component_id
  where sic.incident_id = si.id
) as component_names on true
where si.rn = 1;

commit;
