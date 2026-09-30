-- Database Webhook que aciona a Edge Function "send-lead" (supabase/functions/send-lead/)
-- assim que um lead é INSERIDO na tabela `leads` já com vendedor sorteado e status "pendente".
--
-- Por quê: o envio de verdade ao Power CRM rodava no Node (Hostinger), mas essa hospedagem pode
-- encerrar o processo logo depois de responder ao navegador (comportamento tipo "serverless") — um
-- envio deixado "em segundo plano" lá corria risco de ser cortado no meio, sem erro nenhum
-- (aconteceu de verdade em produção, 2026-09-30: lead "Ilean teste" ficou preso em "pendente" pra
-- sempre). O Supabase não tem essa limitação: a função roda até terminar, desacoplada da resposta
-- que o Node já entregou ao navegador.
--
-- Este projeto não tinha o helper oficial `supabase_functions.http_request` provisionado (normalmente
-- vem de configurar um Database Webhook pela tela do Supabase Dashboard) — por isso o gatilho abaixo
-- chama `net.http_post` diretamente (extensão pg_net).
--
-- IMPORTANTE (segredo — NUNCA committar o valor real): a função é publicada com verify_jwt=false
-- (obrigatório para um gatilho de banco conseguir chamá-la sem um JWT de usuário), então o header
-- x-webhook-secret abaixo é o que impede qualquer um que descubra a URL da função de forçar envios
-- falsos ao Power CRM. Antes de rodar esta migração, troque '<WEBHOOK_SHARED_SECRET>' pelo valor
-- guardado no cofre local (`npm run vault -- get SUPABASE_WEBHOOK_SECRET`), que deve ser IDÊNTICO
-- ao Function Secret WEBHOOK_SHARED_SECRET configurado na Edge Function. Se o segredo for rotacionado,
-- atualize os DOIS lugares (Function Secret + esta função, recriando o gatilho) e o valor no cofre.

create extension if not exists pg_net with schema extensions;

create or replace function public.trigger_send_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $func$
begin
  perform net.http_post(
    url := 'https://hrxuvyhctuasuaxmhtny.supabase.co/functions/v1/send-lead',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', '<WEBHOOK_SHARED_SECRET>'),
    body := jsonb_build_object('record', row_to_json(NEW))
  );
  return NEW;
end;
$func$;

drop trigger if exists on_lead_pending on public.leads;
create trigger on_lead_pending
after insert on public.leads
for each row
when (NEW.status = 'pendente' and NEW.vendedor is not null)
execute function public.trigger_send_lead();

-- De propósito: o gatilho existe só em `public.leads` (tabela real), nunca em `public.leads_test`
-- (usada pelos testes automatizados) — assim nenhum teste consegue criar cotação de verdade no
-- Power CRM por acidente.
