create table if not exists public.auth_user_hidden_payment_methods (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  method_id text not null,
  deleted_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_hidden_payment_methods_unique unique (user_id, method_id)
);

create index if not exists idx_auth_user_hidden_payment_methods_user_id
on public.auth_user_hidden_payment_methods (user_id);

create index if not exists idx_auth_user_hidden_payment_methods_method_id
on public.auth_user_hidden_payment_methods (method_id);

drop trigger if exists tr_auth_user_hidden_payment_methods_updated_at on public.auth_user_hidden_payment_methods;
create trigger tr_auth_user_hidden_payment_methods_updated_at
before update on public.auth_user_hidden_payment_methods
for each row
execute function public.set_updated_at();

