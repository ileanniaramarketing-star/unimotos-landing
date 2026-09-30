# Edge Function `send-lead`

Roda na infraestrutura do próprio Supabase. É acionada sozinha por um **Database Webhook** (ver
`supabase/migrations/0001_send_lead_webhook.sql`) assim que um lead é inserido em `public.leads` já
com `vendedor` preenchido e `status = 'pendente'`. O vendedor é decidido no Node (rodízio,
`scripts/lib/powercrm.js`) — esta função só cuida do envio de rede ao Power CRM, que é a parte que
podia ser cortada no meio numa hospedagem que encerra o processo logo depois de responder ao
navegador (foi o que aconteceu de verdade em produção, 2026-09-30).

## Configuração duplicada — atenção ao sincronizar

`POWERCRM_CONFIG` dentro de `index.ts` é uma cópia manual de `config/powercrm.json` (vendedor,
PowerLink, cidade, cooperativa). O Deno Deploy não lê arquivos do repositório Node em tempo de
execução, então **sempre que `config/powercrm.json` mudar** (novo vendedor, PowerLink trocado,
cidade/cooperativa de um produto), atualize a cópia aqui também e rode o deploy de novo.

## Function Secrets (nunca no código, nunca no Git)

| Nome | O que é | Onde também vive |
|---|---|---|
| `POWERCRM_TOKEN` | Token do Power CRM — quem manda de verdade agora é esta função, não mais o Node | Cofre local (`POWERCRM_TOKEN`) |
| `WEBHOOK_SHARED_SECRET` | Protege a função (publicada com `verify_jwt=false`) de ser chamada por qualquer um que descubra a URL | Cofre local, sob o nome `SUPABASE_WEBHOOK_SECRET` (mesmo valor) |

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são injetadas automaticamente pelo Supabase em toda
Edge Function — não precisam ser configuradas.

## Redeploy (quando mudar o código ou a config duplicada)

```bash
curl -X POST "https://api.supabase.com/v1/projects/hrxuvyhctuasuaxmhtny/functions/deploy?slug=send-lead" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -F "file=@supabase/functions/send-lead/index.ts;filename=index.ts" \
  -F 'metadata={"entrypoint_path":"index.ts","name":"send-lead","verify_jwt":false};type=application/json'
```

Trocar um Function Secret:

```bash
curl -X POST "https://api.supabase.com/v1/projects/hrxuvyhctuasuaxmhtny/secrets" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '[{"name":"POWERCRM_TOKEN","value":"..."}]'
```

## Rotacionar o `WEBHOOK_SHARED_SECRET`

Precisa trocar em **três** lugares, nesta ordem (senão o gatilho fica chamando a função com o
segredo antigo e toda cotação falha com 401 até terminar):

1. Function Secret `WEBHOOK_SHARED_SECRET` (comando acima).
2. Recriar o gatilho com o novo valor — repetir a parte `create or replace function
   public.trigger_send_lead()` de `supabase/migrations/0001_send_lead_webhook.sql`, com o novo
   segredo no `x-webhook-secret`.
3. Cofre local: `npm run vault -- set SUPABASE_WEBHOOK_SECRET`.

## Por que não usar o helper oficial `supabase_functions.http_request`

Esse projeto nunca teve um Database Webhook provisionado pela tela do Supabase Dashboard, então o
helper (que normalmente vem junto) não existia. A extensão `pg_net` foi habilitada manualmente e o
gatilho chama `net.http_post` direto — funciona igual, só é mais explícito.
