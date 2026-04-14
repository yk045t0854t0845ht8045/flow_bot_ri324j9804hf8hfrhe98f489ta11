-- Violation Definitions Table
create table if not exists public.violation_definitions (
  id text primary key, -- slug as ID for easier staff management
  name text not null,
  description text not null,
  rule_url text
);

-- Active Account Violations Table
-- Ensure the violations table exists
create table if not exists public.account_violations (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  type text not null,
  reason text,
  expires_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

-- Realtime Support
alter publication supabase_realtime add table account_violations;
alter table public.account_violations replica identity full;

-- IMPORTANT: Add category_id if it doesn't exist (Fixes the "column does not exist" error)
alter table public.account_violations add column if not exists category_id text references public.violation_definitions(id) on delete set null;

create index if not exists idx_account_violations_user_id
on public.account_violations (user_id);

create index if not exists idx_account_violations_category_id
on public.account_violations (category_id);

drop trigger if exists tr_account_violations_updated_at on public.account_violations;
create trigger tr_account_violations_updated_at
before update on public.account_violations
for each row
execute function public.set_updated_at();

-- RLS
alter table public.violation_definitions enable row level security;
alter table public.account_violations enable row level security;

drop policy if exists "Anyone can view violation definitions" on public.violation_definitions;
create policy "Anyone can view violation definitions"
  on public.violation_definitions for select using (true);

drop policy if exists "Users can view their own violations" on public.account_violations;
create policy "Users can view their own violations"
  on public.account_violations
  for select
  using (
    user_id = (
      select id from public.auth_users
      where discord_user_id = (auth.jwt() ->> 'sub')
      limit 1
    )
  );

-- Initial Data for Violation Definitions
insert into public.violation_definitions (id, name, description, rule_url)
values 
  ('fraude_pagamento', 'Fraude em Pagamentos', 'Atividades suspeitas ou fraudulentas detectadas no processamento de transações, incluindo o uso de métodos de pagamento não autorizados.', 'https://www.flwdesk.com/privacy'),
  ('fraude_estorno', 'Fraude em Pagamentos', 'Atividades suspeitas ou fraudulentas detectadas no processamento de transações, incluindo o uso de métodos de pagamento não autorizados.', 'https://www.flwdesk.com/privacy'),
  ('contestacao_indevida', 'Contestação Indevida de Cobrança', 'Abertura de disputas junto a operadoras de cartão para serviços que foram devidamente prestados.', 'https://www.flwdesk.com/privacy'),
  ('lavagem_transacoes', 'Lavagem de Transações', 'Uso da plataforma para movimentar fundos de origem duvidosa ou através de intermediários não autorizados.', 'https://www.flwdesk.com/privacy'),
  ('uso_indevido_pagamento', 'Uso Indevido de Métodos de Pagamento', 'Utilização de cartões ou contas de terceiros sem autorização explícita ou em desacordo com as regras do emissor.', 'https://www.flwdesk.com/privacy'),
  ('manipulacao_saldo', 'Manipulação de Saldo, Crédito ou Benefício', 'Tentativa de alterar artificialmente valores em conta, créditos promocionais ou benefícios da plataforma.', 'https://www.flwdesk.com/privacy'),
  ('abuso_estorno_automatico', 'Abuso de Estorno Automático', 'Exploração repetitiva de mecanismos de proteção ao consumidor para fins de enriquecimento ilícito.', 'https://www.flwdesk.com/privacy'),
  ('fraude_identidade', 'Fraude de Identidade', 'Uso de informações de identidade falsas ou roubadas para criar ou gerenciar contas.', 'https://www.flwdesk.com/privacy'),
  ('falsidade_ideologica', 'Falsidade Ideológica ou Documental', 'Apresentação de documentos forjados ou informações falsas durante processos de verificação.', 'https://www.flwdesk.com/privacy'),
  ('acesso_nao_autorizado', 'Acesso Não Autorizado', 'Tentativa de acessar contas ou dados de terceiros sem a devida permissão.', 'https://www.flwdesk.com/privacy'),
  ('compartilhamento_conta', 'Compartilhamento Indevido de Conta ou Credenciais', 'Cessão de acesso a terceiros em planos que exigem uso pessoal ou transferência de propriedade não autorizada.', 'https://www.flwdesk.com/privacy'),
  ('violacao_seguranca', 'Violação de Segurança', 'Ações que comprometem a integridade dos sistemas da Flowdesk ou de seus usuários.', 'https://www.flwdesk.com/privacy'),
  ('exploracao_bug', 'Exploração de Falha, Bug ou Vulnerabilidade', 'Uso intencional de falhas técnicas para obter vantagens competitivas ou financeiras em vez de reportá-las.', 'https://www.flwdesk.com/privacy'),
  ('uso_indevido_api', 'Uso Indevido de API, Bot ou Integração', 'Abuso de limites de requisição ou uso de ferramentas não autorizadas para interagir com a plataforma.', 'https://www.flwdesk.com/privacy'),
  ('automacao_abusiva', 'Automação Abusiva', 'Uso excessivo de scripts ou bots que prejudicam a performance dos servidores para outros usuários.', 'https://www.flwdesk.com/privacy'),
  ('spam_flood', 'Spam, Flood ou Abuso Operacional', 'Envio em massa de comunicações não solicitadas ou sobrecarga proposital de canais de suporte.', 'https://www.flwdesk.com/privacy'),
  ('burla_regras', 'Tentativa de Burla de Regras', 'Emprego de meios criativos para contornar restrições impostas por violações anteriores ou limites do plano.', 'https://www.flwdesk.com/privacy'),
  ('uso_indevido_recursos', 'Uso Indevido de Recursos da Plataforma', 'Utilização de ferramentas da plataforma para fins diferentes daqueles estabelecidos em contrato.', 'https://www.flwdesk.com/privacy'),
  ('descumprimento_politicas', 'Descumprimento de Políticas Internas', 'Violação sistemática de diretrizes operacionais e de conduta da Flowdesk.', 'https://www.flwdesk.com/privacy'),
  ('violacao_privacidade', 'Violação de Privacidade e Dados', 'Coleta, exposição ou uso indevido de dados sensíveis de outros usuários ou da própria plataforma.', 'https://www.flwdesk.com/privacy'),
  ('fraude_usuarios', 'Fraude Contra Usuários ou Clientes', 'Enganar outros membros da comunidade ou clientes finais através das ferramentas do sistema.', 'https://www.flwdesk.com/privacy'),
  ('abuso_autoridade', 'Abuso de Permissões ou Autoridade', 'Uso indevido de cargos de equipe ou permissões administrativas em servidores gerenciados.', 'https://www.flwdesk.com/privacy'),
  ('ameaca_intimidacao', 'Ameaça ou Intimidação', 'Comportamento hostil, ameaçador ou coercitivo contra membros da equipe ou comunidade.', 'https://www.flwdesk.com/privacy'),
  ('discriminacao_ofensiva', 'Discriminação ou Discurso Ofensivo', 'Uso de linguagem discriminatória, preconceituosa ou discurso de óido em qualquer canal da plataforma.', 'https://www.flwdesk.com/privacy'),
  ('conduta_inadequada', 'Conduta Abusiva ou Inadequada', 'Comportamento geral que fere a ética e o convívio saudável esperado na Flowdesk.', 'https://www.flwdesk.com/privacy')
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  rule_url = excluded.rule_url;
