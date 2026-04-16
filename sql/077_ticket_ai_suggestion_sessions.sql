create table if not exists public.ticket_ai_suggestion_sessions (
  guild_id text not null,
  user_id text not null,
  reason text not null,
  suggestion text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (guild_id, user_id)
);

drop trigger if exists tr_ticket_ai_suggestion_sessions_updated_at on public.ticket_ai_suggestion_sessions;
create trigger tr_ticket_ai_suggestion_sessions_updated_at
before update on public.ticket_ai_suggestion_sessions
for each row
execute function public.set_updated_at();

create index if not exists idx_ticket_ai_suggestion_sessions_expires_at
on public.ticket_ai_suggestion_sessions (expires_at desc);

create index if not exists idx_ticket_ai_suggestion_sessions_active
on public.ticket_ai_suggestion_sessions (consumed_at, expires_at desc);
