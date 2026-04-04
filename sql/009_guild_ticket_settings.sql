create table if not exists public.guild_ticket_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  menu_channel_id text not null,
  tickets_category_id text not null,
  logs_created_channel_id text not null,
  logs_closed_channel_id text not null,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_guild_ticket_settings_updated_at on public.guild_ticket_settings;
create trigger tr_guild_ticket_settings_updated_at
before update on public.guild_ticket_settings
for each row
execute function public.set_updated_at();
