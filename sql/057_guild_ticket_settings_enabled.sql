alter table public.guild_ticket_settings
add column if not exists enabled boolean not null default false;
