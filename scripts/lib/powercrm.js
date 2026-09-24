'use strict';
/*
  Integração com o Power CRM — roda SÓ no servidor.
  O token vem de process.env.POWERCRM_TOKEN (cofre local via scripts/vault.ps1, ou variável de
  ambiente do painel da hospedagem). Ele nunca é enviado ao navegador, nunca é logado.

  Cada veículo (moto / carro) pode ter etapa de funil e vendedores próprios (config/powercrm.json,
  bloco "products"); o que não for definido ali herda o bloco global.

  Modos (ver /api/health):
    no_token        sem POWERCRM_TOKEN: não envia nada
    not_configured  falta preencher config/powercrm.json
    dry-run         tudo configurado, mas POWERCRM_LIVE != 1: só registra o que enviaria (padrão local)
    live            POWERCRM_LIVE=1: envia de verdade
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// POWERCRM_CONFIG / POWERCRM_DATA_DIR existem só para testes automatizados
const CFG_PATH = process.env.POWERCRM_CONFIG || path.join(ROOT, 'config', 'powercrm.json');
const RR_DIR = process.env.POWERCRM_DATA_DIR || path.join(ROOT, '.data');
const RR_PATH = path.join(RR_DIR, 'roundrobin.json');
const VEHICLES = ['moto', 'carro'];

const loadCfg = () => JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const token = () => process.env.POWERCRM_TOKEN || '';

// remove o token de qualquer texto antes de logar
const redact = (s) => { const t = token(); return t ? String(s).split(t).join('[REDACTED]') : String(s); };
const log = (...a) => console.log('[powercrm]', ...a.map((x) => redact(typeof x === 'string' ? x : JSON.stringify(x))));

// etapa/vendedores efetivos de um veículo (bloco do produto sobrepõe o global)
function resolve(cfg, veiculo) {
  const p = (cfg.products && cfg.products[veiculo]) || {};
  return { funnelStageId: p.funnelStageId || cfg.funnelStageId, sellers: p.sellers || cfg.sellers || [] };
}

function missingConfig(cfg, veiculo) {
  const m = [];
  if (!cfg.baseUrl) m.push('baseUrl');
  if (!cfg.auth || !cfg.auth.header) m.push('auth.header');
  if (!cfg.endpoints || !cfg.endpoints.createQuotation) m.push('endpoints.createQuotation');
  ['nome', 'telefone', 'placa'].forEach((k) => { if (!cfg.fieldMap || !cfg.fieldMap[k]) m.push('fieldMap.' + k); });
  const r = resolve(cfg, veiculo);
  if (!r.funnelStageId) m.push(veiculo + ': funnelStageId');
  const active = r.sellers.filter((s) => s.active);
  if (!active.length || active.some((s) => !s.code)) m.push(veiculo + ': sellers[].code');
  return m;
}

// sem argumento: estado geral (health). Com veículo: estado daquele veículo.
function status(veiculo) {
  if (!token()) return { state: 'no_token' };
  const cfg = loadCfg();
  const list = veiculo ? [veiculo] : VEHICLES;
  const missing = list.flatMap((v) => missingConfig(cfg, v));
  if (missing.length) return { state: 'not_configured', missing };
  return { state: process.env.POWERCRM_LIVE === '1' ? 'live' : 'dry-run' };
}

// Rodízio por veículo: alterna entre os vendedores ativos. Contador em .data/ (se não der para gravar, segue em memória).
const memNext = {};
function pickSeller(sellers, veiculo) {
  const active = sellers.filter((s) => s.active);
  let all = {};
  try { all = JSON.parse(fs.readFileSync(RR_PATH, 'utf8')) || {}; } catch (e) { /* primeira vez */ }
  const next = Number.isInteger(all[veiculo]) ? all[veiculo] : (memNext[veiculo] || 0);
  const seller = active[next % active.length];
  memNext[veiculo] = next + 1;
  all[veiculo] = next + 1;
  try { fs.mkdirSync(RR_DIR, { recursive: true }); fs.writeFileSync(RR_PATH, JSON.stringify(all)); } catch (e) { /* ok */ }
  return seller;
}

function buildBody(cfg, lead, seller, stageId) {
  const f = cfg.fieldMap, body = {};
  const put = (k, v) => { if (f[k] && v != null && v !== '') body[f[k]] = v; };
  put('nome', lead.nome);
  put('telefone', lead.telefone);
  put('placa', lead.placa);
  put('veiculo', lead.veiculo);
  put('origem', cfg.origin);
  put('subOrigem', [lead.veiculo, [lead.utm_source, lead.utm_campaign].filter(Boolean).join(' / ') || 'orgânico/direto'].join(' · '));
  put('etapa', stageId);
  put('vendedor', seller.code);
  put('observacao', 'Lead da landing page /' + lead.veiculo + 's (cotação pela placa)' + (lead.utm_content ? ' · anúncio: ' + lead.utm_content : ''));
  return body;
}

async function post(cfg, body) {
  const t = token();
  const value = cfg.auth.scheme ? cfg.auth.scheme + ' ' + t : t;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/' + cfg.endpoints.createQuotation.replace(/^\/+/, ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', [cfg.auth.header]: value },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('Power CRM respondeu HTTP ' + res.status);
    return res.status;
  } finally { clearTimeout(timer); }
}

// Envia o lead (com até 3 novas tentativas em segundo plano se o CRM falhar). Retorna o estado imediato.
async function sendLead(lead) {
  const veiculo = VEHICLES.includes(lead.veiculo) ? lead.veiculo : 'moto';
  const st = status(veiculo);
  if (st.state === 'no_token' || st.state === 'not_configured') {
    log('lead NÃO enviado ao CRM —', st.state, st.missing ? 'faltando: ' + st.missing.join(', ') : '');
    return st;
  }
  const cfg = loadCfg();
  const r = resolve(cfg, veiculo);
  const seller = pickSeller(r.sellers, veiculo);
  const body = buildBody(cfg, Object.assign({}, lead, { veiculo }), seller, r.funnelStageId);

  if (st.state === 'dry-run') {
    log('DRY-RUN (nada foi enviado) · ' + veiculo + ' · vendedor:', seller.name, '· corpo:', body);
    return { state: 'dry-run', seller: seller.name };
  }
  const delays = [0, 5000, 30000, 120000];
  const attempt = async (i) => {
    try { const code = await post(cfg, body); log('enviado · ' + veiculo + ' · vendedor:', seller.name, '· HTTP', code); return true; }
    catch (e) {
      log('falha (tentativa ' + (i + 1) + '/' + delays.length + '):', e.name === 'AbortError' ? 'timeout' : e.message);
      if (i + 1 < delays.length) setTimeout(() => attempt(i + 1), delays[i + 1]);
      return false;
    }
  };
  const ok = await attempt(0);
  return { state: ok ? 'sent' : 'retrying', seller: seller.name };
}

module.exports = { sendLead, status };
