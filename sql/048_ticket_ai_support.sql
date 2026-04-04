create table if not exists public.ticket_ai_sessions (
  ticket_id bigint primary key references public.tickets(id) on delete cascade,
  protocol text not null,
  guild_id text not null,
  channel_id text not null,
  user_id text not null,
  status text not null default 'active',
  handoff_reason text null,
  handed_off_by text null,
  handed_off_at timestamptz null,
  last_ai_reply_at timestamptz null,
  last_user_message_at timestamptz null,
  last_staff_message_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint ticket_ai_sessions_status_check
    check (status in ('active', 'handoff', 'closed'))
);

drop trigger if exists tr_ticket_ai_sessions_updated_at on public.ticket_ai_sessions;
create trigger tr_ticket_ai_sessions_updated_at
before update on public.ticket_ai_sessions
for each row
execute function public.set_updated_at();

create index if not exists idx_ticket_ai_sessions_status
on public.ticket_ai_sessions (status, updated_at desc);

create table if not exists public.ticket_ai_messages (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.tickets(id) on delete cascade,
  protocol text not null,
  guild_id text not null,
  channel_id text not null,
  author_id text null,
  author_type text not null,
  source text not null default 'ticket_ai',
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint ticket_ai_messages_author_type_check
    check (author_type in ('user', 'assistant', 'staff', 'system'))
);

create index if not exists idx_ticket_ai_messages_ticket_id
on public.ticket_ai_messages (ticket_id, created_at desc);

create index if not exists idx_ticket_ai_messages_protocol
on public.ticket_ai_messages (protocol, created_at desc);
