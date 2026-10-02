-- Parâmetros de anúncio extras para o relatório completo: act_id (conta de anúncio), utm_id,
-- placement (posicionamento) e keyword (palavra-chave). Só ADICIONA colunas (nullable) — nada existente muda.
alter table public.leads add column if not exists utm_id text;
alter table public.leads add column if not exists act_id text;
alter table public.leads add column if not exists placement text;
alter table public.leads add column if not exists keyword text;

alter table public.leads_test add column if not exists utm_id text;
alter table public.leads_test add column if not exists act_id text;
alter table public.leads_test add column if not exists placement text;
alter table public.leads_test add column if not exists keyword text;
