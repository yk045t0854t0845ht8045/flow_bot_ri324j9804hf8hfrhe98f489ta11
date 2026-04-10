alter table public.guild_security_logs_settings
add column if not exists voice_mute_enabled boolean not null default false,
add column if not exists voice_mute_channel_id text null;

update public.guild_security_logs_settings
set
  voice_mute_enabled = true,
  voice_mute_channel_id = case
    when use_default_channel = true then voice_mute_channel_id
    else coalesce(voice_mute_channel_id, member_timeout_channel_id)
  end
where
  voice_mute_enabled = false
  and member_timeout_enabled = true;
