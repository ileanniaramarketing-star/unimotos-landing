'use strict';
/*
  Cotação de TESTE no Power CRM (ferramenta de desenvolvimento — não vai para o site, não é usada em produção).

  Por padrão só SIMULA: mostra o que seria enviado, sem escrever nada no CRM.
  Para criar de verdade UMA cotação de teste, acrescente --enviar (rode UMA vez; rodar de novo duplica).

    Simular:  npm run vault -- run -- node scripts/dev/powercrm-test-quotation.js A
    Enviar:   npm run vault -- run -- node scripts/dev/powercrm-test-quotation.js A --enviar

  Variantes (comece pela A; só use a B se a A reclamar de campo faltando):
    A = campos mínimos (nome, telefone, e-mail, placa, cidade, origem, consultor)
    B = A + modelo e ano genéricos (busca Volkswagen Gol na própria API)
    C = IGUAL AO QUE O FORMULÁRIO DA LP ENVIA: sem e-mail, só nome, telefone, placa, cidade, origem e consultor

  O token vem do cofre (POWERCRM_TOKEN) e nunca é impresso. O registro é marcado "TESTE LP - pode apagar".
  Telefone e e-mail do teste vêm das variáveis TESTE_TELEFONE e TESTE_EMAIL (nada pessoal fica no código).
*/
const TOKEN = process.env.POWERCRM_TOKEN || '';
if (TOKEN.length < 20) { console.log('Token não encontrado. Rode via cofre: npm run vault -- run -- node scripts/dev/powercrm-test-quotation.js A'); process.exit(1); }

const HOST = 'https://api.powercrm.com.br';
const H = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json', 'Content-Type': 'application/json' };
const variant = (process.argv[2] || 'A').toUpperCase();
const SEND = process.argv.includes('--enviar');
const redact = (s) => String(s).split(TOKEN).join('[REDACTED]');
const PII = /mail|phone|tel|cel|cpf|document|senha|password|token|chassi|renavam|address|birth/i;

const call = async (p, o) => {
  const r = await fetch(HOST + p, Object.assign({ headers: H }, o));
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* não é JSON */ }
  return { status: r.status, json, text };
};
const body = (r) => (r.json && r.json.body !== undefined ? r.json.body : r.json);

(async () => {
  // Dados pessoais NÃO ficam no código: telefone e e-mail do teste vêm de variáveis de ambiente.
  const phone = process.env.TESTE_TELEFONE || '', email = process.env.TESTE_EMAIL || '';
  if (!phone || (variant !== 'C' && !email)) {
    console.log('Defina TESTE_TELEFONE (ex.: "(31) 9XXXX-XXXX")' + (variant !== 'C' ? ' e TESTE_EMAIL' : '') + ' antes de rodar. Exemplo (PowerShell):\n  $env:TESTE_TELEFONE="(31) 9XXXX-XXXX"; $env:TESTE_EMAIL="voce@email.com"; npm run vault -- run -- node scripts/dev/powercrm-test-quotation.js ' + variant);
    process.exit(1);
  }
  const payload = {
    name: 'TESTE LP - pode apagar',
    phone,
    email,
    plts: 'TST0A00',
    city: 1770,              // Contagem
    origemId: 2424,          // SITE
    slsmnNwId: 'vrXbVKeq',   // PowerLink da Ilean (consultora de teste)
    workVehicle: false
  };
  if (variant === 'C') { delete payload.email; payload.name = 'TESTE LP 2 (sem e-mail) - pode apagar'; payload.plts = 'TST0B11'; }
  if (variant === 'B') {
    const brands = body(await call('/api/quotation/cb?type=1')) || [];
    const vw = brands.find((b) => /volkswagen/i.test(b.text || b.name)) || brands[0];
    const models = body(await call('/api/quotation/cm?cb=' + vw.id)) || [];
    const gol = models.find((m) => /gol/i.test(m.text || m.name)) || models[0];
    const years = body(await call('/api/quotation/cmy?cm=' + gol.id)) || [];
    payload.mdl = gol.id; payload.mdlYr = years[0] && years[0].id;
    console.log('modelo de teste: ' + (vw.text || vw.name) + ' / ' + (gol.text || gol.name) + ' / ano ' + (years[0] && (years[0].text || years[0].name)));
  }
  console.log('variante ' + variant + ' — ' + (SEND ? 'ENVIANDO DE VERDADE' : 'SIMULAÇÃO (nada será enviado)'));
  console.log('POST ' + HOST + '/api/quotation/add');
  console.log(JSON.stringify(payload, null, 2));
  if (!SEND) { console.log('\nNada foi enviado. Para criar a cotação de teste, rode de novo com --enviar.'); return; }

  const r = await call('/api/quotation/add', { method: 'POST', body: JSON.stringify(payload) });
  console.log('\nHTTP ' + r.status);
  console.log('resposta: ' + redact(r.text).slice(0, 1500));

  // leitura de volta da negociação: coluna do funil, origem, responsável e quantas cotações ela tem (mostra se juntou à anterior)
  const rb = body(r); const negCode = rb && typeof rb === 'object' ? (rb.negotiationCode || rb.negotationCode) : null;
  if (r.status < 300 && negCode) {
    const ng = await call('/api/negotiation/' + encodeURIComponent(negCode)); const nb = body(ng);
    if (nb && typeof nb === 'object') console.log('\nnegociação ' + negCode + ' → coluna: ' + nb.pipelineColumn + ' | origem: ' + nb.leadSource + ' | responsável: ' + nb.responsible + ' | cooperativa: ' + nb.coopName + ' | cotações na negociação: ' + (nb.quotations || []).length + ' | tags: ' + JSON.stringify(nb.tags));
  }

  // leitura de volta (só se a resposta trouxer um código de cotação)
  const b = body(r);
  const code = b && typeof b === 'object' ? (b.quotationCode || b.code || b.negotiationCode || b.id) : (typeof b === 'string' ? b : null);
  if (r.status < 300 && code) {
    const g = await call('/api/quotation/' + encodeURIComponent(code));
    const gb = body(g);
    console.log('\nleitura de volta GET /api/quotation/' + code + ' → HTTP ' + g.status);
    if (gb && typeof gb === 'object') console.log(JSON.stringify(gb, (k, v) => (PII.test(k) && v ? '«oculto»' : v), 1).slice(0, 3000));
  }
})().catch((e) => console.log('erro: ' + redact(e.message)));
