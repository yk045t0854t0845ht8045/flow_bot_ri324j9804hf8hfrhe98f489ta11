# Openprovider - checklist de configuracao

Este projeto consulta dominios pela API REST oficial da Openprovider.

## Variaveis obrigatorias

No arquivo `site/.env`, configure:

```env
OPENPROVIDER_BASE_URL=https://api.openprovider.eu/v1beta
OPENPROVIDER_TIMEOUT_MS=12000
OPENPROVIDER_USERNAME=seu-usuario
OPENPROVIDER_PASSWORD=sua-senha
```

## Variaveis opcionais recomendadas

```env
# Se sua conta restringe chamadas por IP, informe o IP liberado.
OPENPROVIDER_IP=0.0.0.0

# Ordem de extensoes consultadas na vitrine do /domains.
OPENPROVIDER_TLDS=com.br,com,ai,io,org,net
```

## Checklist rapido para nao dar Authentication/Authorization Failed

1. Confirme se `OPENPROVIDER_USERNAME` e `OPENPROVIDER_PASSWORD` estao corretos.
2. Verifique no painel da Openprovider se o acesso via API esta habilitado.
3. Se houver whitelist de IP, libere o IP do servidor onde o Next.js roda.
4. Se usar `OPENPROVIDER_IP`, envie exatamente o mesmo IP autorizado na conta.
5. Reinicie o servidor do site depois de mudar o `.env`.
6. Confirme que o ambiente esta apontando para o host certo:
   producao: `https://api.openprovider.eu/v1beta`
   sandbox: `https://api.test.openprovider.eu/v1beta`

## O que o sistema faz agora

1. Autentica na Openprovider com retry controlado.
2. Consulta a disponibilidade do dominio com `domains/check`.
3. Se o preco vier vazio para um dominio livre, busca fallback em `domains/prices`.
4. Ordena a lista com o dominio exato primeiro, depois disponibilidade e prioridade de TLD.
5. Retorna mensagens claras quando o problema e credencial, timeout, manutencao ou configuracao.

## Validacao manual recomendada

1. Rode `npm --prefix site run dev`.
2. Abra `/domains`.
3. Teste um nome base, por exemplo `flowdesk`.
4. Teste um dominio completo, por exemplo `flowdesk.com.br`.
5. Se houver falha de autenticacao, revise a whitelist de IP antes de trocar o codigo.
