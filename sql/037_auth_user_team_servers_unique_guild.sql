do $$
begin
  if exists (
    select 1
    from public.auth_user_team_servers
    group by guild_id
    having count(*) > 1
  ) then
    raise exception 'Existem servidores vinculados a mais de uma equipe. Limpe os duplicados antes de aplicar a restricao unica por guild.';
  end if;
end $$;

create unique index if not exists idx_auth_user_team_servers_guild_id_unique
on public.auth_user_team_servers (guild_id);