-- Migration to add dedicated AI settings columns to guild_ticket_settings with NOT NULL constraints
ALTER TABLE public.guild_ticket_settings 
ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS ai_company_name TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS ai_company_bio TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS ai_rules TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS ai_tone TEXT NOT NULL DEFAULT 'formal';

COMMENT ON COLUMN public.guild_ticket_settings.ai_enabled IS 'Indica se o modulo FlowAI esta ativo.';
COMMENT ON COLUMN public.guild_ticket_settings.ai_company_name IS 'Nome da empresa para identidade da IA.';
COMMENT ON COLUMN public.guild_ticket_settings.ai_company_bio IS 'Descricao do negocio para contexto da IA.';
COMMENT ON COLUMN public.guild_ticket_settings.ai_rules IS 'Diretrizes e regras personalizadas para sugestoes da IA.';
COMMENT ON COLUMN public.guild_ticket_settings.ai_tone IS 'Tom de voz da IA (formal, amigavel).';
