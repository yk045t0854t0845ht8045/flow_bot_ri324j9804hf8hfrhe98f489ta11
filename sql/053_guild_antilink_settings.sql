create table if not exists public.guild_antilink_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  log_channel_id text null,
  enforcement_action text not null default 'delete_only',
  timeout_minutes integer not null default 10,
  ignored_role_ids text[] not null default '{}'::text[],
  block_external_links boolean not null default true,
  block_discord_invites boolean not null default true,
  block_obfuscated_links boolean not null default true,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_antilink_settings_action_check
    check (enforcement_action in ('delete_only', 'timeout', 'kick', 'ban')),
  constraint guild_antilink_settings_timeout_check
    check (timeout_minutes between 1 and 10080)
);

drop trigger if exists tr_guild_antilink_settings_updated_at on public.guild_antilink_settings;
create trigger tr_guild_antilink_settings_updated_at
before update on public.guild_antilink_settings
for each row
execute function public.set_updated_at();
