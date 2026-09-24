'use strict';
/* Validação, anti-abuso e encaminhamento dos leads da landing page (servidor). */
const { sendLead } = require('./powercrm');

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 6;           // envios por IP a cada 10 min
const DEDUPE_MS = 15 * 60 * 1000;
const hits = new Map();       // ip -> [timestamps]
const recent = new Map();     // telefone|placa -> timestamp

const PLATE = /^[A-Z]{3}[0-9]{4}$|^[A-Z]{3}[0-9][A-Z][0-9]{2}$/;
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

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
  UTM_KEYS.forEach((k) => { if (input[k]) lead[k] = clean(input[k], 100); });
  return { errors, lead };
}

async function processLead(input, meta) {
  if (!input || typeof input !== 'object') return { status: 400, body: { ok: false, error: 'invalid' } };
  if (input.website) return { status: 200, body: { ok: true } }; // honeypot: robô preencheu, descarta em silêncio

  const { errors, lead } = validate(input);
  if (errors.length) return { status: 400, body: { ok: false, error: 'invalid', fields: errors } };
  if (rateLimited(meta.ip)) return { status: 429, body: { ok: false, error: 'rate_limited' } };

  const key = lead.veiculo + '|' + lead.telefone + '|' + lead.placa;
  const last = recent.get(key);
  if (last && Date.now() - last < DEDUPE_MS) return { status: 200, body: { ok: true, duplicate: true } };
  recent.set(key, Date.now());

  try { await sendLead(lead); } catch (e) { console.error('[lead] erro inesperado ao enviar ao CRM:', e.message); }
  return { status: 200, body: { ok: true } }; // o navegador nunca vê detalhes do CRM
}

module.exports = { processLead, validate, normPhone };
