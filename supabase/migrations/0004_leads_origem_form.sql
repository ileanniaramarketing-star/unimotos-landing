-- De onde veio o lead: formulário do site ('site') ou pop-up dos botões de WhatsApp ('whatsapp'),
-- e qual botão abriu o pop-up (cta). Só ADICIONA colunas; os leads antigos ficam como 'site'.
alter table public.leads add column if not exists origem_form text not null default 'site';
alter table public.leads add column if not exists cta text;

alter table public.leads_test add column if not exists origem_form text not null default 'site';
alter table public.leads_test add column if not exists cta text;
