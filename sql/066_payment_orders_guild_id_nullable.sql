-- Torna a coluna guild_id opcional na tabela payment_orders
-- Isso permite a criacao de ordens de pagamento antes da selecao de um servidor especifico.

alter table public.payment_orders alter column guild_id drop not null;

-- Remove o check constraint que impedia valores nulos se existir (normalmente o NOT NULL ja e o suficiente)
-- Adicionado apenas por seguranca caso o Supabase tenha inferido algo extra.
