alter table public.auth_user_payment_methods
add column if not exists provider_customer_id text,
add column if not exists provider_card_id text;

create index if not exists idx_auth_user_payment_methods_provider_customer_id
on public.auth_user_payment_methods (provider_customer_id)
where provider_customer_id is not null;

create unique index if not exists idx_auth_user_payment_methods_provider_card_id
on public.auth_user_payment_methods (provider_card_id)
where provider_card_id is not null;
