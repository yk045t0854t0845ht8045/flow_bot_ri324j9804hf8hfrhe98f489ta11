create table if not exists public.guild_welcome_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  entry_public_channel_id text null,
  entry_log_channel_id text null,
  exit_public_channel_id text null,
  exit_log_channel_id text null,
  entry_layout jsonb not null default '[]'::jsonb,
  exit_layout jsonb not null default '[]'::jsonb,
  entry_thumbnail_mode text not null default 'custom',
  exit_thumbnail_mode text not null default 'custom',
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_guild_welcome_settings_updated_at on public.guild_welcome_settings;
create trigger tr_guild_welcome_settings_updated_at
before update on public.guild_welcome_settings
for each row
execute function public.set_updated_at();
