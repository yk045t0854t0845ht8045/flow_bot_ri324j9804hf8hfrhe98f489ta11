alter table public.guild_security_logs_settings
add column if not exists enabled boolean not null default false,
add column if not exists use_default_channel boolean not null default false,
add column if not exists default_channel_id text null;

update public.guild_security_logs_settings
set enabled = true
where
  enabled = false
  and (
    nickname_change_enabled = true
    or avatar_change_enabled = true
    or voice_join_enabled = true
    or voice_leave_enabled = true
    or message_delete_enabled = true
    or message_edit_enabled = true
    or member_ban_enabled = true
    or member_unban_enabled = true
    or member_kick_enabled = true
    or member_timeout_enabled = true
    or voice_move_enabled = true
  );
