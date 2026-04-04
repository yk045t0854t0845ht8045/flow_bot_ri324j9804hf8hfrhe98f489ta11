alter table public.auth_sessions
add column if not exists active_guild_id text,
add column if not exists discord_guilds_cache jsonb,
add column if not exists discord_guilds_cached_at timestamptz;

create index if not exists idx_auth_sessions_active_guild_id
on public.auth_sessions (active_guild_id);

create index if not exists idx_auth_sessions_discord_guilds_cached_at
on public.auth_sessions (discord_guilds_cached_at);
