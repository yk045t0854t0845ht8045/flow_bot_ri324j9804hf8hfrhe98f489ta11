alter table public.guild_ticket_settings
add column if not exists panel_title text not null default 'Abrir atendimento',
add column if not exists panel_description text not null default 'Escolha uma opcao abaixo para falar com a equipe responsavel.',
add column if not exists panel_button_label text not null default 'Abrir ticket';
