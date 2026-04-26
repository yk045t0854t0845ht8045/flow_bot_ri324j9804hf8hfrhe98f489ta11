create table if not exists public.flowsecure_rate_limit_hits (
  id bigint generated always as identity primary key,
  request_id text not null,
  ip_fingerprint text not null,
  ip_encrypted text not null,
  request_method text not null,
  request_path text not null,
  route_key text not null,
  traffic_scope text not null
    check (traffic_scope in ('page', 'api_read', 'api_mutation', 'auth', 'other')),
  signature_hash text not null,
  signature_kind text not null
    check (signature_kind in ('page', 'query', 'json', 'urlencoded', 'opaque')),
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  blocked boolean not null default false,
  blocked_reason text,
  blocked_until timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_flowsecure_rate_limit_hits_ip_created_at
on public.flowsecure_rate_limit_hits (ip_fingerprint, created_at desc);

create index if not exists idx_flowsecure_rate_limit_hits_ip_signature_created_at
on public.flowsecure_rate_limit_hits (ip_fingerprint, signature_hash, created_at desc);

create index if not exists idx_flowsecure_rate_limit_hits_ip_route_created_at
on public.flowsecure_rate_limit_hits (ip_fingerprint, route_key, created_at desc);

create index if not exists idx_flowsecure_rate_limit_hits_ip_scope_created_at
on public.flowsecure_rate_limit_hits (ip_fingerprint, traffic_scope, created_at desc);

create table if not exists public.flowsecure_rate_limit_blocks (
  ip_fingerprint text primary key,
  ip_encrypted text not null,
  request_method text not null,
  request_path text not null,
  route_key text not null,
  traffic_scope text not null
    check (traffic_scope in ('page', 'api_read', 'api_mutation', 'auth', 'other')),
  signature_hash text not null,
  block_reason text not null,
  hit_count integer not null default 0,
  duplicate_hits integer not null default 0,
  route_hits integer not null default 0,
  scope_hits integer not null default 0,
  site_hits integer not null default 0,
  threshold integer not null default 0,
  window_seconds integer not null default 60,
  blocked_until timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_flowsecure_rate_limit_blocks_until
on public.flowsecure_rate_limit_blocks (blocked_until desc);

alter table public.flowsecure_rate_limit_hits enable row level security;
alter table public.flowsecure_rate_limit_blocks enable row level security;

drop policy if exists "service_role_all_flowsecure_rate_limit_hits"
on public.flowsecure_rate_limit_hits;

create policy "service_role_all_flowsecure_rate_limit_hits"
on public.flowsecure_rate_limit_hits
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_flowsecure_rate_limit_blocks"
on public.flowsecure_rate_limit_blocks;

create policy "service_role_all_flowsecure_rate_limit_blocks"
on public.flowsecure_rate_limit_blocks
for all
to service_role
using (true)
with check (true);

create or replace function public.apply_flowsecure_rate_limit(
  p_request_id text,
  p_ip_fingerprint text,
  p_ip_encrypted text,
  p_request_method text,
  p_request_path text,
  p_route_key text,
  p_traffic_scope text,
  p_signature_hash text,
  p_signature_kind text,
  p_user_agent text default null,
  p_window_seconds integer default 60,
  p_penalty_seconds integer default 60,
  p_duplicate_threshold integer default 8,
  p_scope_threshold integer default 40,
  p_site_threshold integer default 160,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_window_seconds integer := greatest(1, coalesce(p_window_seconds, 60));
  v_penalty_seconds integer := greatest(1, coalesce(p_penalty_seconds, 60));
  v_duplicate_threshold integer := greatest(1, coalesce(p_duplicate_threshold, 8));
  v_scope_threshold integer := greatest(1, coalesce(p_scope_threshold, 40));
  v_site_threshold integer := greatest(1, coalesce(p_site_threshold, 160));
  v_window_start timestamptz := v_now - make_interval(secs => v_window_seconds);
  v_traffic_scope text := case
    when p_traffic_scope in ('page', 'api_read', 'api_mutation', 'auth', 'other')
      then p_traffic_scope
    else 'other'
  end;
  v_signature_kind text := case
    when p_signature_kind in ('page', 'query', 'json', 'urlencoded', 'opaque')
      then p_signature_kind
    else 'opaque'
  end;
  v_existing_block public.flowsecure_rate_limit_blocks%rowtype;
  v_hit_id bigint;
  v_duplicate_hits integer := 0;
  v_route_hits integer := 0;
  v_scope_hits integer := 0;
  v_site_hits integer := 0;
  v_reason text := null;
  v_blocked_until timestamptz := null;
  v_retry_after_seconds integer := 0;
begin
  if coalesce(btrim(p_ip_fingerprint), '') = '' or coalesce(btrim(p_ip_encrypted), '') = '' then
    return jsonb_build_object(
      'allowed', true,
      'blocked', false,
      'retry_after_seconds', 0,
      'block_reason', null,
      'duplicate_hits', 0,
      'route_hits', 0,
      'scope_hits', 0,
      'site_hits', 0,
      'blocked_until', null
    );
  end if;

  if random() < 0.01 then
    delete from public.flowsecure_rate_limit_hits
    where created_at < v_now - interval '2 days';

    delete from public.flowsecure_rate_limit_blocks
    where blocked_until <= v_now - interval '1 day';
  end if;

  select *
  into v_existing_block
  from public.flowsecure_rate_limit_blocks
  where ip_fingerprint = p_ip_fingerprint
    and blocked_until > v_now
  limit 1
  for update;

  if found then
    v_retry_after_seconds := greatest(
      1,
      ceil(extract(epoch from (v_existing_block.blocked_until - v_now)))::integer
    );

    insert into public.flowsecure_rate_limit_hits (
      request_id,
      ip_fingerprint,
      ip_encrypted,
      request_method,
      request_path,
      route_key,
      traffic_scope,
      signature_hash,
      signature_kind,
      user_agent,
      metadata,
      blocked,
      blocked_reason,
      blocked_until
    )
    values (
      coalesce(nullif(btrim(p_request_id), ''), gen_random_uuid()::text),
      p_ip_fingerprint,
      p_ip_encrypted,
      coalesce(nullif(btrim(p_request_method), ''), 'GET'),
      coalesce(nullif(btrim(p_request_path), ''), '/'),
      coalesce(nullif(btrim(p_route_key), ''), 'GET:/'),
      v_traffic_scope,
      coalesce(nullif(btrim(p_signature_hash), ''), 'missing'),
      v_signature_kind,
      nullif(btrim(p_user_agent), ''),
      coalesce(p_metadata, '{}'::jsonb),
      true,
      coalesce(v_existing_block.block_reason, 'active_block'),
      v_existing_block.blocked_until
    );

    return jsonb_build_object(
      'allowed', false,
      'blocked', true,
      'retry_after_seconds', v_retry_after_seconds,
      'block_reason', coalesce(v_existing_block.block_reason, 'active_block'),
      'duplicate_hits', v_existing_block.duplicate_hits,
      'route_hits', v_existing_block.route_hits,
      'scope_hits', v_existing_block.scope_hits,
      'site_hits', v_existing_block.site_hits,
      'blocked_until', v_existing_block.blocked_until
    );
  end if;

  insert into public.flowsecure_rate_limit_hits (
    request_id,
    ip_fingerprint,
    ip_encrypted,
    request_method,
    request_path,
    route_key,
    traffic_scope,
    signature_hash,
    signature_kind,
    user_agent,
    metadata
  )
  values (
    coalesce(nullif(btrim(p_request_id), ''), gen_random_uuid()::text),
    p_ip_fingerprint,
    p_ip_encrypted,
    coalesce(nullif(btrim(p_request_method), ''), 'GET'),
    coalesce(nullif(btrim(p_request_path), ''), '/'),
    coalesce(nullif(btrim(p_route_key), ''), 'GET:/'),
    v_traffic_scope,
    coalesce(nullif(btrim(p_signature_hash), ''), 'missing'),
    v_signature_kind,
    nullif(btrim(p_user_agent), ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_hit_id;

  select count(*)::integer
  into v_duplicate_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and signature_hash = coalesce(nullif(btrim(p_signature_hash), ''), 'missing')
    and created_at >= v_window_start;

  select count(*)::integer
  into v_route_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and route_key = coalesce(nullif(btrim(p_route_key), ''), 'GET:/')
    and created_at >= v_window_start;

  select count(*)::integer
  into v_scope_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and traffic_scope = v_traffic_scope
    and created_at >= v_window_start;

  select count(*)::integer
  into v_site_hits
  from public.flowsecure_rate_limit_hits
  where ip_fingerprint = p_ip_fingerprint
    and created_at >= v_window_start;

  if v_traffic_scope = 'page' and v_route_hits >= v_duplicate_threshold then
    v_reason := 'page_reload_burst';
  elsif v_duplicate_hits >= v_duplicate_threshold then
    v_reason := 'duplicate_signature';
  elsif v_scope_hits >= v_scope_threshold then
    v_reason := 'scope_burst';
  elsif v_site_hits >= v_site_threshold then
    v_reason := 'site_burst';
  end if;

  if v_reason is not null then
    v_blocked_until := v_now + make_interval(secs => v_penalty_seconds);
    v_retry_after_seconds := greatest(
      1,
      ceil(extract(epoch from (v_blocked_until - v_now)))::integer
    );

    update public.flowsecure_rate_limit_hits
    set
      blocked = true,
      blocked_reason = v_reason,
      blocked_until = v_blocked_until
    where id = v_hit_id;

    insert into public.flowsecure_rate_limit_blocks (
      ip_fingerprint,
      ip_encrypted,
      request_method,
      request_path,
      route_key,
      traffic_scope,
      signature_hash,
      block_reason,
      hit_count,
      duplicate_hits,
      route_hits,
      scope_hits,
      site_hits,
      threshold,
      window_seconds,
      blocked_until,
      metadata,
      updated_at
    )
    values (
      p_ip_fingerprint,
      p_ip_encrypted,
      coalesce(nullif(btrim(p_request_method), ''), 'GET'),
      coalesce(nullif(btrim(p_request_path), ''), '/'),
      coalesce(nullif(btrim(p_route_key), ''), 'GET:/'),
      v_traffic_scope,
      coalesce(nullif(btrim(p_signature_hash), ''), 'missing'),
      v_reason,
      greatest(v_duplicate_hits, v_route_hits, v_scope_hits, v_site_hits),
      v_duplicate_hits,
      v_route_hits,
      v_scope_hits,
      v_site_hits,
      case
        when v_reason = 'duplicate_signature' then v_duplicate_threshold
        when v_reason = 'page_reload_burst' then v_duplicate_threshold
        when v_reason = 'scope_burst' then v_scope_threshold
        else v_site_threshold
      end,
      v_window_seconds,
      v_blocked_until,
      coalesce(p_metadata, '{}'::jsonb),
      v_now
    )
    on conflict (ip_fingerprint) do update
    set
      ip_encrypted = excluded.ip_encrypted,
      request_method = excluded.request_method,
      request_path = excluded.request_path,
      route_key = excluded.route_key,
      traffic_scope = excluded.traffic_scope,
      signature_hash = excluded.signature_hash,
      block_reason = excluded.block_reason,
      hit_count = excluded.hit_count,
      duplicate_hits = excluded.duplicate_hits,
      route_hits = excluded.route_hits,
      scope_hits = excluded.scope_hits,
      site_hits = excluded.site_hits,
      threshold = excluded.threshold,
      window_seconds = excluded.window_seconds,
      blocked_until = excluded.blocked_until,
      metadata = excluded.metadata,
      updated_at = v_now;

    return jsonb_build_object(
      'allowed', false,
      'blocked', true,
      'retry_after_seconds', v_retry_after_seconds,
      'block_reason', v_reason,
      'duplicate_hits', v_duplicate_hits,
      'route_hits', v_route_hits,
      'scope_hits', v_scope_hits,
      'site_hits', v_site_hits,
      'blocked_until', v_blocked_until
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'blocked', false,
    'retry_after_seconds', 0,
    'block_reason', null,
    'duplicate_hits', v_duplicate_hits,
    'route_hits', v_route_hits,
    'scope_hits', v_scope_hits,
    'site_hits', v_site_hits,
    'blocked_until', null
  );
end;
$$;

revoke all on function public.apply_flowsecure_rate_limit(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  integer,
  jsonb
) from public, anon, authenticated;

grant execute on function public.apply_flowsecure_rate_limit(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  integer,
  jsonb
) to service_role;
