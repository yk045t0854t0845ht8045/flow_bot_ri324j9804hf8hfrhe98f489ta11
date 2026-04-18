alter table public.auth_users
  add column if not exists microsoft_user_id text;

create unique index if not exists idx_auth_users_microsoft_user_id_unique
on public.auth_users (microsoft_user_id)
where microsoft_user_id is not null;
