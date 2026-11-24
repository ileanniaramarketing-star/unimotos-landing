-- Gasto diário dos anúncios (Meta Ads + Google Ads) para o painel cruzar com os leads: custo por lead, custo por venda e
-- investimento por campanha/criativo/plataforma. Quem grava é o script local scripts/sync-ads.js (npm run ads:sync), com a
-- chave de serviço — os acessos às plataformas de anúncio ficam no cofre da Niara Hub, nunca no servidor do site.
-- Cria uma tabela NOVA; nada existente muda (o site, o envio ao Power CRM e a conciliação continuam iguais). A tabela
-- pode ser criada antes ou depois de publicar o código do painel: sem ela, o painel só mostra "gasto ainda não sincronizado".
--
-- nivel 'campanha' = total da campanha no dia (fonte da verdade do investimento);
-- nivel 'anuncio'  = detalhe por anúncio no dia (Meta: nome do anúncio = utm_content; Google: ID do anúncio = utm_content).
-- anuncio_id = '' nas linhas de campanha (a chave primária não aceita NULL).
-- leads_plataforma / contatos_plataforma: o que a PLATAFORMA contou (Meta: ação "lead" e conversas no WhatsApp;
-- Google: conversões de lead e as demais, como ligações) — serve para conferir contra os leads que o site registrou.
create table if not exists public.ad_spend_diario (
  dia date not null,
  plataforma text not null check (plataforma in ('meta', 'google')),
  nivel text not null check (nivel in ('campanha', 'anuncio')),
  campanha_id text not null,
  anuncio_id text not null default '',
  campanha_nome text,
  anuncio_nome text,
  investimento numeric(12,2) not null default 0,
  impressoes bigint not null default 0,
  cliques bigint not null default 0,
  leads_plataforma numeric(10,2),
  contatos_plataforma numeric(10,2),
  atualizado_em timestamptz not null default now(),
  primary key (dia, plataforma, nivel, campanha_id, anuncio_id)
);

create index if not exists ad_spend_diario_dia_idx on public.ad_spend_diario (dia);

-- mesmo modelo de segurança da tabela leads: RLS ligado SEM nenhuma policy = só a chave de serviço lê/escreve
-- (nem a chave "anon" pública consegue ler).
alter table public.ad_spend_diario enable row level security;
