-- Reforca o search_path das funcoes antigas do sistema de tarefas agendadas.
-- Isso corrige ambientes ja provisionados onde as funcoes podem ter ficado sem
-- search_path fixo mesmo apos recriacoes manuais.

alter function public.create_plan_expiry_task()
set search_path = pg_catalog, public;

alter function public.handle_plan_status_change()
set search_path = pg_catalog, public;
