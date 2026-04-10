create table if not exists public.guild_security_logs_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  nickname_change_enabled boolean not null default false,
  nickname_change_channel_id text null,
  avatar_change_enabled boolean not null default false,
  avatar_change_channel_id text null,
  voice_join_enabled boolean not null default false,
  voice_join_channel_id text null,
  voice_leave_enabled boolean not null default false,
  voice_leave_channel_id text null,
  message_delete_enabled boolean not null default false,
  message_delete_channel_id text null,
  message_edit_enabled boolean not null default false,
  message_edit_channel_id text null,
  member_ban_enabled boolean not null default false,
  member_ban_channel_id text null,
  member_unban_enabled boolean not null default false,
  member_unban_channel_id text null,
  member_kick_enabled boolean not null default false,
  member_kick_channel_id text null,
  member_timeout_enabled boolean not null default false,
  member_timeout_channel_id text null,
  voice_move_enabled boolean not null default false,
  voice_move_channel_id text null,
  voice_mute_enabled boolean not null default false,
  voice_mute_channel_id text null,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_guild_security_logs_settings_updated_at on public.guild_security_logs_settings;
create trigger tr_guild_security_logs_settings_updated_at
before update on public.guild_security_logs_settings
for each row
execute function public.set_updated_at();
