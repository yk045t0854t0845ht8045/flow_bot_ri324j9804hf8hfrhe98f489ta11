create type public.ticket_status as enum ('open', 'closed');

create table if not exists public.tickets (
  id bigint generated always as identity primary key,
  protocol text not null unique,
  guild_id text not null,
  channel_id text not null unique,
  user_id text not null,
  status public.ticket_status not null default 'open',
  claimed_by text,
  claimed_at timestamptz,
  closed_by text,
  closed_at timestamptz,
  intro_message_id text,
  transcript_file text,
  opened_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_tickets_updated_at on public.tickets;
create trigger tr_tickets_updated_at
before update on public.tickets
for each row
execute function public.set_updated_at();

create index if not exists idx_tickets_guild_user_status
on public.tickets (guild_id, user_id, status);

create index if not exists idx_tickets_channel_status
on public.tickets (channel_id, status);

create index if not exists idx_tickets_opened_at
on public.tickets (opened_at desc);
