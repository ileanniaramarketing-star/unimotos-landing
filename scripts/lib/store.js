'use strict';
/*
  Registro dos leads para o painel interno (/painel) — SOMENTE no servidor.

  Guarda no Supabase (tabela public.leads), com a chave de serviço (SUPABASE_SERVICE_KEY, no cofre
  — nunca vai ao navegador). Isso substitui o arquivo local .data/leads.jsonl usado antes: numa
  hospedagem que reconstrói os arquivos a cada deploy/reinício, um arquivo local não sobrevive —
  um banco de verdade sim. A tabela tem RLS ativado sem nenhuma regra: só quem usa a chave de
  serviço consegue ler/escrever (nem a chave "anon" consegue).

  Contém dado pessoal (nome, telefone, placa): é a mesma informação que já vai para o Power CRM,
  guardada aqui só para o painel mostrar. Sem limpeza automática nesta versão (tabela cresce).
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG_PATH = process.env.SUPABASE_CONFIG || path.join(ROOT, 'config', 'supabase.json');
const TABLE = process.env.SUPABASE_LEADS_TABLE || 'leads'; // testes automatizados usam "leads_test"
const key = () => process.env.SUPABASE_SERVICE_KEY || '';

const redact = (s) => { const k = key(); return k ? String(s).split(k).join('[REDACTED]') : String(s); };
const log = (...a) => console.error('[store]', ...a.map((x) => redact(typeof x === 'string' ? x : JSON.stringify(x))));

function loadCfg() { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
function restUrl(p) { return loadCfg().url.replace(/\/+$/, '') + '/rest/v1' + p; }

async function sb(p, opts) {
  opts = opts || {};
  const k = key();
  const headers = Object.assign({ apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, opts.headers || {});
  const res = await fetch(restUrl(p), { method: opts.method || 'GET', headers, body: opts.body });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('Supabase HTTP ' + res.status + ': ' + t); }
  return res;
}

// linha do banco (colunas em português) -> objeto que o resto do código/painel já espera
function fromRow(r) {
  return {
    id: r.id, ts: r.ts, tipo: r.tipo, veiculo: r.veiculo, nome: r.nome, telefone: r.telefone, placa: r.placa,
    utm_source: r.utm_source || undefined, utm_medium: r.utm_medium || undefined, utm_campaign: r.utm_campaign || undefined,
    utm_content: r.utm_content || undefined, utm_term: r.utm_term || undefined, utm_id: r.utm_id || undefined, act_id: r.act_id || undefined,
    placement: r.placement || undefined, keyword: r.keyword || undefined, gclid: r.gclid || undefined, fbclid: r.fbclid || undefined,
    pagina: r.pagina || undefined, crmOrigin: r.crm_origem || undefined, seller: r.vendedor || null, status: r.status,
    statusTs: r.status_ts || undefined, quotationCode: r.crm_quotation_code || undefined, negotiationCode: r.crm_negotiation_code || undefined
  };
}

// Registra o lead JÁ com o vendedor sorteado (se houver) e o status decidido por sendLead()
// (dry-run / pendente / not_configured / no_token / duplicado). O status "pendente" com um
// vendedor preenchido é o que aciona o envio de verdade: um Database Webhook do Supabase dispara
// sozinho a Edge Function "send-lead" assim que essa linha é criada (ver scripts/lib/powercrm.js).
// Devolve o id (uuid) da linha criada.
async function recordCreated(lead, seller, statusValue) {
  const body = {
    tipo: lead.tipo || 'cotacao', veiculo: lead.veiculo, nome: lead.nome, telefone: lead.telefone, placa: lead.placa,
    utm_source: lead.utm_source || null, utm_medium: lead.utm_medium || null, utm_campaign: lead.utm_campaign || null,
    utm_content: lead.utm_content || null, utm_term: lead.utm_term || null, utm_id: lead.utm_id || null, act_id: lead.act_id || null,
    placement: lead.placement || null, keyword: lead.keyword || null, gclid: lead.gclid || null, fbclid: lead.fbclid || null,
    pagina: lead.pagina || null, crm_origem: lead.crmOrigin || null, status: statusValue || 'pendente'
  };
  if (seller) body.vendedor = seller;
  const res = await sb('/' + TABLE + '', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
  const rows = await res.json();
  return rows[0] && rows[0].id;
}

// evento "status": o resultado do envio ao CRM (imediato ou, para retries, mais tarde).
// extra.quotationCode/negotiationCode (só vêm quando status='sent'): código da cotação/negociação
// no Power CRM, guardado pra depois dar pra conferir lá se aquele lead foi vendido ou não.
async function recordStatus(id, status, seller, extra) {
  if (!id) return;
  const body = { status, status_ts: new Date().toISOString() };
  if (seller) body.vendedor = seller;
  if (extra && extra.quotationCode) body.crm_quotation_code = extra.quotationCode;
  if (extra && extra.negotiationCode) body.crm_negotiation_code = extra.negotiationCode;
  await sb('/' + TABLE + '?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(body) });
}

function toIso(ms) { return ms ? new Date(Number(ms)).toISOString() : undefined; }

// lista para a aba "Leads" do painel, com filtros simples
async function listLeads(opts) {
  opts = opts || {};
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 2000);
  const params = ['select=*', 'order=ts.desc', 'limit=' + limit];
  if (opts.veiculo) params.push('veiculo=eq.' + encodeURIComponent(opts.veiculo));
  if (opts.status) params.push('status=eq.' + encodeURIComponent(opts.status));
  const from = toIso(opts.from), to = toIso(opts.to);
  if (from) params.push('ts=gte.' + encodeURIComponent(from));
  if (to) params.push('ts=lte.' + encodeURIComponent(to));
  if (opts.q) {
    const q = String(opts.q).replace(/[,()]/g, ''); // caracteres que confundiriam a sintaxe do "or" do PostgREST
    params.push('or=(nome.ilike.*' + encodeURIComponent(q) + '*,telefone.ilike.*' + encodeURIComponent(q) + '*,placa.ilike.*' + encodeURIComponent(q) + '*)');
  }
  const res = await sb('/' + TABLE + '?' + params.join('&'), { headers: { Prefer: 'count=exact' } });
  const rows = await res.json();
  const range = res.headers.get('content-range'); // formato "0-9/123"
  const total = range && range.includes('/') ? Number(range.split('/')[1]) : rows.length;
  return { total: Number.isFinite(total) ? total : rows.length, leads: rows.map(fromRow) };
}

// contagem simples (nome -> quantidade), já ordenada da maior para a menor
function tally(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = r[key] || '(não informado)'; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
}

// aba "Relatórios": soma geral e divisões por veículo, plataforma, campanha, criativo, origem (CRM), vendedor e status
async function aggregate(opts) {
  opts = opts || {};
  const params = ['select=veiculo,utm_source,utm_medium,utm_campaign,utm_content,utm_term,act_id,placement,keyword,crm_origem,vendedor,status', 'limit=20000'];
  const from = toIso(opts.from), to = toIso(opts.to);
  if (from) params.push('ts=gte.' + encodeURIComponent(from));
  if (to) params.push('ts=lte.' + encodeURIComponent(to));
  const res = await sb('/' + TABLE + '?' + params.join('&'));
  const raw = await res.json();
  const rows = raw.map((r) => ({ veiculo: r.veiculo, utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign, utm_content: r.utm_content, utm_term: r.utm_term, act_id: r.act_id, placement: r.placement, keyword: r.keyword, crmOrigin: r.crm_origem, seller: r.vendedor, status: r.status }));
  const sent = rows.filter((r) => r.status === 'sent' || r.status === 'dry-run');
  return {
    total: rows.length,
    porVeiculo: tally(rows, 'veiculo'),
    porPlataforma: tally(rows, 'utm_source'),
    porCampanha: tally(rows, 'utm_campaign'),
    porCriativo: tally(rows, 'utm_content'),
    porMeio: tally(rows, 'utm_medium'),
    porTermo: tally(rows, 'utm_term'),
    porConta: tally(rows, 'act_id'),
    porPosicionamento: tally(rows, 'placement'),
    porPalavraChave: tally(rows, 'keyword'),
    porOrigemCrm: tally(sent, 'crmOrigin'),
    porVendedor: tally(rows.filter((r) => r.seller), 'seller'),
    porStatus: tally(rows, 'status')
  };
}

// quantos leads cada vendedor ativo já tem, para um veículo — usado pelo rodízio (powercrm.js) para
// sortear o vendedor com MENOS leads até agora (funciona mesmo sem contador nenhum salvo à parte).
async function countsBySeller(veiculo) {
  const res = await sb('/' + TABLE + '?select=vendedor&veiculo=eq.' + encodeURIComponent(veiculo) + '&vendedor=not.is.null&limit=20000');
  const rows = await res.json();
  const counts = {};
  for (const r of rows) counts[r.vendedor] = (counts[r.vendedor] || 0) + 1;
  return counts;
}

module.exports = { recordCreated, recordStatus, listLeads, aggregate, countsBySeller };
