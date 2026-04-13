-- Índices de Performance: Dashboard de Servidores (Versão Corrigida)

-- Otimizar busca de histórico de pagamentos por usuário (Fundamental para carregar licenças rapidamente)
-- Acelera a função reconcileRecentPaymentOrders e getLockedGuildLicenseMapByUserId
create index if not exists idx_payment_orders_user_id_status_v2
on public.payment_orders (user_id, status);

create index if not exists idx_payment_orders_user_id_approved_guild_id_v2
on public.payment_orders (user_id, guild_id)
where status = 'approved' and guild_id is not null;

-- Otimizar busca de servidores vinculados ao plano do usuário
create index if not exists idx_auth_user_plan_guilds_user_id_v2
on public.auth_user_plan_guilds (user_id);

-- Otimizar validação de sessão e expiração (Acelera o login e reconhecimento do usuário)
create index if not exists idx_auth_sessions_user_id_expires_at_v2
on public.auth_sessions (user_id, expires_at desc);

-- Nota: O índice para auth_user_teams (owner_user_id) já existe no sistema base (idx_auth_user_teams_owner_user_id),
-- por isso foi removido desta lista para evitar erros de redundância.
