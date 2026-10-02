'use strict';
/*
  Cliente da Z-API (WhatsApp) — SOMENTE no servidor. Credenciais por variável de ambiente (nunca no repo):
    ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN
  ZAPI_BASE_URL só existe pra teste automatizado apontar pra uma Z-API falsa (nunca usado em produção).
*/
const BASE = () => (process.env.ZAPI_BASE_URL || 'https://api.z-api.io').replace(/\/+$/, '');

function configured() {
  return !!(process.env.ZAPI_INSTANCE_ID && process.env.ZAPI_TOKEN && process.env.ZAPI_CLIENT_TOKEN);
}

const redact = (s) => {
  let t = String(s);
  for (const k of [process.env.ZAPI_INSTANCE_ID, process.env.ZAPI_TOKEN, process.env.ZAPI_CLIENT_TOKEN]) if (k) t = t.split(k).join('[REDACTED]');
  return t;
};

async function call(method, endpoint, body) {
  const url = BASE() + '/instances/' + encodeURIComponent(process.env.ZAPI_INSTANCE_ID) + '/token/' + encodeURIComponent(process.env.ZAPI_TOKEN) + '/' + endpoint;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Client-Token': process.env.ZAPI_CLIENT_TOKEN, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const text = await res.text();
    let data = {}; try { data = JSON.parse(text); } catch (e) { /* resposta não-JSON */ }
    return { ok: res.ok, status: res.status, data, raw: redact(text).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, data: {}, raw: redact(e.message || 'network_error') };
  } finally { clearTimeout(timer); }
}

// o WhatsApp está conectado na instância? (pra mostrar no painel e pausar o disparo se cair)
async function status() {
  if (!configured()) return { configured: false, connected: false };
  const r = await call('GET', 'status');
  if (!r.ok) return { configured: true, connected: false, error: 'http_' + r.status };
  return { configured: true, connected: !!r.data.connected, error: r.data.error ? String(r.data.error).slice(0, 120) : undefined };
}

// envia 1 mensagem: só texto, ou foto/vídeo (com a mensagem como legenda)
async function send({ phone, message, mediaUrl, mediaType }) {
  if (!configured()) return { ok: false, notConfigured: true, error: 'not_configured' };
  let r;
  if (mediaUrl && mediaType === 'image') r = await call('POST', 'send-image', { phone, image: mediaUrl, caption: message || '' });
  else if (mediaUrl && mediaType === 'video') r = await call('POST', 'send-video', { phone, video: mediaUrl, caption: message || '' });
  else r = await call('POST', 'send-text', { phone, message });
  if (r.ok && (r.data.zaapId || r.data.messageId || r.data.id)) return { ok: true, id: String(r.data.zaapId || r.data.messageId || r.data.id) };
  const detail = (r.data && (r.data.error || r.data.message)) || r.raw || ('http_' + r.status);
  const disconnected = /not connected|disconnect|desconect|offline/i.test(String(detail));
  return { ok: false, disconnected, error: String(detail).slice(0, 200) };
}

module.exports = { configured, status, send };
