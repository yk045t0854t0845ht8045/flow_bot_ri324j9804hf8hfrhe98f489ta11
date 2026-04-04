create table if not exists public.auth_security_events (
  id bigint generated always as identity primary key,
  request_id text not null,
  session_id uuid references public.auth_sessions(id) on delete set null,
  user_id bigint references public.auth_users(id) on delete set null,
  guild_id text,
  action text not null,
  outcome text not null
    check (outcome in ('started', 'succeeded', 'failed', 'blocked')),
  request_method text not null,
  request_path text not null,
  ip_fingerprint text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_security_events_request_id
on public.auth_security_events (request_id);

create index if not exists idx_auth_security_events_action_created_at
on public.auth_security_events (action, created_at desc);

create index if not exists idx_auth_security_events_session_action_created_at
on public.auth_security_events (session_id, action, created_at desc);

create index if not exists idx_auth_security_events_user_action_created_at
on public.auth_security_events (user_id, action, created_at desc);

create index if not exists idx_auth_security_events_ip_action_created_at
on public.auth_security_events (ip_fingerprint, action, created_at desc);
