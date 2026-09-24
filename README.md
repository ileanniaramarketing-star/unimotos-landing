# Unimotos · Landing pages de campanha (proteção veicular)

Duas páginas de campanha, com o mesmo visual (vermelho e preto) e conversão por **cotação pela placa**:

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
- **Rodízio** entre Vitor e Kathleen (alternando, por veículo), `config/powercrm.json`.
- Enquanto `config/powercrm.json` não estiver preenchido, o servidor só registra no log que o lead **não** foi ao CRM (`crm: not_configured` em `/api/health`).
  Com tudo preenchido, o padrão local é **dry-run** (mostra o que enviaria, sem enviar); só `POWERCRM_LIVE=1` envia de verdade.

## Cofre de segredos (local)

`.local/secrets.vault.json` — ignorado pelo Git, com ACL só do dono, valores cifrados pelo Windows (DPAPI): só abre no seu usuário do Windows nesta máquina.

```powershell
npm run vault -- list                 # nomes + tamanho + impressão digital (nunca o valor)
npm run vault -- set POWERCRM_TOKEN   # guarda (digitação oculta)
npm run vault -- remove NOME
npm run dev                           # sobe http://127.0.0.1:4321 já com o cofre carregado (modo dry-run)
npm run check:secrets                 # procura os segredos em todos os arquivos e no histórico do Git
```

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
css/style.css       visual, layout, animações
js/config.js        ⭐ dados do cliente (PÚBLICO: nunca coloque token aqui)
js/main.js          animações, formulário de cotação, eventos de conversão
assets/             favicon, imagens de compartilhamento (og*.jpg), vendor/ (GSAP + Lenis)
config/powercrm.json  configuração NÃO secreta do CRM
scripts/            serve.js (servidor + /api/lead), build.js, vault.ps1, lib/ (lead, powercrm)
```

## Antes de rodar campanha

1. **WhatsApp**: `js/config.js → whatsapp` está com número de teste (`5500000000000`). Trocar pelo real.
2. **Conferir com o cliente** os textos e números baseados no site institucional da associação: *15 anos, +5.000 veículos reparados,
   +4.800 indenizações pagas* (`stats`), endereço, coberturas (roubo e furto, colisão, incêndio, fenômenos naturais, perda total),
   "até 100% da tabela FIPE", "sem análise de perfil", carro reserva e KM livre "conforme o plano". Aviso legal no rodapé:
   associação de proteção veicular, **não é seguro**, Lei Complementar nº 213/2025.
3. **Logo**: hoje é um wordmark em HTML/CSS (`.wordmark`). Trocar pelo logo oficial quando houver arquivo.
4. **Rastreamento** (`gtmId`, `metaPixelId`, `ga4Id`): preencher só o que for usar. Eventos: `whatsapp_click` (Meta: Contact) e `generate_lead` (Meta: Lead), com `veiculo`.
   Nome, telefone e placa **não** vão ao Pixel/GA.
5. **Prévia de link** (`og:image`): use a URL absoluta do domínio (ex.: `https://seudominio.com.br/assets/og-motos.jpg`).
6. **Indexação**: as páginas vêm com `noindex,nofollow` (padrão de página de anúncio). Trocar por `index,follow` se quiser aparecer no Google.
7. **Consulta automática da placa** (opcional): `plateLookupUrl` aponta para um endpoint SEU que guarda a chave do provedor
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
| Variáveis de ambiente | `POWERCRM_TOKEN`, `POWERCRM_LIVE=1` |

Se a hospedagem for **somente estática** (hPanel → Git → `public_html`), as páginas funcionam, mas `/api/lead` não existe: o formulário ainda abre o
WhatsApp, porém o lead **não chega ao CRM**. Nesse caso o envio deve passar por um endpoint externo (ex.: Supabase Edge Function) em `leadWebhook`.

Depois de publicar, `https://SEU-DOMINIO/api/health` deve responder `{"ok":true,"crm":"live"}`.

## Acessibilidade e desempenho

Respeita `prefers-reduced-motion`, funciona sem JavaScript (o conteúdo aparece), efeitos pesados são reduzidos no celular e a rolagem horizontal fixa só liga em telas ≥ 980px.
