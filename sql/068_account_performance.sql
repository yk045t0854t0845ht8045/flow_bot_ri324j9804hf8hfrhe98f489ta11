-- Índices de Performance: Seção de Conta (Accounts)
-- Otimizações para histórico, métodos de pagamento e resumo

-- Acelera o carregamento do histórico de pagamentos ordenado por data
create index if not exists idx_payment_orders_user_id_created_at_desc
on public.payment_orders (user_id, created_at desc);

-- Acelera a busca de eventos vinculados a ordens de pagamento (Timeline/Labels)
create index if not exists idx_payment_order_events_order_id
on public.payment_order_events (payment_order_id);

-- Acelera o carregamento de cartões e métodos de pagamento salvos
create index if not exists idx_auth_user_payment_methods_user_id_active
on public.auth_user_payment_methods (user_id) where is_active = true;

-- Acelera a verificação de métodos ocultos pelo usuário
create index if not exists idx_auth_user_hidden_methods_user_id
on public.auth_user_hidden_payment_methods (user_id);

-- Acelera a contagem de faturas e resumo da conta
create index if not exists idx_payment_orders_user_id_summary
on public.payment_orders (user_id);
