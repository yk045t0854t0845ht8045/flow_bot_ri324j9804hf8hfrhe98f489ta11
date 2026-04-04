alter table public.auth_sessions
add column if not exists discord_access_token text,
add column if not exists discord_refresh_token text,
add column if not exists discord_token_expires_at timestamptz;

create index if not exists idx_auth_sessions_discord_token_expires_at
on public.auth_sessions (discord_token_expires_at);
