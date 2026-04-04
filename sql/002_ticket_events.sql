create type public.ticket_event_type as enum ('created', 'claimed', 'closed');

create table if not exists public.ticket_events (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.tickets(id) on delete cascade,
  protocol text not null,
  guild_id text not null,
  channel_id text not null,
  actor_id text not null,
  event_type public.ticket_event_type not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_ticket_events_ticket_id
on public.ticket_events (ticket_id);

create index if not exists idx_ticket_events_protocol
on public.ticket_events (protocol);

create index if not exists idx_ticket_events_created_at
on public.ticket_events (created_at desc);
