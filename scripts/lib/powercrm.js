'use strict';
/*
  Integração com o Power CRM.

  O ENVIO DE VERDADE (a chamada de rede pro Power CRM) roda no SUPABASE, não aqui — uma Edge
  Function (supabase/functions/send-lead/) é acionada sozinha por um Database Webhook assim que um
  lead é gravado com status "pendente". Isso existe porque a hospedagem (Hostinger) pode encerrar o
  processo logo depois de responder ao navegador, e um envio deixado "em segundo plano" aqui corria
  risco de ser interrompido no meio sem erro nenhum (aconteceu de verdade em produção, 2026-09-30) —
  o Supabase não tem essa limitação.

  Esse arquivo, então, só: decide o VENDEDOR (rodízio, local e instantâneo, lendo contagens do
  Supabase) e simula o corpo da requisição em modo DRY-RUN (local, sem rede — só pra log/depuração).
  O token do Power CRM (POWERCRM_TOKEN) continua existindo aqui só pra alimentar o /api/health e o
  dry-run; quem usa o token pra mandar de verdade é o Supabase (secret próprio dele, configurado
  separado — ver supabase/functions/send-lead/README.md).

  Modos (ver /api/health):
    no_token        sem POWERCRM_TOKEN: não envia nada
    not_configured  falta preencher config/powercrm.json (consultores com PowerLink, cidade padrão…)
    dry-run         tudo configurado, mas POWERCRM_LIVE != 1: só registra o que enviaria (padrão local)
    live            POWERCRM_LIVE=1: o Supabase envia de verdade (ver acima)
*/
const fs = require('fs');
const path = require('path');
const store = require('./store');

const ROOT = path.resolve(__dirname, '..', '..');
// POWERCRM_CONFIG existe só para testes automatizados
const CFG_PATH = process.env.POWERCRM_CONFIG || path.join(ROOT, 'config', 'powercrm.json');
const VEHICLES = ['moto', 'carro'];

const loadCfg = () => JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const token = () => process.env.POWERCRM_TOKEN || '';

// remove o token de qualquer texto antes de logar
const redact = (s) => { const t = token(); return t ? String(s).split(t).join('[REDACTED]') : String(s); };
const log = (...a) => console.log('[powercrm]', ...a.map((x) => redact(typeof x === 'string' ? x : JSON.stringify(x))));

// consultores/coop efetivos de um veículo (o bloco do produto sobrepõe o global)
function resolve(cfg, veiculo) {
  const p = (cfg.products && cfg.products[veiculo]) || {};
  const d = cfg.defaults || {};
  return { sellers: p.sellers || cfg.sellers || [], coop: p.coop != null ? p.coop : d.coop, cityId: p.cityId || d.cityId };
}

function missingConfig(cfg, veiculo) {
  const m = [];
  if (!cfg.baseUrl) m.push('baseUrl');
  if (!cfg.auth || !cfg.auth.header) m.push('auth.header');
  if (!cfg.endpoints || !cfg.endpoints.createQuotation) m.push('endpoints.createQuotation');
  const r = resolve(cfg, veiculo);
  if (!r.cityId) m.push(veiculo + ': defaults.cityId');
  const active = r.sellers.filter((s) => s.active);
  if (!active.length || active.some((s) => !s.code)) m.push(veiculo + ': sellers[].code (PowerLink do consultor)');
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

// Rodízio por veículo: sorteia o consultor ativo com MENOS leads daquele veículo até agora, lendo
// do banco (Supabase) — sobrevive a qualquer reinício/deploy, diferente de um contador em arquivo
// local. Empate (inclusive "todos em zero", o caso mais comum) é resolvido por sorteio aleatório —
// assim mesmo logo depois de um reinício o primeiro lead não cai sempre no mesmo vendedor.
async function pickSeller(sellers, veiculo) {
  const active = sellers.filter((s) => s.active);
  if (active.length <= 1) return active[0];
  let counts = {};
  try { counts = await store.countsBySeller(veiculo); } catch (e) { log('rodízio: não consegui ler o banco, sorteando aleatório entre todos:', e.message); }
  const min = Math.min(...active.map((s) => counts[s.name] || 0));
  const leastLoaded = active.filter((s) => (counts[s.name] || 0) === min);
  return leastLoaded[Math.floor(Math.random() * leastLoaded.length)];
}

// "5531987654321" -> "(31) 98765-4321" (mesmo formato que o Power CRM mostra) — usado só no dry-run
// local (a Edge Function no Supabase tem sua própria cópia, é ela quem monta o corpo de verdade)
function maskPhone(e164) {
  let d = String(e164 || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  const ddd = d.slice(0, 2), n = d.slice(2);
  return '(' + ddd + ') ' + (n.length === 9 ? n.slice(0, 5) + '-' + n.slice(5) : n.slice(0, 4) + '-' + n.slice(4));
}

// origem da cotação no CRM a partir da fonte do tráfego (utm_source)
function originFor(cfg, lead) {
  const o = cfg.origins || {};
  const src = String(lead.utm_source || '').toLowerCase();
  if (/insta|face|meta|^fb$|^ig$/.test(src) && o.social) return o.social;
  if (/google|gads|adwords/.test(src) && o.google) return o.google;
  return o.default;
}

// mesma classificação, mas em nome legível (para o painel de leads, não para o Power CRM)
function classifyOrigin(lead) {
  const src = String(lead.utm_source || '').toLowerCase();
  if (/insta|face|meta|^fb$|^ig$/.test(src)) return 'REDES SOCIAIS';
  if (/google|gads|adwords/.test(src)) return 'GOOGLE';
  return 'SITE';
}

// corpo que SERIA mandado ao Power CRM — usado só pro log do dry-run local (a Edge Function no
// Supabase monta o corpo de verdade sozinha, com sua própria cópia desta mesma lógica)
function buildBody(cfg, lead, seller, r) {
  const body = {
    name: lead.nome,
    phone: maskPhone(lead.telefone),
    plts: lead.placa,
    city: r.cityId,
    origemId: originFor(cfg, lead),
    slsmnNwId: seller.code,       // PowerLink do consultor = quem recebe o lead
    workVehicle: false
  };
  if (r.coop != null) body.coop = r.coop;      // cooperativa/filial (ex.: CLUB-UNIMOTOS.CAR), se configurada
  if (lead.email) body.email = lead.email;     // o formulário da LP não pede e-mail; entra só se existir
  if (lead.marca_id) body.mdl = lead.marca_id; // reservado: preenchimento por consulta de placa
  return body;
}

// Decide o vendedor (rodízio, local e instantâneo) e devolve — é o que permite ao navegador abrir
// o WhatsApp do vendedor certo sem esperar rede nenhuma. Em modo "live", NÃO manda ao Power CRM
// daqui (ver comentário no topo do arquivo): só devolve o vendedor decidido, pra quem chamou gravar
// o lead já com o status "pendente" + vendedor — a partir daí o Supabase cuida do envio sozinho.
async function sendLead(lead) {
  const veiculo = VEHICLES.includes(lead.veiculo) ? lead.veiculo : 'moto';
  const st = status(veiculo);
  if (st.state === 'no_token' || st.state === 'not_configured') {
    log('lead NÃO será enviado ao CRM —', st.state, st.missing ? 'faltando: ' + st.missing.join(', ') : '');
    return st;
  }
  const cfg = loadCfg();
  const r = resolve(cfg, veiculo);
  const seller = await pickSeller(r.sellers, veiculo);
  const contact = { seller: seller.name, whatsapp: seller.whatsapp || null };

  if (st.state === 'dry-run') {
    const body = buildBody(cfg, Object.assign({}, lead, { veiculo }), seller, r);
    log('DRY-RUN (nada foi/será enviado) · ' + veiculo + ' · consultor:', seller.name, '· corpo:', body);
    return Object.assign({ state: 'dry-run' }, contact);
  }
  return Object.assign({ state: 'pendente' }, contact); // o Supabase assume a partir daqui
}

module.exports = { sendLead, status, maskPhone, originFor, classifyOrigin, buildBody, resolve };
