'use strict';
/*
  Registro dos leads para o painel interno (/painel) — SOMENTE no servidor.

  Guarda em .data/leads.jsonl (1 evento por linha, formato "event sourcing": nunca reescreve o
  arquivo, só acrescenta). Cada lead gera um evento "created" na hora, e um ou mais eventos
  "status" conforme o envio ao Power CRM evolui (dry-run/enviado/pendente/falhou). Ao listar, cada
  lead aparece uma vez, com o status mais recente.

  Fica em .data/ (fora do Git, nunca servido como arquivo estático — ver scripts/serve.js).
  Contém dado pessoal (nome, telefone, placa): é a mesma informação que já vai para o Power CRM,
  guardada aqui só para o painel mostrar. Sem limpeza automática nesta versão (arquivo cresce).
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.POWERCRM_DATA_DIR || path.join(ROOT, '.data'); // mesma pasta do rodízio (facilita isolar em teste)
const FILE = path.join(DATA_DIR, 'leads.jsonl');
const MAX_LINES_READ = 20000; // teto defensivo de leitura (não deixa o arquivo crescer sem limite na memória)

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function append(event) {
  try {
    ensureDir();
    fs.appendFileSync(FILE, JSON.stringify(event) + '\n', 'utf8');
  } catch (e) { console.error('[store] não consegui gravar em .data/leads.jsonl:', e.message); }
}

function readEvents() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const slice = lines.length > MAX_LINES_READ ? lines.slice(lines.length - MAX_LINES_READ) : lines;
  const out = [];
  for (const line of slice) { try { out.push(JSON.parse(line)); } catch (e) { /* linha corrompida: ignora */ } }
  return out;
}

// evento "created": registra o lead assim que passa nas validações (antes de falar com o CRM)
function recordCreated(lead) {
  const id = crypto.randomBytes(6).toString('hex');
  append(Object.assign({ type: 'created', id, ts: Date.now() }, lead));
  return id;
}

// evento "status": o resultado do envio ao CRM (imediato ou, para retries, mais tarde)
function recordStatus(id, status, seller) {
  if (!id) return;
  append({ type: 'status', id, ts: Date.now(), status, seller: seller || null });
}

// junta os eventos por id: dados do "created" + status mais recente (mantém a ordem: mais novo primeiro)
function merge(events) {
  const byId = new Map();
  for (const e of events) {
    if (e.type === 'created') {
      const cur = byId.get(e.id) || {};
      byId.set(e.id, Object.assign({ status: 'pendente', seller: null }, cur, e));
    } else if (e.type === 'status') {
      const cur = byId.get(e.id) || { id: e.id, ts: e.ts };
      byId.set(e.id, Object.assign({}, cur, { status: e.status, seller: e.seller || cur.seller, statusTs: e.ts }));
    }
  }
  return [...byId.values()].sort((a, b) => b.ts - a.ts);
}

function inRange(ts, from, to) {
  if (from && ts < from) return false;
  if (to && ts > to) return false;
  return true;
}

// lista para a aba "Leads" do painel, com filtros simples
function listLeads(opts) {
  opts = opts || {};
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 2000);
  const q = opts.q ? String(opts.q).toLowerCase() : '';
  let rows = merge(readEvents());
  if (opts.veiculo) rows = rows.filter((r) => r.veiculo === opts.veiculo);
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts.from || opts.to) rows = rows.filter((r) => inRange(r.ts, opts.from, opts.to));
  if (q) rows = rows.filter((r) => [r.nome, r.telefone, r.placa].some((v) => String(v || '').toLowerCase().includes(q)));
  return { total: rows.length, leads: rows.slice(0, limit) };
}

// contagem simples (nome -> quantidade), já ordenada da maior para a menor
function tally(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = r[key] || '(não informado)'; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
}

// aba "Relatórios": soma geral e divisões por veículo, plataforma, campanha, criativo, origem (CRM), vendedor e status
function aggregate(opts) {
  opts = opts || {};
  let rows = merge(readEvents());
  if (opts.from || opts.to) rows = rows.filter((r) => inRange(r.ts, opts.from, opts.to));
  const sent = rows.filter((r) => r.status === 'sent' || r.status === 'dry-run');
  return {
    total: rows.length,
    porVeiculo: tally(rows, 'veiculo'),
    porPlataforma: tally(rows, 'utm_source'),
    porCampanha: tally(rows, 'utm_campaign'),
    porCriativo: tally(rows, 'utm_content'),
    porOrigemCrm: tally(sent.map((r) => ({ crmOrigin: r.crmOrigin })), 'crmOrigin'),
    porVendedor: tally(rows.filter((r) => r.seller), 'seller'),
    porStatus: tally(rows, 'status')
  };
}

module.exports = { recordCreated, recordStatus, listLeads, aggregate, FILE };
