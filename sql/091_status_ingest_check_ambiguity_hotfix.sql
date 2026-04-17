-- Hotfix para ambientes onde o RPC public.system_status_ingest_check
-- foi criado com ON CONFLICT (component_id, recorded_at) dentro de uma
-- funcao RETURNS TABLE, o que torna "component_id" ambiguo no PL/pgSQL.

do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_old_fragment text := 'on conflict (component_id, recorded_at) do update';
  v_new_fragment text :=
    'on conflict on constraint system_status_history_component_id_recorded_at_key do update';
begin
  v_signature := to_regprocedure(
    'public.system_status_ingest_check(text,public.system_status_type,integer,text,integer,text,jsonb,timestamptz)'
  );

  if v_signature is null then
    raise notice 'system_status_ingest_check nao encontrada; hotfix ignorado.';
    return;
  end if;

  select pg_get_functiondef(v_signature)
  into v_definition;

  if v_definition is null then
    raise notice 'Nao foi possivel ler a definicao atual de system_status_ingest_check.';
    return;
  end if;

  if position(v_new_fragment in lower(v_definition)) > 0 then
    raise notice 'system_status_ingest_check ja esta com o hotfix aplicado.';
    return;
  end if;

  if position(v_old_fragment in lower(v_definition)) = 0 then
    raise notice 'Trecho legado nao encontrado; nenhuma alteracao aplicada em system_status_ingest_check.';
    return;
  end if;

  execute replace(v_definition, v_old_fragment, v_new_fragment);
  raise notice 'Hotfix aplicado em system_status_ingest_check.';
end
$$;
