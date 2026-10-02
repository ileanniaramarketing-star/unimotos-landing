-- Disparo em massa (aba "Disparos" do /painel) — campanhas e destinatários.
-- RLS ativado SEM nenhuma policy: só a chave de serviço (o próprio servidor) lê/escreve.
-- As tabelas *_test existem só para a suíte automatizada (nunca misturam com dado real).

create table if not exists public.disparos (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  criado_por text,
  nome text not null,
  mensagem text not null default '',
  midia_url text,
  midia_tipo text,              -- 'image' | 'video' | null
  intervalo_min int not null default 15,
  intervalo_max int not null default 25,
  total int not null default 0,
  enviados int not null default 0,
  falhas int not null default 0,
  status text not null default 'rodando', -- rodando | pausado | concluido | cancelado
  motivo text                   -- por que pausou (ex.: WhatsApp desconectado)
);

create table if not exists public.disparo_destinatarios (
  id uuid primary key default gen_random_uuid(),
  disparo_id uuid not null references public.disparos(id) on delete cascade,
  ordem int not null default 0,
  nome text,
  telefone text not null,
  vars jsonb not null default '{}'::jsonb,
  status text not null default 'pendente', -- pendente | enviando | enviado | falhou
  erro text,
  enviado_em timestamptz,
  zaap_id text
);
create index if not exists disparo_dest_fila_idx on public.disparo_destinatarios (disparo_id, status, ordem);
create index if not exists disparo_dest_enviado_idx on public.disparo_destinatarios (enviado_em);

create table if not exists public.disparos_test (like public.disparos including all);
create table if not exists public.disparo_destinatarios_test (
  like public.disparo_destinatarios including defaults including constraints including indexes
);
-- (sem FK nas tabelas de teste: a suíte limpa as duas livremente)

alter table public.disparos enable row level security;
alter table public.disparo_destinatarios enable row level security;
alter table public.disparos_test enable row level security;
alter table public.disparo_destinatarios_test enable row level security;
