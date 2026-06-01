begin;

create table if not exists public.hosting_vps_flow_chats (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  title text not null default 'Novo chat',
  model text not null default 'gpt-4o-mini',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_flow_chats_project_user_updated
on public.hosting_vps_flow_chats (hosting_project_id, user_id, updated_at desc);

create table if not exists public.hosting_vps_flow_chat_messages (
  id bigint generated always as identity primary key,
  chat_id bigint not null references public.hosting_vps_flow_chats(id) on delete cascade,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  model text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_flow_chat_messages_chat_created
on public.hosting_vps_flow_chat_messages (chat_id, created_at asc);

drop trigger if exists tr_hosting_vps_flow_chats_updated_at on public.hosting_vps_flow_chats;
create trigger tr_hosting_vps_flow_chats_updated_at
before update on public.hosting_vps_flow_chats
for each row execute function public.set_updated_at();

alter table public.hosting_vps_flow_chats enable row level security;
alter table public.hosting_vps_flow_chat_messages enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_vps_flow_chats_service_role_all on public.hosting_vps_flow_chats;
    create policy hosting_vps_flow_chats_service_role_all
      on public.hosting_vps_flow_chats for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_flow_chat_messages_service_role_all on public.hosting_vps_flow_chat_messages;
    create policy hosting_vps_flow_chat_messages_service_role_all
      on public.hosting_vps_flow_chat_messages for all to service_role
      using (true) with check (true);
  end if;
end
$$;

commit;
