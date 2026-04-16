begin;

create extension if not exists pgcrypto;

create table if not exists public.system_status_runtime_leases (
  lease_name text primary key,
  holder_id text not null,
  lease_token uuid not null default gen_random_uuid(),
  leased_until timestamptz not null,
  heartbeat_at timestamptz not null default timezone('utc', now()),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_system_status_runtime_leases_until
on public.system_status_runtime_leases (leased_until, heartbeat_at desc);

alter table public.system_status_runtime_leases enable row level security;

do $$ begin
  create policy "service_role_manage_runtime_leases"
  on public.system_status_runtime_leases
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

create or replace function public.system_status_touch_runtime_lease_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_status_runtime_leases_touch_updated_at on public.system_status_runtime_leases;
create trigger tr_system_status_runtime_leases_touch_updated_at
before update on public.system_status_runtime_leases
for each row
execute function public.system_status_touch_runtime_lease_updated_at();

create or replace function public.system_status_acquire_runtime_lease(
  p_lease_name text,
  p_holder_id text,
  p_ttl_seconds integer default 90,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_rows integer := 0;
  v_lease_name text := trim(coalesce(p_lease_name, ''));
  v_holder_id text := trim(coalesce(p_holder_id, ''));
  v_ttl integer := greatest(coalesce(p_ttl_seconds, 90), 30);
begin
  if v_lease_name = '' or v_holder_id = '' then
    return false;
  end if;

  update public.system_status_runtime_leases
  set
    holder_id = v_holder_id,
    lease_token = gen_random_uuid(),
    leased_until = v_now + make_interval(secs => v_ttl),
    heartbeat_at = v_now,
    metadata = coalesce(public.system_status_runtime_leases.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
  where lease_name = v_lease_name
    and (
      leased_until <= v_now
      or holder_id = v_holder_id
    );

  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    insert into public.system_status_runtime_leases (
      lease_name,
      holder_id,
      leased_until,
      heartbeat_at,
      metadata
    )
    values (
      v_lease_name,
      v_holder_id,
      v_now + make_interval(secs => v_ttl),
      v_now,
      coalesce(p_metadata, '{}'::jsonb)
    )
    on conflict (lease_name) do nothing;

    get diagnostics v_rows = row_count;
  end if;

  return v_rows > 0;
end;
$$;

create or replace function public.system_status_release_runtime_lease(
  p_lease_name text,
  p_holder_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
begin
  update public.system_status_runtime_leases
  set
    leased_until = v_now,
    heartbeat_at = v_now,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('released_at', v_now)
  where lease_name = trim(coalesce(p_lease_name, ''))
    and holder_id = trim(coalesce(p_holder_id, ''));

  return found;
end;
$$;

create or replace function public.system_status_claim_outbox_batch(
  p_worker_id text,
  p_limit integer default 10,
  p_visibility_timeout_seconds integer default 300
)
returns table (
  id uuid,
  dedupe_key text,
  event_type text,
  component_id uuid,
  incident_id uuid,
  attempts integer,
  payload jsonb,
  metadata jsonb,
  created_at timestamptz,
  available_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_worker_id text := trim(coalesce(p_worker_id, ''));
  v_limit integer := greatest(coalesce(p_limit, 10), 1);
  v_visibility_timeout integer := greatest(coalesce(p_visibility_timeout_seconds, 300), 30);
begin
  if v_worker_id = '' then
    return;
  end if;

  return query
  with candidates as (
    select o.id
    from public.system_status_notification_outbox o
    where o.status in ('pending', 'failed')
      and o.available_at <= v_now
      and (
        o.locked_at is null
        or o.locked_at <= v_now - make_interval(secs => v_visibility_timeout)
      )
    order by o.available_at asc, o.created_at asc
    for update skip locked
    limit v_limit
  ),
  claimed as (
    update public.system_status_notification_outbox o
    set
      status = 'processing',
      locked_at = v_now,
      attempts = o.attempts + 1,
      metadata = coalesce(o.metadata, '{}'::jsonb) || jsonb_build_object(
        'last_worker_id', v_worker_id,
        'last_claimed_at', v_now
      )
    where o.id in (select c.id from candidates c)
    returning
      o.id,
      o.dedupe_key,
      o.event_type,
      o.component_id,
      o.incident_id,
      o.attempts,
      o.payload,
      o.metadata,
      o.created_at,
      o.available_at
  )
  select
    claimed.id,
    claimed.dedupe_key,
    claimed.event_type,
    claimed.component_id,
    claimed.incident_id,
    claimed.attempts,
    claimed.payload,
    claimed.metadata,
    claimed.created_at,
    claimed.available_at
  from claimed;
end;
$$;

create or replace function public.system_status_complete_outbox_item(
  p_notification_id uuid,
  p_delivery_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
begin
  update public.system_status_notification_outbox
  set
    status = 'sent',
    locked_at = null,
    delivered_at = v_now,
    last_error = null,
    metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_delivery_metadata, '{}'::jsonb)
  where id = p_notification_id;

  return found;
end;
$$;

create or replace function public.system_status_fail_outbox_item(
  p_notification_id uuid,
  p_error text,
  p_retry_seconds integer default 300,
  p_max_attempts integer default 8,
  p_error_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
begin
  update public.system_status_notification_outbox
  set
    status = case
      when attempts >= greatest(coalesce(p_max_attempts, 8), 1) then 'dead_letter'::public.system_outbox_status_type
      else 'failed'::public.system_outbox_status_type
    end,
    locked_at = null,
    available_at = case
      when attempts >= greatest(coalesce(p_max_attempts, 8), 1) then available_at
      else v_now + make_interval(secs => greatest(coalesce(p_retry_seconds, 300), 30))
    end,
    last_error = left(coalesce(p_error, 'unknown error'), 1000),
    metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object('last_failed_at', v_now)
      || coalesce(p_error_metadata, '{}'::jsonb)
  where id = p_notification_id;

  return found;
end;
$$;

create or replace function public.system_status_reconcile_open_incidents()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_incident record;
  v_has_open_failures boolean := false;
  v_fixed integer := 0;
begin
  for v_incident in
    select id
    from public.system_incidents
    where status <> 'resolved'
    order by incident_day desc, updated_at desc
  loop
    select exists (
      select 1
      from public.system_incident_components sic
      join public.system_components sc on sc.id = sic.component_id
      where sic.incident_id = v_incident.id
        and public.system_status_is_incident_worthy(sc.status)
    )
    into v_has_open_failures;

    if not v_has_open_failures then
      update public.system_incidents
      set
        status = 'resolved',
        resolved_at = coalesce(resolved_at, timezone('utc', now())),
        updated_at = timezone('utc', now())
      where id = v_incident.id
        and status <> 'resolved';

      perform public.system_status_insert_incident_update(
        v_incident.id,
        'resolved',
        'Os sinais voltaram ao normal e o incidente foi conciliado automaticamente.'
      );

      v_fixed := v_fixed + 1;
    end if;

    perform public.system_status_refresh_incident_copy(v_incident.id);
  end loop;

  return v_fixed;
end;
$$;

create or replace view public.system_status_outbox_summary as
select
  status,
  count(*) as total,
  min(created_at) as oldest_created_at,
  max(updated_at) as newest_updated_at
from public.system_status_notification_outbox
group by status;

commit;
