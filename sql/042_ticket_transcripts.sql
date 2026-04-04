create table if not exists public.ticket_transcripts (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.tickets(id) on delete cascade,
  protocol text not null unique,
  guild_id text not null,
  channel_id text not null,
  user_id text not null,
  closed_by text not null,
  transcript_html text not null,
  access_code_hash text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_ticket_transcripts_ticket_id_unique
on public.ticket_transcripts (ticket_id);

create index if not exists idx_ticket_transcripts_protocol
on public.ticket_transcripts (protocol);

create index if not exists idx_ticket_transcripts_user_id
on public.ticket_transcripts (user_id);

drop trigger if exists tr_ticket_transcripts_updated_at on public.ticket_transcripts;
create trigger tr_ticket_transcripts_updated_at
before update on public.ticket_transcripts
for each row
execute function public.set_updated_at();
