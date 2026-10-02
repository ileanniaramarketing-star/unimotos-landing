'use strict';
/*
  Disparo em massa (aba "Disparos" do /painel) — SOMENTE no servidor.

  - Campanhas e destinatários ficam no Supabase (public.disparos / public.disparo_destinatarios), então
    sobrevivem a deploy/reinício da hospedagem. A fila é o próprio banco: um único "trabalhador" (tick a
    cada 2 s) pega o próximo destinatário pendente da campanha mais antiga que esteja "rodando", envia
    pela Z-API e espera um intervalo ALEATÓRIO (entre intervaloMin e intervaloMax) antes do próximo.
  - Regras anti-bloqueio: intervalo mínimo (DISPARO_MIN_SECONDS, padrão 10 s), limite diário
    (DISPARO_LIMITE_DIARIO, padrão 500), pausa automática se o WhatsApp desconectar ou se 5 envios
    seguidos falharem. Nunca reenvia sozinho: se o servidor caiu no meio de um envio, aquele contato
    fica "falhou (interrompido)" — melhor não mandar em dobro do que arriscar o número.
  - Mídia (foto/vídeo) vai pro Storage do Supabase (bucket público "disparos", nome aleatório) e a
    Z-API recebe só o link.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zapi = require('./zapi');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG_PATH = process.env.SUPABASE_CONFIG || path.join(ROOT, 'config', 'supabase.json');
const T_CAMP = process.env.SUPABASE_DISPARO_TABLE || 'disparos';              // testes usam "disparos_test"
const T_DEST = process.env.SUPABASE_DISPARO_DEST_TABLE || 'disparo_destinatarios'; // e "disparo_destinatarios_test"
const BUCKET = 'disparos';
const key = () => process.env.SUPABASE_SERVICE_KEY || '';
const minSeconds = () => { const n = Number(process.env.DISPARO_MIN_SECONDS); return Number.isFinite(n) && process.env.DISPARO_MIN_SECONDS !== undefined && process.env.DISPARO_MIN_SECONDS !== '' ? n : 10; };
const dailyLimit = () => Number(process.env.DISPARO_LIMITE_DIARIO) || 500;

const MAX_RECIPIENTS = 5000;
const MAX_MESSAGE = 4000;
const MEDIA = { 'image/jpeg': { ext: 'jpg', type: 'image', max: 5 * 1024 * 1024 }, 'image/png': { ext: 'png', type: 'image', max: 5 * 1024 * 1024 }, 'image/webp': { ext: 'webp', type: 'image', max: 5 * 1024 * 1024 }, 'video/mp4': { ext: 'mp4', type: 'video', max: 16 * 1024 * 1024 } };

const redact = (s) => { const k = key(); return k ? String(s).split(k).join('[REDACTED]') : String(s); };
const log = (...a) => console.error('[disparo]', ...a.map((x) => redact(typeof x === 'string' ? x : JSON.stringify(x))));
function baseUrl() { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')).url.replace(/\/+$/, ''); }

async function sb(p, opts) {
  opts = opts || {};
  const k = key();
  const headers = Object.assign({ apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, opts.headers || {});
  const res = await fetch(baseUrl() + '/rest/v1' + p, { method: opts.method || 'GET', headers, body: opts.body });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('Supabase HTTP ' + res.status + ': ' + t.slice(0, 300)); }
  return res;
}

/* ---------------- telefone e variáveis ---------------- */

// -> "55DDNNNNNNNNN" (só dígitos) ou null se não parecer um celular/fixo brasileiro
function normalizePhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (!(d.length === 12 || d.length === 13) || !d.startsWith('55')) return null;
  const ddd = Number(d.slice(2, 4));
  if (ddd < 11 || ddd > 99) return null;
  return d;
}

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');

// {nome}, {primeiro_nome} e qualquer coluna extra da lista ({cidade}, {placa}…); variável desconhecida some
function render(template, row) {
  const nome = String((row && row.nome) || '').trim();
  const vars = Object.assign({}, (row && row.vars) || {}, { nome, primeiro_nome: nome.split(/\s+/)[0] || '' });
  return String(template || '').replace(/\{\s*([^{}]+?)\s*\}/g, (m, k) => { const v = vars[norm(k)]; return v == null ? '' : String(v); }).replace(/[ \t]+\n/g, '\n').trim();
}

function cleanVars(v) {
  const out = {};
  if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { const nk = norm(k); if (nk && nk !== 'nome' && nk !== 'telefone' && out[nk] === undefined) out[nk] = String(val == null ? '' : val).slice(0, 200); }
  return out;
}

function validateConfig(b) {
  const min = Math.max(minSeconds(), Math.floor(Number(b.intervaloMin) || 15));
  const max = Math.max(min, Math.floor(Number(b.intervaloMax) || min));
  if (max > 600) return { error: 'intervalo_invalido' };
  return { min, max };
}

/* ---------------- mídia ---------------- */

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const k = key();
  await fetch(baseUrl() + '/storage/v1/bucket', {
    method: 'POST', headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 20 * 1024 * 1024 })
  }).catch(() => {}); // já existir não é erro
  bucketReady = true;
}

// base64 -> Storage; devolve { url, tipo }
async function uploadMedia(contentType, dataBase64) {
  const spec = MEDIA[String(contentType || '').toLowerCase()];
  if (!spec) return { error: 'tipo_nao_suportado' };
  const buf = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!buf.length) return { error: 'arquivo_vazio' };
  if (buf.length > spec.max) return { error: 'arquivo_grande' };
  await ensureBucket();
  const name = crypto.randomUUID() + '.' + spec.ext;
  const k = key();
  const res = await fetch(baseUrl() + '/storage/v1/object/' + BUCKET + '/' + name, {
    method: 'POST', headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': contentType, 'x-upsert': 'false' }, body: buf
  });
  if (!res.ok) { log('upload falhou', res.status, await res.text().catch(() => '')); return { error: 'upload_falhou' }; }
  return { url: baseUrl() + '/storage/v1/object/public/' + BUCKET + '/' + name, tipo: spec.type };
}

// só aceita mídia que veio do NOSSO bucket (impede apontar a Z-API pra um link qualquer)
function ownMediaUrl(u) {
  try { return String(u).startsWith(baseUrl() + '/storage/v1/object/public/' + BUCKET + '/'); } catch (e) { return false; }
}

/* ---------------- campanhas ---------------- */

async function createCampaign(b, user) {
  const mensagem = String(b.mensagem || '').trim();
  const nome = String(b.nome || '').trim().slice(0, 120) || 'Disparo ' + new Date().toLocaleDateString('pt-BR');
  const midiaUrl = b.midia && b.midia.url ? String(b.midia.url) : null;
  const midiaTipo = midiaUrl ? (b.midia.tipo === 'video' ? 'video' : 'image') : null;
  if (!mensagem && !midiaUrl) return { status: 400, body: { ok: false, error: 'mensagem_vazia' } };
  if (mensagem.length > MAX_MESSAGE) return { status: 400, body: { ok: false, error: 'mensagem_longa' } };
  if (midiaUrl && !ownMediaUrl(midiaUrl)) return { status: 400, body: { ok: false, error: 'midia_invalida' } };
  const cfg = validateConfig(b);
  if (cfg.error) return { status: 400, body: { ok: false, error: cfg.error } };
  const list = Array.isArray(b.destinatarios) ? b.destinatarios : [];
  if (!list.length) return { status: 400, body: { ok: false, error: 'lista_vazia' } };
  if (list.length > MAX_RECIPIENTS) return { status: 413, body: { ok: false, error: 'lista_grande', max: MAX_RECIPIENTS } };

  const seen = new Set(); const rows = []; let invalidos = 0, duplicados = 0;
  for (const d of list) {
    const tel = normalizePhone(d && d.telefone);
    if (!tel) { invalidos++; continue; }
    if (seen.has(tel)) { duplicados++; continue; }
    seen.add(tel);
    rows.push({ ordem: rows.length, nome: String((d && d.nome) || '').trim().slice(0, 120) || null, telefone: tel, vars: cleanVars(d && d.vars) });
  }
  if (!rows.length) return { status: 400, body: { ok: false, error: 'nenhum_telefone_valido', invalidos } };

  const res = await sb('/' + T_CAMP, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({
    criado_por: user || null, nome, mensagem, midia_url: midiaUrl, midia_tipo: midiaTipo,
    intervalo_min: cfg.min, intervalo_max: cfg.max, total: rows.length, status: 'rodando'
  }) });
  const camp = (await res.json())[0];
  for (let i = 0; i < rows.length; i += 500) {
    await sb('/' + T_DEST, { method: 'POST', body: JSON.stringify(rows.slice(i, i + 500).map((r) => Object.assign({ disparo_id: camp.id }, r))) });
  }
  kick();
  return { status: 200, body: { ok: true, id: camp.id, total: rows.length, invalidos, duplicados } };
}

const campOut = (c) => ({
  id: c.id, criadoEm: c.criado_em, criadoPor: c.criado_por, nome: c.nome, mensagem: c.mensagem, midiaTipo: c.midia_tipo || null,
  intervaloMin: c.intervalo_min, intervaloMax: c.intervalo_max, status: c.status, motivo: c.motivo || null,
  total: c.total, enviados: c.enviados, falhas: c.falhas, restantes: Math.max(0, c.total - c.enviados - c.falhas)
});

async function listCampaigns() {
  const rows = await (await sb('/' + T_CAMP + '?select=*&order=criado_em.desc&limit=50')).json();
  return rows.map(campOut);
}

async function getCampaign(id, status) {
  const c = (await (await sb('/' + T_CAMP + '?id=eq.' + encodeURIComponent(id) + '&select=*')).json())[0];
  if (!c) return null;
  let q = '/' + T_DEST + '?disparo_id=eq.' + encodeURIComponent(id) + '&select=ordem,nome,telefone,status,erro,enviado_em&order=ordem.asc&limit=500';
  if (status && /^[a-z]+$/.test(status)) q += '&status=eq.' + status;
  const dest = await (await sb(q)).json();
  return Object.assign(campOut(c), { destinatarios: dest.map((d) => ({ nome: d.nome, telefone: d.telefone, status: d.status, erro: d.erro || null, enviadoEm: d.enviado_em || null })) });
}

async function setStatus(id, from, to, motivo) {
  const res = await sb('/' + T_CAMP + '?id=eq.' + encodeURIComponent(id) + '&status=in.(' + from.join(',') + ')', {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: to, motivo: motivo || null })
  });
  const rows = await res.json();
  if (to === 'rodando') kick();
  return rows.length > 0;
}
const pause = (id) => setStatus(id, ['rodando'], 'pausado');
const resume = (id) => setStatus(id, ['pausado'], 'rodando');
const cancel = (id) => setStatus(id, ['rodando', 'pausado'], 'cancelado');

/* ---------------- envio de teste (1 mensagem, fora da fila) ---------------- */

async function sendTest(b) {
  const tel = normalizePhone(b.telefone);
  if (!tel) return { status: 400, body: { ok: false, error: 'telefone_invalido' } };
  const mensagem = render(String(b.mensagem || ''), { nome: b.nome || 'Cliente', vars: cleanVars(b.vars) });
  const midiaUrl = b.midia && b.midia.url && ownMediaUrl(b.midia.url) ? String(b.midia.url) : null;
  if (!mensagem && !midiaUrl) return { status: 400, body: { ok: false, error: 'mensagem_vazia' } };
  if (!zapi.configured()) return { status: 503, body: { ok: false, error: 'not_configured' } };
  const r = await zapi.send({ phone: tel, message: mensagem, mediaUrl: midiaUrl, mediaType: b.midia && b.midia.tipo });
  return r.ok ? { status: 200, body: { ok: true } } : { status: 502, body: { ok: false, error: 'envio_falhou', detalhe: r.error } };
}

/* ---------------- trabalhador (fila) ---------------- */

let busy = false, nextAt = 0, failStreak = 0, timer = null;
const rand = (a, b) => (a + Math.random() * (b - a)) * 1000;

// início do dia de hoje no horário de Brasília (UTC-3), em ISO
function startOfTodayBRT() {
  const n = new Date(Date.now() - 3 * 3600e3);
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + 3 * 3600e3).toISOString();
}

async function bump(id, field) {
  const c = (await (await sb('/' + T_CAMP + '?id=eq.' + encodeURIComponent(id) + '&select=' + field)).json())[0];
  if (c) await sb('/' + T_CAMP + '?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ [field]: (c[field] || 0) + 1 }) });
}

async function tick() {
  if (busy || Date.now() < nextAt || !zapi.configured() || !key()) return;
  busy = true;
  try {
    const camps = await (await sb('/' + T_CAMP + '?status=eq.rodando&select=*&order=criado_em.asc&limit=1')).json();
    const camp = camps[0];
    if (!camp) return;

    // limite diário (protege o número): sem enviar até virar o dia
    const cnt = await sb('/' + T_DEST + '?status=eq.enviado&enviado_em=gte.' + encodeURIComponent(startOfTodayBRT()) + '&select=id', { headers: { Prefer: 'count=exact', Range: '0-0' } });
    const sentToday = Number((cnt.headers.get('content-range') || '').split('/')[1]) || 0;
    if (sentToday >= dailyLimit()) { nextAt = Date.now() + 60000; return; }

    const next = (await (await sb('/' + T_DEST + '?disparo_id=eq.' + camp.id + '&status=eq.pendente&select=*&order=ordem.asc&limit=1')).json())[0];
    if (!next) { await setStatus(camp.id, ['rodando'], 'concluido'); return; }

    // "reserva" o contato antes de enviar (nunca dois envios pro mesmo)
    const claimed = await (await sb('/' + T_DEST + '?id=eq.' + next.id + '&status=eq.pendente', {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'enviando' })
    })).json();
    if (!claimed.length) return;

    const r = await zapi.send({ phone: next.telefone, message: render(camp.mensagem, next), mediaUrl: camp.midia_url, mediaType: camp.midia_tipo });
    if (r.ok) {
      failStreak = 0;
      await sb('/' + T_DEST + '?id=eq.' + next.id, { method: 'PATCH', body: JSON.stringify({ status: 'enviado', enviado_em: new Date().toISOString(), zaap_id: r.id }) });
      await bump(camp.id, 'enviados');
    } else if (r.disconnected) {
      // WhatsApp caiu: devolve o contato pra fila e pausa a campanha
      await sb('/' + T_DEST + '?id=eq.' + next.id, { method: 'PATCH', body: JSON.stringify({ status: 'pendente' }) });
      await setStatus(camp.id, ['rodando'], 'pausado', 'WhatsApp desconectado na Z-API. Reconecte e retome.');
      return;
    } else {
      failStreak++;
      await sb('/' + T_DEST + '?id=eq.' + next.id, { method: 'PATCH', body: JSON.stringify({ status: 'falhou', erro: r.error || 'erro' }) });
      await bump(camp.id, 'falhas');
      if (failStreak >= 5) { failStreak = 0; await setStatus(camp.id, ['rodando'], 'pausado', '5 envios seguidos falharam. Confira a Z-API e retome.'); return; }
    }
    nextAt = Date.now() + rand(camp.intervalo_min, camp.intervalo_max);
  } catch (e) {
    log('tick:', e.message);
    nextAt = Date.now() + 10000;
  } finally { busy = false; }
}

function kick() { if (timer) setImmediate(() => tick().catch(() => {})); }

// ao ligar o servidor: quem estava "enviando" quando ele caiu vira "falhou (interrompido)" — nunca reenvia
async function recover() {
  const rows = await (await sb('/' + T_DEST + '?status=eq.enviando&select=id,disparo_id', {})).json();
  for (const r of rows) {
    await sb('/' + T_DEST + '?id=eq.' + r.id, { method: 'PATCH', body: JSON.stringify({ status: 'falhou', erro: 'interrompido (servidor reiniciou durante o envio) — confira no WhatsApp antes de reenviar' }) });
    await bump(r.disparo_id, 'falhas');
  }
}

function start() {
  if (timer || !key()) return;
  recover().catch((e) => log('recover:', e.message)).finally(() => {
    nextAt = Date.now() + 5000;
    timer = setInterval(() => { tick().catch(() => {}); }, 2000);
    if (timer.unref) timer.unref();
  });
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { normalizePhone, render, cleanVars, uploadMedia, createCampaign, listCampaigns, getCampaign, pause, resume, cancel, sendTest, start, stop, MAX_RECIPIENTS };
