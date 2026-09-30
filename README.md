# Unimotos · Landing pages de campanha (proteção veicular)

Duas páginas de campanha, no mesmo visual da arte da campanha (vermelho e preto, cartão branco de benefícios, escudo neon, selo de preço), com o **formulário de cotação pela placa no topo da página**, ao lado do título:

| Rota | Página |
|---|---|
| `/motos/` | Proteção veicular para motos |
| `/carros/` | Proteção veicular para carros |
| `/` | Escolha entre as duas (opcional; os anúncios devem apontar direto para `/motos/` ou `/carros/`) |

HTML/CSS/JS puros, sem dependências para instalar (GSAP e Lenis estão em `assets/vendor/`). Um servidor Node mínimo
(`scripts/serve.js`) entrega as páginas e recebe o formulário em `/api/lead`, que encaminha o lead ao **Power CRM**.

## Como o lead chega ao CRM (e por que o token nunca vai ao navegador)

```
Navegador ──POST /api/lead──▶ servidor do site ──(token + rodízio)──▶ Power CRM
   (nome, WhatsApp, placa)       valida, barra robô,                   funil / vendedor
   NUNCA vê o token              lê POWERCRM_TOKEN do ambiente
```

- O formulário só fala com o **próprio site**. O token existe apenas no servidor, como variável de ambiente.
- O WhatsApp abre em paralelo: se o CRM estiver fora do ar, o lead não se perde para o cliente.
- O servidor valida tudo de novo (nome, telefone BR, placa), tem isca anti-robô, limite por IP, anti-duplicidade e só aceita requisições da própria origem.
- **Rodízio** entre Vitor e Kethlen (alternando, por veículo), `config/powercrm.json`. Quem decide o vendedor da vez é o **próprio site** (antes de mandar ao CRM) — dá pra conferir cada decisão no [painel interno](#painel-interno-painel-leads-e-relatórios).
- Enquanto `config/powercrm.json` não estiver preenchido, o servidor só registra no log que o lead **não** foi ao CRM (`crm: not_configured` em `/api/health`).
  Com tudo preenchido, o padrão local é **dry-run** (mostra o que enviaria, sem enviar); só `POWERCRM_LIVE=1` envia de verdade.

## Painel interno (`/painel`): leads e relatórios

Painel de uso da própria equipe (não é público) para acompanhar os leads que chegam pelo site, **sem depender do Power CRM**
pra isso — quem decide o vendedor da vez também é aqui, antes de mandar a cotação pro CRM.

- **Login estático**: um usuário e uma senha fixos (sem cadastro, sem "esqueci a senha"), guardados no cofre:
  ```powershell
  npm run vault -- set PAINEL_USER              # ex.: admin
  npm run vault -- set PAINEL_PASS              # senha (dá pra gerar uma forte: só digitar algo longo)
  npm run vault -- set PAINEL_SESSION_SECRET    # uma string aleatória grande (assina a sessão; nunca precisa digitar de novo)
  ```
  Sem os três preenchidos, `/painel` responde "não configurado" (503 no login) — o site continua funcionando normalmente.
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

## Cofre de segredos (local)

`.local/secrets.vault.json` — ignorado pelo Git, com ACL só do dono, valores cifrados pelo Windows (DPAPI): só abre no seu usuário do Windows nesta máquina.

```powershell
npm run vault -- list                 # nomes + tamanho + impressão digital (nunca o valor)
npm run vault -- set POWERCRM_TOKEN   # guarda (digitação oculta)
npm run vault -- remove NOME
npm run dev                           # sobe http://127.0.0.1:4321 já com o cofre carregado (modo dry-run)
npm run check:secrets                 # procura os segredos em todos os arquivos e no histórico do Git
```

Segredos guardados hoje: `POWERCRM_TOKEN`, os três do [painel interno](#painel-interno-painel-leads-e-relatórios) (`PAINEL_USER`, `PAINEL_PASS`, `PAINEL_SESSION_SECRET`), `META_CAPI_TOKEN` (Meta Conversions API, ver abaixo) e `SUPABASE_SERVICE_KEY` (banco do painel — `config/supabase.json` tem a URL, que não é segredo).

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
js/main.js          animações, formulário de cotação, eventos de conversão
assets/             favicon, imagens de compartilhamento (og*.jpg), brand/ (logo), partners/ (Grupo Zelo), vendor/ (GSAP + Lenis)
config/powercrm.json  configuração NÃO secreta do CRM
config/meta.json     configuração NÃO secreta do Meta Pixel/Conversions API
config/supabase.json configuração NÃO secreta do Supabase (URL do projeto; a chave fica no cofre)
scripts/            serve.js (servidor + /api/lead, /api/pageview e /api/painel/*), build.js, vault.ps1
scripts/lib/        lead.js, powercrm.js, metacapi.js, pageview.js, auth.js (login do painel), store.js (leads no Supabase)
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
| Variáveis de ambiente | `POWERCRM_TOKEN`, `POWERCRM_LIVE=1`, `PAINEL_USER`, `PAINEL_PASS`, `PAINEL_SESSION_SECRET`, `META_CAPI_TOKEN`, `SUPABASE_SERVICE_KEY` |

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
