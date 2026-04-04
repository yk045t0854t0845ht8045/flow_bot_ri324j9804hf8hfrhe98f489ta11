alter table public.auth_user_teams
add column if not exists icon_key text not null default 'aurora';
