# Tutorial: Configurando a API da OpenProvider

Para que o sistema de busca de domínios funcione, você precisa configurar suas credenciais da OpenProvider no arquivo `.env`.

## Passo 1: Criar uma conta na OpenProvider
1. Acesse [OpenProvider](https://www.openprovider.com/) e crie uma conta (RCP - Reseller Control Panel).
2. Note que a OpenProvider é focada em revendedores, então você precisará preencher os dados de empresa/profissional.

## Passo 2: Gerar credenciais de API
A OpenProvider utiliza o seu **Nome de Usuário** e **Senha** da conta para autenticação na API REST.

1. Faça login no seu painel da OpenProvider.
2. Certifique-se de que o acesso via API está habilitado em sua conta.
3. Vá em **Account** > **Settings** > **API settings**.
4. Lá você pode restringir os IPs que podem acessar a API (recomendado colocar o IP do seu servidor de produção).

## Passo 3: Configurar o arquivo .env
No diretório `site/`, abra o arquivo `.env` e adicione as seguintes linhas:

```env
# Credentials for Domain Search (OpenProvider)
OPENPROVIDER_USERNAME=seu_usuario_aqui
OPENPROVIDER_PASSWORD=sua_senha_aqui
```

> [!IMPORTANT]
> Se você estiver em ambiente de testes, a OpenProvider possui um ambiente de "Sandbox" (CTE). Caso queira usar o Sandbox, a URL no arquivo `site/app/api/domains/check/route.ts` deve ser alterada de `api.openprovider.eu` para `api.test.openprovider.eu`.

## Passo 4: Reiniciar o Servidor
Após salvar o arquivo `.env`, reinicie seu servidor de desenvolvimento para que as mudanças façam efeito:
```bash
npm run dev
```
