# Flowdesk Ticket Bot (Discord)

Bot de ticket premium com:

- Components V2 (visual moderno, sem embed antigo)
- Painel com botao `Abrir ticket`
- Canal privado automatico com nome organizado
- Botao e comando para `assumir` e `fechar`
- Logs profissionais no canal de log
- Transcript HTML ao fechar ticket
- Protecao anti-abuso (limite de ticket aberto + cooldown)
- Persistencia completa no Supabase (protocolo, staff que assumiu, staff que fechou)

## 1) Configuracao

1. Copie `.env.example` para `.env`.
2. Preencha todos os IDs e chaves.
3. No Supabase SQL Editor, execute os arquivos na ordem:
   1. `sql/001_tickets.sql`
   2. `sql/002_ticket_events.sql`
   3. `sql/003_rls.sql`

## 2) Instalar e rodar

```bash
npm install
npm run deploy:commands
npm start
```

- `npm start` continua sendo o comando para executar o bot localmente.
- `npm run bot` publica o bot no GitHub sem incluir `site/`, `tmp/` nem `.env`.

## 3) Comandos

- `/ticket-painel` publica o painel de abertura.
- `/assumir` marca staff responsavel no ticket atual.
- `/fechar` fecha ticket, gera transcript HTML e envia no log.

## 4) Permissoes recomendadas para o bot

- `Manage Channels`
- `Send Messages`
- `Read Message History`
- `Attach Files`
- `Embed Links`
- `Manage Messages`

## 5) Observacoes importantes

- Use `SUPABASE_SERVICE_ROLE_KEY` no `.env` (nao use anon key).
- `TICKET_CATEGORY_ID` precisa apontar para uma categoria existente.
- `TICKET_SUPPORT_ROLE_ID` precisa ser o cargo da equipe de suporte.

## 6) Site Next.js integrado

- O site foi criado em `site/` com App Router.
- Estrutura separada com `site/components`, `site/app/api` e `site/public/cdn`.
- Para publicar o site no GitHub com commit/push automatico:

```bash
npm run site
```

- O script usa por padrao:
  - `SITE_GITHUB_REMOTE` (url do repositorio)
  - `SITE_COMMIT_MESSAGE` (opcional para mensagem fixa)
  - `SITE_GIT_NAME` e `SITE_GIT_EMAIL` (identidade de commit no repo `/site`)

## 7) Publicar o bot no GitHub

Para publicar somente o bot da raiz `flowdesk` no repositorio separado:

```bash
npm run bot
```

- O script ignora `site/`, `tmp/` e `.env` automaticamente.
- O repositorio remoto padrao do bot e:
  - `https://github.com/yk045t0854t0845ht8045/flow_bot_ri324j9804hf8hfrhe98f489ta11.git`
- Variaveis opcionais do publish:
  - `BOT_GITHUB_REMOTE`
  - `BOT_COMMIT_MESSAGE`
  - `BOT_GIT_NAME`
  - `BOT_GIT_EMAIL`
