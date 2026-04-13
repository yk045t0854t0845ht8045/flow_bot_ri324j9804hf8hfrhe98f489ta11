-- Script para gerar uma violação de teste de 3 meses para validação da interface
-- Aplica-se ao primeiro usuário encontrado no banco de dados para fins de teste.

INSERT INTO public.account_violations (user_id, type, category_id, reason, expires_at)
SELECT 
  id, 
  'Uso indevido de API ou automação', 
  'uso_indevido_api', 
  'Detecção de múltiplas requisições simultâneas em padrões não humanos através de integração externa não autorizada.', 
  timezone('utc', now() + interval '3 months')
FROM public.auth_users
LIMIT 1;
