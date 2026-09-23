# Unimotos · Landing page de campanha

Landing page estática (HTML + CSS + JS puro), vermelho e preto, pensada para tráfego pago (Meta/Google Ads).
**Sem build, sem dependências para instalar** — o `index.html` fica na raiz do repositório e as bibliotecas
de animação (GSAP, ScrollTrigger, Lenis) já estão dentro de `assets/vendor/`.

## Estrutura

```
index.html          página inteira (seções, textos, formulário)
css/style.css       identidade visual, layout e estados de animação
js/config.js        ⭐ TUDO que é do cliente: WhatsApp, rastreamento, rodapé, fotos, avaliações
js/main.js          animações, formulário em 3 passos, eventos de conversão
assets/             favicon, og.jpg (prévia de link) e vendor/ (GSAP + Lenis)
```

## Antes de rodar campanha (checklist)

1. **`js/config.js` → `whatsapp`**: hoje é um número de teste (`5500000000000`). Troque pelo real (DDI+DDD+número).
2. **Logo**: o logotipo do cabeçalho/rodapé é um wordmark em HTML/CSS (classe `.wordmark`). Para usar o logo
   oficial, troque o conteúdo de `<a class="wordmark">` no topo e no rodapé do `index.html` por `<img src="assets/logo.svg" alt="Unimotos" height="34">`.
3. **Rastreamento** (`gtmId`, `metaPixelId`, `ga4Id`): preencha só o que for usar. A página dispara:
   - `whatsapp_click` (Meta: `Contact`) a cada clique em botão de WhatsApp, com o nome do botão em `cta`;
   - `generate_lead` (Meta: `Lead`) quando o formulário é enviado.
   - UTMs/`fbclid`/`gclid` ficam guardados na sessão e vão junto com o lead.
4. **Rodapé** (`footer`): endereço, horário, Instagram, Facebook.
5. **Textos**: copy é uma proposta — revise com o cliente (principalmente o que envolve condições de financiamento).
6. **Fotos** (opcional): coloque em `assets/motos/` e informe em `photos` no `config.js`.
   Sem foto, os cards usam o fundo vermelho/preto padrão.
7. **Avaliações** (opcional): preencha `reviews` com avaliações **reais** do Google; a seção só aparece se houver itens.
8. **og:image**: para a prévia do link no WhatsApp/Facebook funcionar, troque no `<head>` do `index.html`
   `content="assets/og.jpg"` pela URL absoluta (ex.: `https://seudominio.com.br/assets/og.jpg`).
9. **Indexação**: a página vem com `<meta name="robots" content="noindex,nofollow">` (padrão para página de anúncio).
   Para deixar o Google indexar, troque por `index,follow`.

## Captura de leads (opcional)

Se `leadWebhook` estiver preenchido, o formulário faz um `POST` (JSON no corpo, `Content-Type: text/plain`
para evitar preflight de CORS) com:

```json
{ "nome": "", "telefone": "5511987654321", "estilo": "", "condicao": "", "pagamento": "", "troca": "",
  "pagina": "", "data": "", "utm_source": "", "utm_campaign": "" }
```

O receptor deve fazer `JSON.parse` do corpo (Supabase Edge Function, RD Station via função intermediária, Make, n8n, Zapier…).
Em qualquer caso o WhatsApp abre com o resumo das respostas — o lead não depende do webhook.

## Testar localmente

```bash
npx serve .          # ou:  python -m http.server 8080
```

Abra `http://localhost:3000` (ou `:8080`). Dá para simular anúncio com `?utm_source=instagram&utm_campaign=teste`.

## Publicar: GitHub → hospedagem

```bash
git init
git add .
git commit -m "Landing page Unimotos"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/unimotos-landing.git
git push -u origin main
```

Na hospedagem, conecte o repositório (Git / "Importar do GitHub") com estes parâmetros:

| Campo | Valor |
|---|---|
| Framework / tipo | Site estático / "Other" |
| Comando de build | *(vazio)* |
| Diretório de saída / raiz | `/` (raiz do repositório) |
| Pasta de destino (hospedagem compartilhada) | `public_html` |
| Branch | `main` |

Ative o deploy automático (webhook/auto-deploy) para cada `git push` atualizar a página.

## Acessibilidade e desempenho

- Respeita `prefers-reduced-motion` (sem animações para quem pediu) e funciona sem JavaScript (o conteúdo aparece).
- Efeitos pesados (canvas de riscos, cursor, tilt) são reduzidos em celular; a rolagem horizontal fixa só liga em telas ≥ 980px.
- Fontes: Big Shoulders Display + Manrope (Google Fonts).
