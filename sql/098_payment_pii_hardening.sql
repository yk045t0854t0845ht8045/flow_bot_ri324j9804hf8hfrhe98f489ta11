alter table public.payment_orders
add column if not exists payer_document_encrypted text,
add column if not exists payer_document_last4 text;

alter table public.auth_user_payment_method_verifications
add column if not exists payer_document_encrypted text,
add column if not exists payer_document_last4 text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payment_orders_payer_document_last4_check'
      and conrelid = 'public.payment_orders'::regclass
  ) then
    alter table public.payment_orders
      add constraint payment_orders_payer_document_last4_check
      check (
        payer_document_last4 is null
        or payer_document_last4 ~ '^[0-9]{1,4}$'
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'auth_user_payment_method_verifications_payer_document_last4_check'
      and conrelid = 'public.auth_user_payment_method_verifications'::regclass
  ) then
    alter table public.auth_user_payment_method_verifications
      add constraint auth_user_payment_method_verifications_payer_document_last4_check
      check (
        payer_document_last4 is null
        or payer_document_last4 ~ '^[0-9]{1,4}$'
      );
  end if;
end $$;

update public.payment_orders
set payer_document_last4 = right(
  regexp_replace(coalesce(payer_document, ''), '\D', '', 'g'),
  4
)
where payer_document_last4 is null
  and nullif(regexp_replace(coalesce(payer_document, ''), '\D', '', 'g'), '') is not null;

update public.auth_user_payment_method_verifications
set payer_document_last4 = right(
  regexp_replace(coalesce(payer_document, ''), '\D', '', 'g'),
  4
)
where payer_document_last4 is null
  and nullif(regexp_replace(coalesce(payer_document, ''), '\D', '', 'g'), '') is not null;
