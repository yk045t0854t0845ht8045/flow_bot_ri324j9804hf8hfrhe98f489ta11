create table if not exists public.ticket_dm_queue (
  id bigint generated always as identity primary key,
  notification_key text not null unique,
  kind text not null,
  ticket_id bigint null references public.tickets(id) on delete cascade,
  protocol text not null,
  guild_id text not null,
  user_id text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 12,
  next_attempt_at timestamptz not null default timezone('utc', now()),
  last_error text null,
  dm_channel_id text null,
  delivered_message_id text null,
  sent_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_ticket_dm_queue_status_next_attempt
on public.ticket_dm_queue (status, next_attempt_at);

create index if not exists idx_ticket_dm_queue_user_id
on public.ticket_dm_queue (user_id);

create index if not exists idx_ticket_dm_queue_ticket_id
on public.ticket_dm_queue (ticket_id);

drop trigger if exists tr_ticket_dm_queue_updated_at on public.ticket_dm_queue;
create trigger tr_ticket_dm_queue_updated_at
before update on public.ticket_dm_queue
for each row
execute function public.set_updated_at();
