# Unimotos · Landing pages de campanha (proteção veicular)

Duas páginas de campanha, no mesmo visual da arte da campanha (vermelho e preto, cartão branco de benefícios, escudo neon, selo de preço), com o **formulário de cotação pela placa no topo da página**, ao lado do título:

| Rota | Página |
|---|---|
| `/motos/` | Proteção veicular para motos |
| `/carros/` | Proteção veicular para carros |
| `/` | Escolha entre as duas (opcional; os anúncios devem apontar direto para `/motos/` ou `/carros/`) |

HTML/CSS/JS puros, sem dependências para instalar (GSAP e Lenis estão em `assets/vendor/`). Um servidor Node mínimo
(`scripts/serve.js`) entrega as páginas e recebe o formulário em `/api/lead`, que encaminha o lead ao **Power CRM**.

### Trocar a oferta da campanha (hoje: Black Friday)

O texto da oferta é HTML fixo (não depende de JavaScript), então uma troca mexe nestes lugares — em `motos/` e `carros/`:

- **Selo** (medalhão SVG do herói): anel que gira (`.bs-ring`), palavra pequena em vermelho (`.bs-esq`) e palavra grande (`.bs-blk`, com `textLength` para caber no círculo) e o texto para leitor de tela (`.bseal__sr`).
- **Herói** (`#offer`): `.black__lead` (frase), `.black__deal` (preço *De* riscado → *Por*, com texto escondido para leitor de tela) e `.black__until` (prazo — hoje "Válido até dia 30/11", ver abaixo).
- **Letreiro** (`#marqueeTrack`): 4 linhas iguais da oferta. Se o texto ficar mais longo/curto, ajuste a `duration` do letreiro em `js/main.js` (medido: ~129 px/s numa tela de 1440 px — 46 s com "Esquenta Black · 75% OFF · De/Por · boleto em dezembro · 16/11"; 33,4 s com "Black Friday · Adesão zero · boleto em janeiro"; 39,7 s com "Black Friday · 75% OFF na adesão · De R$ 200 por R$ 50 · boleto em janeiro"; 43,7 s com o prazo "Válido até 30/11" no fim, que é o atual) para manter a velocidade.
- **Faixa do CTA final**: `.blackbar__deal` e `.blackbar__note` (onde vai a data de fechamento).
- **Prazo**: hoje a oferta vale **até 30/11/2026** (herói: pílula `<p class="black__until">Válido até dia 30/11</p>` depois do `.black__deal`; letreiro: item "Válido até 30/11"; faixa final: `<b>Válido até dia 30/11.</b>` no início do `.blackbar__note`). Nada apaga a data sozinho: **depois de 30/11 retire os três trechos** (e, no `js/main.js`, volte a `duration` para ~39,7 s) ou troque pela nova data. Histórico: a oferta de 16/11 ficou no ar vencida por 8 dias até ser trocada em 24/11/2026.

## Como o lead chega ao CRM (e por que o token nunca vai ao navegador)

```
Navegador ──POST /api/lead──▶ servidor do site ──grava no Supabase──▶ Database Webhook ──▶ Edge Function "send-lead" ──▶ Power CRM
   (nome, WhatsApp, placa)     decide o vendedor      (status: pendente,     (dispara sozinho,         (token próprio,          funil / vendedor
   NUNCA vê nenhum token       (rodízio), responde     vendedor já definido)  sem o Node precisar        roda no Supabase)
   nem espera o CRM            rápido ao navegador                           esperar nem continuar
                                                                              rodando)
```

- O formulário só fala com o **próprio site**. Nenhum token do Power CRM existe no navegador.
- O **envio de verdade ao Power CRM roda no Supabase** (Edge Function `send-lead`, ver
  `supabase/functions/send-lead/`), não no servidor Node/Hostinger. Motivo: essa hospedagem pode
  encerrar o processo logo depois de responder ao navegador (tipo "serverless") — um envio deixado
  "em segundo plano" lá corria risco de ser cortado no meio, sem erro nenhum (aconteceu de verdade
  em produção, 30/09/2026). O Node só decide o **vendedor** (rodízio, instantâneo, lendo contagens
  do próprio Supabase) e grava o lead já com `vendedor` + `status: "pendente"` — é essa combinação,
  gravada na tabela `leads`, que um **Database Webhook** do Supabase detecta e usa para chamar a
  função sozinho, dentro de menos de 1 segundo, sem o Node precisar esperar ou continuar rodando.
- O WhatsApp abre em paralelo (resposta imediata do Node, sem esperar o Supabase): se o CRM estiver fora do ar, o lead não se perde para o cliente.
- O servidor valida tudo de novo (nome, telefone BR, placa), tem isca anti-robô, limite por IP, anti-duplicidade e só aceita requisições da própria origem.
- **Rodízio** entre **Kethlen e Fernanda** desde 24/11/2026 (Vitor está com `"active": false`: continua na lista e na Edge Function só para não quebrar leads dele já gravados; para ele voltar, basta `"active": true` + `desde`). Quem tem menos leads daquele veículo recebe; empate no sorteio. Arquivo: `config/powercrm.json`. Para incluir alguém: ativar em `sellers[]` (nome, PowerLink `code`, `whatsapp`) **e** copiar na Edge Function (veja abaixo) — com `desde` na entrada para o rodízio recomeçar do zero para todos. Quem decide o vendedor da vez é o **próprio site** (antes de gravar no Supabase) — dá pra conferir cada decisão no [painel interno](#painel-interno-painel-leads-e-relatórios).
- Enquanto `config/powercrm.json` não estiver preenchido, o servidor só registra no log que o lead **não** foi ao CRM (`crm: not_configured` em `/api/health`).
  Com tudo preenchido, o padrão local é **dry-run** (mostra o que enviaria, sem enviar — nunca grava `status: "pendente"`, então nunca aciona o webhook); só `POWERCRM_LIVE=1` faz o Node gravar pronto pra envio.
- Detalhes de deploy, segredos e redeploy da função: `supabase/functions/send-lead/README.md`. Migração do gatilho: `supabase/migrations/0001_send_lead_webhook.sql`.

## Painel interno (`/painel`): leads e relatórios

Painel de uso da própria equipe (não é público) para acompanhar os leads que chegam pelo site, **sem depender do Power CRM**
pra isso — quem decide o vendedor da vez também é aqui, antes de mandar a cotação pro CRM.

- **Login: cadastro aberto via Supabase Auth**. Qualquer pessoa com e-mail/senha pode criar conta na
  tela `/painel/login` (botão "Cadastre-se") e já ver **todos** os leads — é um painel de gestão só,
  sem permissão por pessoa/cargo. O navegador fala direto com o Supabase Auth (chave pública `anonKey`
  em `config/supabase.json`, não é segredo); nosso servidor só confere UMA VEZ, no login, se aquele
  token é válido (chamando o próprio Supabase) e cria a sessão de sempre (cookie assinado, 12h).
  ```powershell
  npm run vault -- set PAINEL_SESSION_SECRET    # string aleatória grande (assina a sessão; nunca precisa digitar de novo)
  ```
  Sem isso preenchido, `/painel` responde "não configurado" (503 no login) — o site continua funcionando normalmente.
  **Confirmação por e-mail**: por padrão o Supabase exige confirmar o e-mail antes do 1º login (o Claude Code não
  pode desligar isso sozinho — é uma decisão de segurança). Pra cadastro com acesso IMEDIATO (sem confirmar
  e-mail), desligue em **Supabase → Authentication → Settings → "Confirm email"**.
  Criar/resetar uma conta manualmente (sem passar pela tela): Supabase → Authentication → Users → "Add user".
- **Sessão**: cookie assinado (HttpOnly, só HTTP — nenhum JS lê), dura 12h. Reiniciar o servidor não desconecta ninguém;
  trocar `PAINEL_SESSION_SECRET` desconecta todo mundo de uma vez (útil se alguém sair da equipe).
- **Aba Leads**: nome, telefone, placa, veículo, UTMs (`utm_source/campaign/content`), **GCLID** (clique do Google Ads) e
  **FBCLID** (clique do Meta Ads), o **vendedor** sorteado no rodízio e o **status** do envio ao Power CRM (enviado, simulado,
  pendente, falhou, duplicado, CRM não configurado/sem token). Filtros por veículo, status, texto (nome/telefone/placa) e período.
- **Aba Relatórios**: total de leads, e a mesma contagem quebrada por veículo, plataforma (`utm_source`), campanha, criativo
  (`utm_content`), origem classificada pro CRM (Site / Google / Redes sociais) e vendedor — com filtro de período.
- **Onde fica guardado**: tabela `leads` no **Supabase** (Postgres), com segurança de linha (RLS) ativada e sem nenhuma
  regra — só quem usa a chave de serviço (`SUPABASE_SERVICE_KEY`, o próprio servidor) consegue ler/escrever; a chave
  pública ("anon") não enxerga nada. Um arquivo local (usado numa versão anterior) não sobrevive a deploys/reinícios em
  algumas hospedagens (a Hostinger reconstrói os arquivos do zero) — um banco de verdade sim.
- **Rodízio de vendedor**: sorteia quem tem **menos leads daquele veículo até agora** (lido direto do Supabase), com
  empate resolvido aleatoriamente — nunca fica 3×0 pra um lado, e funciona certinho mesmo logo depois de um reinício
  (diferente de um contador simples em arquivo, que reinicia do zero a cada deploy).
- **Código da cotação/negociação do Power CRM**: quando o envio dá certo, o código que o Power CRM devolve (`quotationCode`/`negotiationCode`) fica guardado junto do lead no Supabase — dá pra usar depois pra conferir lá se aquele lead foi vendido.
- **Conciliação com o Power CRM** (botão **"Conciliar com o Power CRM"** nas abas Leads e Relatórios): usa o código da negociação guardado em cada lead para buscar no CRM **onde ele está hoje** e grava no lead (colunas `crm_*`, migration `0005`):
  - **Situação**: *Em andamento*, *Vendido* (data de envio ao Hinova, etapa "Vendas concretizadas" ou tag `ASSOCIADO`), *Descartado* ou *Não encontrado* (o CRM não tem mais a negociação). *Descartado* = negociação arquivada (motivo vem do arquivamento) **ou** tag `PERDIDO` (vendedor que marca sem arquivar; aparece com o selo "tag" e o motivo vem da tag `FECHOU EM OUTRA`/`SEM CONTATO`, senão "Sem motivo informado").
  - **Etapa** (Cotação Recebida → Em negociação → Vistorias → Liberadas para cadastro → Vendas concretizadas), **vistoria**, **plano**, **mensalidade**, **adesão**, **rastreador**, **data da venda**, **tags** e **responsável** no CRM. Valores de cotação aparecem apagados até o lead ser vendido.
  - **Relatórios → Funil de vendas · Power CRM**: leads, em andamento, vistorias, **liberadas para cadastro**, vendidos, descartados, taxa de venda, mensalidades e adesões vendidas, **por campanha / criativo / plataforma / veículo / vendedor**, mais etapas, motivos de descarte e tags. Respeita o filtro de período. Leads sem código do CRM (duplicados/falha de envio) ficam de fora do funil e isso é dito na tela.
  - **"Liberadas para cadastro"** = leads **em andamento** que, na última conciliação, estavam nessa coluna do CRM (casa pelo nome da coluna). Descartados que pararam ali não entram no número (aparecem como "+N descartados nessa etapa"). **Só conta leads que passaram pelo painel** (formulário/pop-up do site): cartões que os vendedores criaram direto no CRM (indicação, associado ativo, etc.) não aparecem. O número só muda quando alguém clica em **Conciliar com o Power CRM**.
  - **Como roda**: só **lê** o Power CRM (`POST /api/report/db/paginated` em blocos de 15 dias + `GET /api/negotiation/{código}` para o nome da etapa) e grava só colunas `crm_*` dos leads; dado pessoal do relatório do CRM (clientes, CPF dos vendedores) nunca é guardado. Pega os leads dos últimos 90 dias, os nunca conferidos e os ainda em andamento. Não roda sozinha: é o botão. Pode demorar até ~1 minuto (limite de 100 s; se estourar, avisa "parcial" e é só clicar de novo). Duas pessoas não rodam ao mesmo tempo (a segunda recebe aviso). Regras (janela, etapas que contam como venda, tags) em `config/powercrm.json` → `conciliacao`.
  - Precisa de `POWERCRM_TOKEN` **e** `SUPABASE_SERVICE_KEY` nas variáveis de ambiente do servidor. Sem token o botão fica desligado com o aviso; sem a migration `0005` aplicada a tela avisa. Código: `scripts/lib/crmsync.js` (regras e CRM), `scripts/lib/store.js` (gravação e funil), rota `GET/POST /api/painel/crm-sync` em `scripts/serve.js`.
  - Filtro **"Situação no CRM"** na aba Leads e no CSV (que também traz todas as colunas do CRM).
- **Investimento em anúncios** (aba Relatórios → "Investimento em anúncios", acima do funil): gasto real do **Meta Ads** e do **Google Ads** cruzado com os leads e as vendas — **investimento, custo por lead e custo por venda**, por campanha / criativo / plataforma, mais uma **conferência** do que a plataforma contou (gasto, cliques, leads) × o que o site registrou. Vale para o período do filtro (corte por dia, horário de Brasília).
  - **De onde vem**: o servidor do site **não** tem acesso às contas de anúncio (um token do Meta/Google enxerga muito mais do que esta LP). Quem busca é o computador da gestão: `npm run ads:sync` (ou `npm run ads:simular`, que só mostra sem gravar). Ele usa os acessos do cofre da **Niara Hub** (`C:\NIARA-HUB-IA-ADS`, ou a pasta em `NIARA_HUB`) com **PowerShell 7 (`pwsh`)**, só **lê** as plataformas, confere as linhas (uma linha estranha aborta tudo, nada é gravado pela metade) e grava no Supabase (`ad_spend_diario`, migration `0006`; regravar o mesmo dia atualiza, nunca duplica). Contas e opções em `config/anuncios.json`. O painel mostra "atualizado em …" e avisa quando faltam dias — **rode o comando de novo para atualizar** (dá para agendar no Windows).
  - **Como liga lead e gasto**: pelo `utm_id` (ID da campanha — sobrevive a renomeação), senão pelo nome exato em `utm_campaign`, senão pelos apelidos de `config/anuncios.json` → `apelidosCampanha` (nome antigo → ID atual; hoje há 2, por renomeação no Meta e sufixo ` [DIARIO-30]` no Google). Nunca liga por "nome parecido". Criativo: `utm_content` = nome do anúncio (Meta) ou ID do anúncio (Google). **Dica:** o Meta já manda `utm_id` (ID da campanha); o Google ainda não — acrescentar `utm_id={campaignid}` no modelo de acompanhamento da campanha do Google dispensa o apelido dele.
  - **O que entra no custo por lead**: investimento das campanhas "da LP" (as que têm ao menos 1 lead no painel, de qualquer época) ÷ leads de anúncio (utm Meta/Google ou campanha ligada) que chegaram ao CRM. Campanha com gasto e **sem** lead no painel (ex.: conversa direta no WhatsApp) aparece com a etiqueta "sem lead no painel" e fica **de fora** do custo por lead (o total dela aparece à parte). **Custo por venda** só existe depois da conciliação com o Power CRM.
  - **Limites que o painel avisa**: leads sem criativo identificado (link sem `utm_content` ou com `{{ad.name}}` em branco) deixam o custo por **criativo** acima do real; Meta "clique" = clique no link (o que chega na página); Google "leads" = conversões cujo nome casa com `google.acaoLead` (as demais, como ligações, viram "outros contatos"). O gasto soma centavos por dia: pode diferir em centavos do total do gerenciador.
  - Sem a tabela/sem dados, o painel só mostra o aviso e **tudo o mais continua funcionando**. Código: `scripts/ads-fetch.ps1` (busca), `scripts/sync-ads.js` (confere e grava), `scripts/lib/adspend.js` (regras de ligação, sem rede), `scripts/lib/store.js` (leitura paginada e relatório).
- **Gerenciar vendedores** (adicionar/remover do rodízio) continua sendo em `config/powercrm.json`, não tem tela pra isso ainda.
- Local: `npm run dev` → `http://127.0.0.1:4321/painel/`. Em produção: `https://SEU-DOMINIO/painel/` (as três variáveis do
  cofre também precisam existir no painel de variáveis de ambiente da hospedagem).

## Meta Pixel + Conversions API (Facebook/Instagram Ads)

`js/config.js -> metaPixelId` (público, já preenchido). O evento **"Lead"** só é disparado no
navegador **depois** que o próprio servidor confirma que aceitou o lead de verdade (nunca antes,
nunca em duplicado) — evita contar conversão que não aconteceu. Além do pixel do navegador, o
**servidor também manda o mesmo evento pela Conversions API** (`scripts/lib/metacapi.js`), com o
telefone sempre em hash SHA-256 (nunca em texto puro) e o **mesmo `eventId`** dos dois lados —
assim o Meta entende que é o mesmo evento visto de dois jeitos e não conta em dobro (deduplicação
oficial da Meta). Isso deixa o rastreamento mais confiável mesmo com bloqueador de anúncio/ITP no
navegador do cliente.

- Token: `META_CAPI_TOKEN` no cofre (é uma credencial de verdade — nunca em arquivo do repositório).
- Pixel/versão da API: `config/meta.json` (não é segredo, pode ir pro Git).
- Sem o token configurado: o servidor simplesmente não tenta mandar nada (silêncio, sem erro) — o
  site e o envio ao Power CRM continuam funcionando normalmente.
- Gerar/trocar o token: Gerenciador de Eventos do Meta → Configurações → Conversions API →
  Gerar token de acesso (do lado do pixel `2410461069470382`).
- **PageView**: toda carga de página chama `fbq('track','PageView', ..., {eventID})` no navegador
  **e** `POST /api/pageview` (mesmo eventId) pro servidor mandar o espelho pela Conversions API —
  bem mais permissivo que o `/api/lead` (não é uma conversão, é só navegação), sem exigir nem
  aceitar nenhum dado pessoal.
- **Qualidade de correspondência (EMQ)**: o evento "Lead" manda telefone **e nome/sobrenome**
  (sempre em hash SHA-256) — quanto mais sinal, melhor a nota do Meta.
- **Testar sem afetar a campanha**: `META_TEST_EVENT_CODE` no cofre (opcional) — com ele presente,
  os eventos aparecem na aba **Testar eventos** do Gerenciador de Eventos em tempo real, mas **não
  contam pra otimização de anúncio**. ⚠️ Nunca deixar essa variável nas variáveis de ambiente de
  produção (só usar localmente, durante um teste pontual).

## Cofre de segredos (local)

`.local/secrets.vault.json` — ignorado pelo Git, com ACL só do dono, valores cifrados pelo Windows (DPAPI): só abre no seu usuário do Windows nesta máquina.

```powershell
npm run vault -- list                 # nomes + tamanho + impressão digital (nunca o valor)
npm run vault -- set POWERCRM_TOKEN   # guarda (digitação oculta)
npm run vault -- remove NOME
npm run dev                           # sobe http://127.0.0.1:4321 já com o cofre carregado (modo dry-run)
npm run check:secrets                 # procura os segredos em todos os arquivos e no histórico do Git
```

Segredos guardados hoje: `PAINEL_SESSION_SECRET` do [painel interno](#painel-interno-painel-leads-e-relatórios) (login em si é Supabase Auth, cadastro aberto — sem usuário/senha fixos), `META_CAPI_TOKEN` (Meta Conversions API, ver abaixo) e `SUPABASE_SERVICE_KEY` (banco do painel — `config/supabase.json` tem a URL e a chave pública `anonKey`, que não são segredo).

Três segredos não são mais lidos pelo Node/Hostinger, mas continuam no cofre local porque são usados fora do servidor:
- `POWERCRM_TOKEN`: hoje é a Edge Function `send-lead` (Supabase) que manda de verdade ao Power CRM — o Node só guarda uma cópia pra alimentar `/api/health` e o preview do dry-run. Configurado como *Function Secret* separado no Supabase (ver `supabase/functions/send-lead/README.md`).
- `SUPABASE_WEBHOOK_SECRET`: valor do *Function Secret* `WEBHOOK_SHARED_SECRET` da mesma função — protege a função (publicada sem verificar JWT) de ser chamada por qualquer um que descubra a URL. Guardado aqui só para poder recriar o gatilho do banco (`supabase/migrations/0001_send_lead_webhook.sql`) se precisar.
- `SUPABASE_ACCESS_TOKEN`: token de acesso à Management API do Supabase, usado só para fazer deploy/configurar a Edge Function e seus secrets (não é lido pelo site).

- Há um **pre-commit** local (`.git/hooks/pre-commit`) que **bloqueia o commit** se qualquer valor do cofre aparecer nos arquivos.
- **Em produção** (Hostinger): cadastre `POWERCRM_TOKEN` e `POWERCRM_LIVE=1` nas variáveis de ambiente do painel. Nunca em arquivo do repositório.
- Se um token já passou por chat/e-mail, gere um novo no Power CRM (*Minha empresa → Integrações → Power API*) e troque no cofre e no painel.

## Falta para ligar o CRM (`config/powercrm.json`)

Preencher com o que está na documentação do painel do Power CRM: `baseUrl`, `auth.header`/`auth.scheme`, `endpoints.createQuotation`,
`fieldMap` (nomes dos campos da cotação), `funnelStageId` (etapa inicial), e o `code` de cada vendedor. Cada veículo pode ter etapa e vendedores
próprios em `products.moto` / `products.carro`.

## Estrutura

```
index.html          escolha (/)
motos/index.html    LP de motos
carros/index.html   LP de carros
painel/             painel interno (login + leads + relatórios) — ver seção acima
css/style.css       visual, layout, animações
js/config.js        ⭐ dados do cliente (PÚBLICO: nunca coloque token aqui)
js/main.js          animações, formulário de cotação, eventos de conversão, troca Moto/Carro (data-vehicle-switch)
assets/             favicon, imagens de compartilhamento (og*.jpg), brand/ (logo), partners/ (Grupo Zelo), vendor/ (GSAP + Lenis)
config/powercrm.json  configuração NÃO secreta do CRM
config/meta.json     configuração NÃO secreta do Meta Pixel/Conversions API
config/supabase.json configuração NÃO secreta do Supabase (URL do projeto; a chave fica no cofre)
config/anuncios.json contas do Meta/Google e apelidos de campanha (gasto dos anúncios; sem segredo)
scripts/            serve.js (servidor + /api/lead, /api/pageview e /api/painel/*), build.js, vault.ps1
scripts/lib/        lead.js, powercrm.js, metacapi.js, pageview.js, auth.js (login do painel), store.js (leads no Supabase), adspend.js (gasto × leads)
scripts/ads-fetch.ps1, scripts/sync-ads.js   busca o gasto no Meta/Google (cofre da Niara Hub) e grava no Supabase — `npm run ads:sync`
supabase/functions/send-lead/  Edge Function que manda de verdade ao Power CRM (ver seção acima)
supabase/migrations/            SQL do gatilho (Database Webhook) que aciona a função
```

## Antes de rodar campanha

1. **WhatsApp**: `js/config.js → whatsapp` está com número de teste (`5500000000000`). Trocar pelo real.
2. **Conferir com o cliente** os textos e números baseados no site institucional da associação: *15 anos, +5.000 veículos reparados,
   +4.800 indenizações pagas* (`stats`), endereço, coberturas (roubo e furto, colisão, incêndio, fenômenos naturais, perda total),
   "Pagamos 100% da FIPE" e "Guincho todo o Brasil" (vieram da arte da campanha), "sem análise de perfil", carro reserva e KM livre "conforme o plano". Aviso legal no rodapé:
   associação de proteção veicular, **não é seguro**, Lei Complementar nº 213/2025.
3. **Selo de preço**: `price` em `js/config.js` (`carro: "55,36"`, com vírgula; `moto: "60"`). Com valor, o hero mostra "Proteção a partir de / R$ X/mês / Menos de R$ N,00 por dia" (esta última linha fica numa faixa branca com texto preto; o "por dia" é calculado: valor ÷ 30, arredondado para cima) e o rodapé traz "sujeito ao modelo, ano e valor FIPE". Vazio = o selo não aparece.
4. **Foto do veículo**: a arte usa foto do carro sobre piso vermelho. O hero ainda não tem foto (o formulário ocupa o lugar do antigo velocímetro); quando houver as fotos em PNG com fundo transparente, elas entram no hero/seções.
5. **Logo**: já é o oficial (Club Unimotos Car), em `assets/brand/`: `logo-original.png` (intacto, feito para fundo claro) e `logo-dark.png` (versão para o nosso fundo preto: vermelho original mantido, cinza-escuro trocado por branco). Ideal pedir ao cliente o logo em SVG (ou PNG maior) e uma versão oficial para fundo escuro: o PNG de 252×72 fica levemente suave em telas retina. As imagens de compartilhamento (`og*.jpg`) ainda usam o logotipo em texto.
6. **Rastreamento** (`gtmId`, `metaPixelId`, `ga4Id`): preencher só o que for usar. Eventos: `whatsapp_click` (Meta: Contact) e `generate_lead` (Meta: Lead), com `veiculo`.
   Nome, telefone e placa **não** vão ao Pixel/GA.
7. **Prévia de link** (`og:image`): use a URL absoluta do domínio (ex.: `https://seudominio.com.br/assets/og-motos.jpg`).
8. **Indexação**: as páginas vêm com `noindex,nofollow` (padrão de página de anúncio). Trocar por `index,follow` se quiser aparecer no Google.
9. **Consulta automática da placa** (opcional): `plateLookupUrl` aponta para um endpoint SEU que guarda a chave do provedor
   (não existe API pública gratuita; há provedores com teste/limite gratuito). Vazio = só coleta a placa.

## Rodar local

```powershell
npm run dev        # http://127.0.0.1:4321  → /motos/  /carros/   (F5 mostra a edição; CRM em dry-run)
```

Simular anúncio: `http://127.0.0.1:4321/motos/?utm_source=instagram&utm_campaign=teste`.

## Publicar: GitHub → Hostinger

```bash
git add . && git commit -m "..." && git push
```

**Precisa de hospedagem com Node** (a Hostinger "Node.js / importar repositório Git"), porque `/api/lead` roda no servidor:

| Campo | Valor |
|---|---|
| Comando de build | `npm run build` (gera `dist/`) |
| Diretório de saída | `dist` |
| Comando de start | `npm start` |
| Node | 20 ou 22 |
| Variáveis de ambiente | `POWERCRM_TOKEN`, `POWERCRM_LIVE=1`, `PAINEL_SESSION_SECRET`, `META_CAPI_TOKEN`, `SUPABASE_SERVICE_KEY` |

Se a hospedagem for **somente estática** (hPanel → Git → `public_html`), as páginas funcionam, mas `/api/lead` não existe: o formulário ainda abre o
WhatsApp, porém o lead **não chega ao CRM**. Nesse caso o envio deve passar por um endpoint externo (ex.: Supabase Edge Function) em `leadWebhook`.

Depois de publicar, `https://SEU-DOMINIO/api/health` deve responder `{"ok":true,"crm":"live"}`.

## Cache (por que a página não fica "quebrada" depois de um deploy)

CSS/JS são referenciados com versão do conteúdo (`/css/style.css?v=3fa9c1d2`, feito por `scripts/version-assets.js`).
Mudou o arquivo, muda o endereço: navegador e CDN buscam a versão nova. O servidor manda HTML/CSS/JS sempre com revalidação
(`no-cache` + ETag) e só deixa em cache de 1 ano o que tem `?v=`. O `npm run build` e o pre-commit atualizam as versões sozinhos;
manualmente: `npm run assets:version`. Sem isso, um celular podia receber a página nova com o CSS antigo (ícones gigantes, espaços vazios).

## Acessibilidade e desempenho

Respeita `prefers-reduced-motion`, funciona sem JavaScript (o conteúdo aparece), efeitos pesados são reduzidos no celular e a rolagem horizontal fixa só liga em telas ≥ 980px.
