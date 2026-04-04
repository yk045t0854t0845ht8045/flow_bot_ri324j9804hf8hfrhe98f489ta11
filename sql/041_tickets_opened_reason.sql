alter table public.tickets
add column if not exists opened_reason text not null default '';
