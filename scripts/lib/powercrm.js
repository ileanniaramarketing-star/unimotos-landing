'use strict';
/*
  Integração com o Power CRM — roda SÓ no servidor.
  Endpoint (validado com uma cotação de teste real): POST {baseUrl}/api/quotation/add  (Authorization: Bearer <token>)
  A cotação entra sozinha na coluna "Cotação Recebida" do funil, atribuída ao consultor do PowerLink (slsmnNwId).

  O token vem de process.env.POWERCRM_TOKEN (cofre local via scripts/vault.ps1, ou variável de
  ambiente do painel da hospedagem). Ele nunca é enviado ao navegador, nunca é logado.

  Modos (ver /api/health):
    no_token        sem POWERCRM_TOKEN: não envia nada
    not_configured  falta preencher config/powercrm.json (consultores com PowerLink, cidade padrão…)
    dry-run         tudo configurado, mas POWERCRM_LIVE != 1: só registra o que enviaria (padrão local)
    live            POWERCRM_LIVE=1: envia de verdade
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

// "5531987654321" -> "(31) 98765-4321" (mesmo formato que o Power CRM mostra)
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
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Power CRM respondeu HTTP ' + res.status);
    // devolve os códigos da cotação/negociação (pra guardar no painel e depois conferir se foi vendido)
    return { status: res.status, quotationCode: json.quotationCode || null, negotiationCode: json.negotiationCode || null };
  } finally { clearTimeout(timer); }
}

// Decide o vendedor (rodízio, local e instantâneo) e devolve JÁ o resultado, SEM esperar o Power
// CRM responder — é o que permite ao navegador abrir o WhatsApp do vendedor certo sem o cliente
// ficar esperando a chamada de rede pro CRM (que pode demorar ou até falhar/repetir).
// O envio de verdade ao CRM (com até 3 novas tentativas em segundo plano) roda por conta própria.
// opts.onFinal(status, seller) é chamado sempre que o estado do envio muda DEPOIS do retorno
// síncrono ('sent', 'retrying' ao tentar de novo, ou 'failed' quando esgotam as tentativas) —
// é o que alimenta o painel de leads (/painel), para o status não ficar "pendente" para sempre.
async function sendLead(lead, opts) {
  opts = opts || {};
  const veiculo = VEHICLES.includes(lead.veiculo) ? lead.veiculo : 'moto';
  const st = status(veiculo);
  if (st.state === 'no_token' || st.state === 'not_configured') {
    log('lead NÃO enviado ao CRM —', st.state, st.missing ? 'faltando: ' + st.missing.join(', ') : '');
    return st;
  }
  const cfg = loadCfg();
  const r = resolve(cfg, veiculo);
  const seller = await pickSeller(r.sellers, veiculo);
  const body = buildBody(cfg, Object.assign({}, lead, { veiculo }), seller, r);
  const contact = { seller: seller.name, whatsapp: seller.whatsapp || null };

  if (st.state === 'dry-run') {
    log('DRY-RUN (nada foi enviado) · ' + veiculo + ' · consultor:', seller.name, '· corpo:', body);
    return Object.assign({ state: 'dry-run' }, contact);
  }
  const delays = [0, 5000, 30000, 120000];
  const attempt = async (i) => {
    try {
      const resp = await post(cfg, body);
      log('enviado · ' + veiculo + ' · consultor:', seller.name, '· HTTP', resp.status, '· cotação:', resp.quotationCode);
      if (i > 0 && opts.onFinal) opts.onFinal('sent', seller.name, { quotationCode: resp.quotationCode, negotiationCode: resp.negotiationCode });
      return { ok: true, resp };
    } catch (e) {
      log('falha (tentativa ' + (i + 1) + '/' + delays.length + '):', e.name === 'AbortError' ? 'timeout' : e.message);
      if (i + 1 < delays.length) { if (i > 0 && opts.onFinal) opts.onFinal('retrying', seller.name); setTimeout(() => attempt(i + 1), delays[i + 1]); }
      else if (opts.onFinal) opts.onFinal('failed', seller.name);
      return { ok: false };
    }
  };
  // espera SÓ a 1ª tentativa (uma chamada de rede) antes de responder: em hospedagens que podem
  // encerrar o processo logo após a resposta (ex.: serverless), um envio deixado "em segundo plano"
  // corre risco de nunca terminar, e o lead fica pendente pra sempre sem erro nenhum no log — foi o
  // que aconteceu de verdade em produção (2026-09-30). O vendedor já foi decidido antes (rápido, sem
  // rede), então o WhatsApp continua abrindo rápido — só a confirmação do CRM espera essa 1ª chamada.
  // Se ela falhar, as tentativas seguintes continuam em segundo plano (onFinal cobre esse caso).
  const first = await attempt(0);
  if (first.ok) return Object.assign({ state: 'sent', quotationCode: first.resp.quotationCode, negotiationCode: first.resp.negotiationCode }, contact);
  return Object.assign({ state: 'retrying' }, contact);
}

module.exports = { sendLead, status, maskPhone, originFor, classifyOrigin };
