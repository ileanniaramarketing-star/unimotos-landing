'use strict';
/* Recebe o evento de PageView do navegador e repassa pro Meta Conversions API (servidor).
   Bem mais permissivo que o /api/lead (é só navegação normal, não uma conversão). */
const metacapi = require('./metacapi');

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 120;          // bem mais generoso que o de lead: várias páginas por visita
const hits = new Map();        // ip -> [timestamps]

const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  return list.length > RATE_MAX;
}

async function processPageView(input, meta) {
  if (!input || typeof input !== 'object') return { status: 400, body: { ok: false } };
  if (rateLimited(meta.ip)) return { status: 429, body: { ok: false, error: 'rate_limited' } };

  const data = {
    eventId: clean(input.eventId, 100),
    pagina: clean(input.pagina, 200),
    ip: meta.ip,
    userAgent: meta.userAgent
  };
  if (input.fbp) data.fbp = clean(input.fbp, 100);
  if (input.fbc) data.fbc = clean(input.fbc, 100);

  metacapi.sendPageViewEvent(data).catch(() => {});
  return { status: 200, body: { ok: true } };
}

module.exports = { processPageView };
