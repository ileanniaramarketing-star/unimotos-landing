'use strict';
/*
  Meta Conversions API (Facebook/Instagram Ads) — roda SÓ no servidor.
  Manda o evento "Lead" pro MESMO pixel do navegador (config/meta.json -> pixelId), com o MESMO
  eventId que o navegador usa no fbq('track', 'Lead', ..., {eventID}) — assim o Meta entende que é
  o MESMO evento visto de dois jeitos (pixel + servidor) e não conta em dobro (deduplicação oficial).

  Só dispara depois que o lead É ACEITO de verdade pelo nosso servidor (processLead) — nunca antes,
  e nunca para duplicados. O token vem de process.env.META_CAPI_TOKEN (cofre local ou variável de
  ambiente da hospedagem). Nunca é enviado ao navegador, nunca é logado.

  Dados do cliente (telefone) vão sempre em hash SHA-256 (exigência do Meta para PII em user_data).
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG_PATH = process.env.META_CONFIG || path.join(ROOT, 'config', 'meta.json');
const token = () => process.env.META_CAPI_TOKEN || '';

const redact = (s) => { const t = token(); return t ? String(s).split(t).join('[REDACTED]') : String(s); };
const log = (...a) => console.log('[metacapi]', ...a.map((x) => redact(typeof x === 'string' ? x : JSON.stringify(x))));

function configured() {
  if (!token()) return false;
  try { const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); return !!c.pixelId; } catch (e) { return false; }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s || '').trim().toLowerCase()).digest('hex');

// "5531988887777" -> hash (Meta exige telefone em dígitos, com DDI, sem "+", em SHA-256)
function hashPhone(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return digits ? sha256(digits) : undefined;
}

function buildUserData(meta) {
  const userData = {};
  if (meta.phone) { const h = hashPhone(meta.phone); if (h) userData.ph = [h]; }
  if (meta.fbp) userData.fbp = meta.fbp;
  if (meta.fbc) userData.fbc = meta.fbc;
  if (meta.ip) userData.client_ip_address = meta.ip;
  if (meta.userAgent) userData.client_user_agent = meta.userAgent;
  return userData;
}

// manda 1 evento pro Graph API; nunca lança erro (falha de tracking não pode derrubar nada)
async function postEvent(eventName, event) {
  if (!configured()) return; // sem token/pixel configurado: silêncio (não é erro, só não está ligado ainda)
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { return; }

  // baseUrl só existe em config/meta.json pra testes automatizados apontarem pra um Graph API falso
  const url = (cfg.baseUrl || 'https://graph.facebook.com') + '/' + (cfg.apiVersion || 'v21.0') + '/' + cfg.pixelId + '/events?access_token=' + encodeURIComponent(token());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event] }),
      signal: ctrl.signal
    });
    const body = await res.text();
    if (!res.ok) log('Meta respondeu HTTP', res.status, '·', body);
    else log('evento ' + eventName + ' enviado · eventId:', event.event_id);
  } catch (e) {
    log('falha ao enviar evento ' + eventName + ':', e.name === 'AbortError' ? 'timeout' : e.message);
  } finally { clearTimeout(timer); }
}

// dispara "Lead" — só depois que o lead É ACEITO de verdade pelo servidor (processLead), nunca antes,
// e nunca para duplicados.
async function sendLeadEvent(lead, meta) {
  meta = meta || {};
  await postEvent('Lead', {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    event_id: meta.eventId || undefined,        // mesmo id do pixel do navegador -> deduplicação
    event_source_url: lead.pagina || undefined,
    action_source: 'website',
    user_data: buildUserData(Object.assign({ phone: lead.telefone }, meta)),
    custom_data: { content_name: lead.veiculo === 'carro' ? 'Carro' : 'Moto' }
  });
}

// dispara "PageView" — em toda carga de página, espelhando o fbq('track','PageView') do navegador
// (mesmo eventId dos dois lados). Não tem telefone/PII: só sinais do navegador (fbp/fbc/ip/UA).
async function sendPageViewEvent(meta) {
  meta = meta || {};
  await postEvent('PageView', {
    event_name: 'PageView',
    event_time: Math.floor(Date.now() / 1000),
    event_id: meta.eventId || undefined,
    event_source_url: meta.pagina || undefined,
    action_source: 'website',
    user_data: buildUserData(meta)
  });
}

module.exports = { sendLeadEvent, sendPageViewEvent, configured, hashPhone };
