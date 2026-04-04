alter table public.guild_ticket_settings
add column if not exists panel_layout jsonb not null default '[]'::jsonb;
