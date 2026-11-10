-- Conciliação com o Power CRM (botão "Conciliar com o Power CRM" do painel): guarda em cada lead o retrato
-- do que o CRM sabe dele — etapa do funil, situação (em andamento / vendido / descartado), motivo do descarte,
-- dados da venda e tags. Só ADICIONA colunas (todas opcionais) — nada existente muda e o site/Edge Function
-- continuam funcionando sem elas. Ordem de deploy: rode esta migration ANTES de publicar o código do painel
-- (a exportação CSV e os relatórios passam a pedir estas colunas).
--
-- crm_situacao: 'aberto' | 'ganho' | 'perdido' | 'nao_encontrado'  (NULL = ainda não conciliado)
-- crm_perda_via: 'arquivo' (arquivado no CRM, com o motivo oficial) | 'tag' (só marcado PERDIDO, sem arquivar)
alter table public.leads
  add column if not exists crm_sync_em timestamptz,
  add column if not exists crm_situacao text,
  add column if not exists crm_etapa text,
  add column if not exists crm_etapa_cod smallint,
  add column if not exists crm_motivo text,
  add column if not exists crm_motivo_obs text,
  add column if not exists crm_perda_via text,
  add column if not exists crm_arquivado_em timestamptz,
  add column if not exists crm_tags text[],
  add column if not exists crm_responsavel text,
  add column if not exists crm_plano text,
  add column if not exists crm_tabela text,
  add column if not exists crm_mensalidade numeric(10,2),
  add column if not exists crm_adesao numeric(10,2),
  add column if not exists crm_rastreador numeric(10,2),
  add column if not exists crm_vistoria_em timestamptz,
  add column if not exists crm_venda_em timestamptz;

alter table public.leads_test
  add column if not exists crm_sync_em timestamptz,
  add column if not exists crm_situacao text,
  add column if not exists crm_etapa text,
  add column if not exists crm_etapa_cod smallint,
  add column if not exists crm_motivo text,
  add column if not exists crm_motivo_obs text,
  add column if not exists crm_perda_via text,
  add column if not exists crm_arquivado_em timestamptz,
  add column if not exists crm_tags text[],
  add column if not exists crm_responsavel text,
  add column if not exists crm_plano text,
  add column if not exists crm_tabela text,
  add column if not exists crm_mensalidade numeric(10,2),
  add column if not exists crm_adesao numeric(10,2),
  add column if not exists crm_rastreador numeric(10,2),
  add column if not exists crm_vistoria_em timestamptz,
  add column if not exists crm_venda_em timestamptz;
