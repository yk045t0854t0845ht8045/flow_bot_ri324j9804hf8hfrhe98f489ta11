-- Migration 081: Tabela de lock diário de incidentes
-- Garante que o sistema nunca crie mais de 1 incidente por dia.
-- A lógica da aplicação consulta esta tabela antes de qualquer insert.

begin;

create table if not exists public.system_incident_daily_lock (
  id          bigint generated always as identity primary key,
  day_key     date        not null,          -- ex: '2026-04-16'
  incident_id uuid        not null,          -- FK para o incidente do dia
  created_at  timestamptz not null default timezone('utc', now()),
  updated_at  timestamptz not null default timezone('utc', now()),

  -- Garante unicidade: apenas 1 registro por dia, no nível do banco
  constraint system_incident_daily_lock_day_key_unique unique (day_key)
);

-- FK para o incidente (não cascade delete — queremos manter o lock mesmo se o incidente sumir)
alter table public.system_incident_daily_lock
  add constraint fk_incident_daily_lock_incident
  foreign key (incident_id)
  references public.system_incidents (id)
  on delete set null
  deferrable initially deferred;

-- Permite que incident_id seja null (para o caso de o incidente ter sido deletado)
alter table public.system_incident_daily_lock
  alter column incident_id drop not null;

-- Índice para busca rápida por data
create index if not exists idx_incident_daily_lock_day_key
  on public.system_incident_daily_lock (day_key desc);

-- RLS: apenas service_role pode ler/escrever
alter table public.system_incident_daily_lock enable row level security;

drop policy if exists "service_role_all" on public.system_incident_daily_lock;
create policy "service_role_all"
  on public.system_incident_daily_lock
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

commit;
