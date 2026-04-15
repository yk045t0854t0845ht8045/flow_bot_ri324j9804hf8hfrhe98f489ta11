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

# Configuracoes de resiliencia
OPENPROVIDER_TIMEOUT_MS=12000
OPENPROVIDER_MAX_RETRIES=3
OPENPROVIDER_RETRY_BASE_DELAY_MS=1000
OPENPROVIDER_CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
OPENPROVIDER_CIRCUIT_BREAKER_RECOVERY_TIMEOUT_MS=60000

# Configuracoes de performance
OPENPROVIDER_BATCH_SIZE=12
OPENPROVIDER_BATCH_CONCURRENCY=2
OPENPROVIDER_PRICE_CONCURRENCY=4
OPENPROVIDER_MAX_TLDS=24
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

1. **Autenticação robusta**: Autentica na Openprovider com retry controlado e cache de token.
2. **Retry automático com backoff exponencial**: Tenta novamente automaticamente em caso de falhas temporárias (timeouts, 5xx, rate limits).
3. **Circuit breaker**: Protege contra sobrecarga quando a API está instável, evitando cascata de falhas.
4. **Consulta otimizada**: Consulta a disponibilidade do dominio com `domains/check` em lotes para melhor performance.
5. **Fallback de preços**: Se o preço vier vazio para um dominio livre, busca fallback em `domains/prices`.
6. **Resiliência a falhas parciais**: Se uma consulta em lote falhar, tenta consultas individuais como fallback.
7. **Ordenação inteligente**: Ordena a lista com o dominio exato primeiro, depois disponibilidade e prioridade de TLD.
8. **Health check**: Endpoint `/api/domains/health` para monitorar o status do sistema.
9. **Rate limiting**: Controle de taxa de requisições por IP para evitar abuso.
10. **UI de manutenção**: Quando o sistema está indisponível, mostra interface dedicada de manutenção em vez de botões desabilitados.
11. **Tratamento de erro detalhado**: Mensagens claras quando o problema é credencial, timeout, manutenção ou configuração.
12. **Logs estruturados**: Logs com IDs de requisição para rastreamento e debugging.

## Monitoramento

- **Health check**: `GET /api/domains/health` - Verifica conectividade e status do circuit breaker
- **Circuit breaker status**: Disponível no health check e em respostas de erro
- **Métricas de retry**: Contador de tentativas incluído em logs e respostas de erro
- **Logs de performance**: Tempo de resposta e status de cache em logs

## Validacao manual recomendada

1. Rode `npm --prefix site run dev`.
2. Abra `/domains`.
3. Teste um nome base, por exemplo `flowdesk`.
4. Teste um dominio completo, por exemplo `flowdesk.com.br`.
5. Se houver falha de autenticacao, revise a whitelist de IP antes de trocar o codigo.
