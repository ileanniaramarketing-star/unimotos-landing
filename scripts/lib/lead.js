'use strict';
/* Validação, anti-abuso e encaminhamento dos leads da landing page (servidor). */
const { sendLead, classifyOrigin } = require('./powercrm');
const metacapi = require('./metacapi');
const store = require('./store');

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 6;           // envios por IP a cada 10 min
const DEDUPE_MS = 15 * 60 * 1000;
const hits = new Map();       // ip -> [timestamps]
const recent = new Map();     // veiculo|telefone|placa -> timestamp

const PLATE = /^[A-Z]{3}[0-9]{4}$|^[A-Z]{3}[0-9][A-Z][0-9]{2}$/;
// UTMs + cliques pagos (gclid = Google Ads, fbclid = Meta Ads): vão para o lead e para o painel (/painel)
// act_id (conta de anúncio), utm_id, placement (posicionamento) e keyword (palavra-chave) entram no relatório completo
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'act_id', 'placement', 'keyword', 'gclid', 'fbclid'];

const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return null;
  if (!/^[1-9][1-9]/.test(d)) return null;          // DDD válido
  if (d.length === 11 && d[2] !== '9') return null;  // celular começa com 9
  return '55' + d;
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  return list.length > RATE_MAX;
}

function validate(input) {
  const errors = [];
  const nome = clean(input.nome, 80);
  const telefone = normPhone(input.telefone);
  const placa = String(input.placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (nome.length < 2) errors.push('nome');
  if (!telefone) errors.push('telefone');
  if (!PLATE.test(placa)) errors.push('placa');
  const veiculo = input.veiculo === 'carro' ? 'carro' : 'moto';
  const lead = { tipo: 'cotacao', veiculo, nome, telefone, placa };
  if (input.pagina) lead.pagina = clean(input.pagina, 200);
  UTM_KEYS.forEach((k) => { if (input[k]) lead[k] = clean(input[k], k === 'gclid' || k === 'fbclid' ? 180 : 100); });
  // de onde veio o lead: formulário do site ('site') ou pop-up dos botões de WhatsApp ('whatsapp'),
  // e qual botão abriu o pop-up (cta: hero-wa, final-wa, footer, wa-float…) — pro relatório
  lead.origem_form = input.origem_form === 'whatsapp' ? 'whatsapp' : 'site';
  if (input.cta) lead.cta = clean(input.cta, 40);
  return { errors, lead };
}

// dados só do Meta Pixel/Conversions API (não são UTM, não vão pro painel nem pro Power CRM):
// eventId faz o navegador (fbq) e o servidor (CAPI) reportarem o MESMO evento sem contar em dobro.
function metaTrackingOf(input) {
  const out = {};
  if (input.eventId) out.eventId = clean(input.eventId, 100);
  if (input.fbp) out.fbp = clean(input.fbp, 100);
  if (input.fbc) out.fbc = clean(input.fbc, 100);
  return out;
}

async function processLead(input, meta) {
  if (!input || typeof input !== 'object') return { status: 400, body: { ok: false, error: 'invalid' } };
  if (input.website) return { status: 200, body: { ok: true } }; // honeypot: robô preencheu, descarta em silêncio

  const { errors, lead } = validate(input);
  if (errors.length) return { status: 400, body: { ok: false, error: 'invalid', fields: errors } };
  if (rateLimited(meta.ip)) return { status: 429, body: { ok: false, error: 'rate_limited' } };

  lead.crmOrigin = classifyOrigin(lead); // rótulo p/ o painel (SITE / GOOGLE / REDES SOCIAIS) — não é o que vai ao CRM

  // duplicado (mesmo veículo+telefone+placa numa janela curta): grava pro histórico, mas sem
  // sortear vendedor nem disparar envio nenhum (nem local, nem pelo Supabase)
  const key = lead.veiculo + '|' + lead.telefone + '|' + lead.placa;
  const last = recent.get(key);
  if (last && Date.now() - last < DEDUPE_MS) {
    store.recordCreated(lead, null, 'duplicado').catch((e) => console.error('[lead] erro ao gravar duplicado no Supabase:', e.message));
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  recent.set(key, Date.now());

  // Meta Conversions API: só dispara AGORA que o lead foi de fato aceito (validado, não-duplicado) —
  // nunca antes disso. Não trava a resposta (falha de tracking não pode atrasar/derrubar o lead).
  const mt = metaTrackingOf(input);
  metacapi.sendLeadEvent(lead, Object.assign({ ip: meta.ip, userAgent: meta.userAgent }, mt)).catch(() => {});

  // decide o vendedor (rodízio) ANTES de gravar: precisa ir junto no INSERT, porque é esse INSERT
  // que aciona o envio de verdade ao Power CRM (Supabase, Edge Function "send-lead" via webhook —
  // ver scripts/lib/powercrm.js). O navegador só vê nome/WhatsApp do vendedor — nada mais do CRM.
  let contact = null;
  try { contact = await sendLead(lead); } catch (e) { console.error('[lead] erro ao decidir vendedor:', e.message); }
  try { await store.recordCreated(lead, contact && contact.seller, contact && contact.state); } catch (e) { console.error('[lead] erro ao gravar no Supabase (painel/CRM ficarão sem esse lead):', e.message); }

  return { status: 200, body: { ok: true, seller: (contact && contact.seller) || null, whatsapp: (contact && contact.whatsapp) || null } };
}

module.exports = { processLead, validate, normPhone };
