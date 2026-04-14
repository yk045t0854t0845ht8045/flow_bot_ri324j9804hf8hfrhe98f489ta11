-- Migration to add ai_rules column to guild_ticket_settings
ALTER TABLE public.guild_ticket_settings 
ADD COLUMN IF NOT EXISTS ai_rules TEXT;

-- Update select permissions if necessary (usually handled by existing RLS or service role)
COMMENT ON COLUMN public.guild_ticket_settings.ai_rules IS 'Regras de atendimento para o sistema de sugestão por IA antes de abrir o ticket.';
