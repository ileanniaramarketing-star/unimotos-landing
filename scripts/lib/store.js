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

// Retrato do lead no Power CRM, gravado pela conciliação (scripts/lib/crmsync.js; colunas criadas em
// supabase/migrations/0005_leads_crm_conciliacao.sql). crm_sync_em = quando foi conferido pela última vez (NULL = nunca).
const CRM_COLS = ['crm_situacao', 'crm_etapa', 'crm_etapa_cod', 'crm_motivo', 'crm_motivo_obs', 'crm_perda_via', 'crm_arquivado_em', 'crm_tags', 'crm_responsavel', 'crm_plano', 'crm_tabela', 'crm_mensalidade', 'crm_adesao', 'crm_rastreador', 'crm_vistoria_em', 'crm_venda_em'];

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

const num = (v) => (v == null ? undefined : Number(v));

// linha do banco (colunas em português) -> objeto que o resto do código/painel já espera
function fromRow(r) {
  return {
    id: r.id, ts: r.ts, tipo: r.tipo, veiculo: r.veiculo, nome: r.nome, telefone: r.telefone, placa: r.placa,
    utm_source: r.utm_source || undefined, utm_medium: r.utm_medium || undefined, utm_campaign: r.utm_campaign || undefined,
    utm_content: r.utm_content || undefined, utm_term: r.utm_term || undefined, utm_id: r.utm_id || undefined, act_id: r.act_id || undefined,
    placement: r.placement || undefined, keyword: r.keyword || undefined, gclid: r.gclid || undefined, fbclid: r.fbclid || undefined,
    origem_form: r.origem_form || 'site', cta: r.cta || undefined,
    pagina: r.pagina || undefined, crmOrigin: r.crm_origem || undefined, seller: r.vendedor || null, status: r.status,
    statusTs: r.status_ts || undefined, quotationCode: r.crm_quotation_code || undefined, negotiationCode: r.crm_negotiation_code || undefined,
    // só existe depois da 1ª conciliação do lead
    crm: r.crm_sync_em ? {
      syncEm: r.crm_sync_em, situacao: r.crm_situacao || undefined, etapa: r.crm_etapa || undefined, motivo: r.crm_motivo || undefined,
      motivoObs: r.crm_motivo_obs || undefined, perdaVia: r.crm_perda_via || undefined, arquivadoEm: r.crm_arquivado_em || undefined,
      tags: r.crm_tags || [], responsavel: r.crm_responsavel || undefined, plano: r.crm_plano || undefined, tabela: r.crm_tabela || undefined,
      mensalidade: num(r.crm_mensalidade), adesao: num(r.crm_adesao), rastreador: num(r.crm_rastreador),
      vistoriaEm: r.crm_vistoria_em || undefined, vendaEm: r.crm_venda_em || undefined
    } : undefined
  };
}

// filtro "Situação no CRM" (aba Leads e CSV). 'pendente' = tem código do CRM mas ainda nunca foi conciliado.
function crmFilter(situacao) {
  if (!situacao) return [];
  if (situacao === 'pendente') return ['crm_negotiation_code=not.is.null', 'crm_sync_em=is.null'];
  return ['crm_situacao=eq.' + encodeURIComponent(situacao)];
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
    origem_form: lead.origem_form || 'site', cta: lead.cta || null,
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
  params.push(...crmFilter(opts.situacao));
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

// Exportação bruta (CSV): TODOS os leads do filtro, todas as colunas, paginando de 1000 em 1000
// (o PostgREST do Supabase corta respostas num teto por requisição). Mesmos filtros de listLeads.
// Separador ";" (e não vírgula): é o que o Excel em português do Brasil espera — com vírgula, ao dar duplo
// clique ele joga tudo numa coluna só. Google Sheets e Power BI detectam o ";" sozinhos.
const CSV_SEP = ';';
const CSV_COLS = ['id', 'ts', 'tipo', 'veiculo', 'nome', 'telefone', 'placa', 'origem_form', 'cta', 'pagina', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'act_id', 'placement', 'keyword', 'gclid', 'fbclid', 'crm_origem', 'vendedor', 'status', 'status_ts', 'crm_quotation_code', 'crm_negotiation_code', 'crm_sync_em'].concat(CRM_COLS);
const CSV_MONEY = new Set(['crm_mensalidade', 'crm_adesao', 'crm_rastreador']); // vírgula decimal, como o Excel pt-BR espera
function csvCell(v) {
  if (v == null) return '';
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // evita "injeção de fórmula" ao abrir no Excel/Sheets
  return /[",\r\n;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
function csvValue(r, c) {
  const v = r[c];
  if (Array.isArray(v)) return csvCell(v.join(' | '));
  if (CSV_MONEY.has(c) && v != null) return csvCell(String(v).replace('.', ','));
  return csvCell(v);
}
async function exportCsv(opts) {
  opts = opts || {};
  const base = ['select=' + CSV_COLS.join(','), 'order=ts.desc'];
  if (opts.veiculo) base.push('veiculo=eq.' + encodeURIComponent(opts.veiculo));
  if (opts.status) base.push('status=eq.' + encodeURIComponent(opts.status));
  base.push(...crmFilter(opts.situacao));
  const from = toIso(opts.from), to = toIso(opts.to);
  if (from) base.push('ts=gte.' + encodeURIComponent(from));
  if (to) base.push('ts=lte.' + encodeURIComponent(to));
  if (opts.q) {
    const q = String(opts.q).replace(/[,()]/g, '');
    base.push('or=(nome.ilike.*' + encodeURIComponent(q) + '*,telefone.ilike.*' + encodeURIComponent(q) + '*,placa.ilike.*' + encodeURIComponent(q) + '*)');
  }
  const lines = [CSV_COLS.join(CSV_SEP)];
  const PAGE = 1000;
  for (let off = 0; off < 100000; off += PAGE) {
    const res = await sb('/' + TABLE + '?' + base.concat('limit=' + PAGE, 'offset=' + off).join('&'));
    const rows = await res.json();
    for (const r of rows) lines.push(CSV_COLS.map((c) => csvValue(r, c)).join(CSV_SEP));
    if (rows.length < PAGE) break;
  }
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM: o Excel abre os acentos certo
}

// contagem simples (nome -> quantidade), já ordenada da maior para a menor
function tally(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = r[key] || '(não informado)'; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
}

const round2 = (n) => Math.round(n * 100) / 100;

// funil de vendas do Power CRM para um grupo de leads (que têm código do CRM). "conciliados" = já conferidos no CRM e
// encontrados lá; "vistorias" = chegaram à vistoria (ou já viraram venda); taxa de venda = vendidos ÷ leads do grupo.
function funnelOf(rows) {
  const f = { leads: rows.length, conciliados: 0, naoEncontrados: 0, abertos: 0, vistorias: 0, ganhos: 0, perdidos: 0, mensalidades: 0, adesoes: 0 };
  for (const r of rows) {
    if (!r.sync) continue;
    if (r.situacao === 'nao_encontrado') { f.naoEncontrados++; continue; }
    f.conciliados++;
    if (r.situacao === 'ganho') { f.ganhos++; f.mensalidades += r.mensal; f.adesoes += r.adesao; }
    else if (r.situacao === 'perdido') f.perdidos++;
    else f.abertos++;
    if (r.vistoria || r.situacao === 'ganho') f.vistorias++;
  }
  f.mensalidades = round2(f.mensalidades); f.adesoes = round2(f.adesoes);
  f.taxaVenda = f.leads ? f.ganhos / f.leads : 0;
  return f;
}
function funnelBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = r[key] || '(não informado)'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].map(([label, list]) => Object.assign({ label }, funnelOf(list))).sort((a, b) => b.leads - a.leads || b.ganhos - a.ganhos).slice(0, 40);
}
const FUNNEL_DIMS = { campanha: 'utm_campaign', criativo: 'utm_content', plataforma: 'utm_source', veiculo: 'veiculo', vendedor: 'seller' };

// etapas do funil na ordem do funil (pelo número da coluna no CRM), não por quantidade
function byStage(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.etapa || '(sem etapa)';
    const e = m.get(k) || { label: k, count: 0, cod: r.etapaCod == null ? 99 : r.etapaCod };
    e.count++; m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.cod - b.cod || b.count - a.count).map(({ label, count }) => ({ label, count }));
}

// aba "Relatórios": soma geral e divisões por veículo, plataforma, campanha, criativo, origem (CRM), vendedor e status,
// mais o funil de vendas do Power CRM (etapas, descartes com motivo, vendas) cruzado com campanha/criativo/plataforma…
async function aggregate(opts) {
  opts = opts || {};
  const params = ['select=ts,veiculo,utm_source,utm_medium,utm_campaign,utm_content,utm_term,act_id,placement,keyword,origem_form,cta,crm_origem,vendedor,status,crm_negotiation_code,crm_sync_em,crm_situacao,crm_etapa,crm_etapa_cod,crm_motivo,crm_tags,crm_mensalidade,crm_adesao,crm_vistoria_em', 'limit=20000'];
  const from = toIso(opts.from), to = toIso(opts.to);
  if (from) params.push('ts=gte.' + encodeURIComponent(from));
  if (to) params.push('ts=lte.' + encodeURIComponent(to));
  const res = await sb('/' + TABLE + '?' + params.join('&'));
  const raw = await res.json();
  const rows = raw.map((r) => ({
    veiculo: r.veiculo, utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign, utm_content: r.utm_content, utm_term: r.utm_term, act_id: r.act_id, placement: r.placement, keyword: r.keyword,
    origem_form: r.origem_form === 'whatsapp' ? 'Pop-up do WhatsApp' : 'Formulário do site', cta: r.cta, crmOrigin: r.crm_origem, seller: r.vendedor, status: r.status,
    crmCode: !!r.crm_negotiation_code, sync: r.crm_sync_em, situacao: r.crm_situacao, etapa: r.crm_etapa, etapaCod: r.crm_etapa_cod, motivo: r.crm_motivo,
    tags: r.crm_tags || [], mensal: Number(r.crm_mensalidade) || 0, adesao: Number(r.crm_adesao) || 0, vistoria: r.crm_vistoria_em
  }));
  const sent = rows.filter((r) => r.status === 'sent' || r.status === 'dry-run');
  const crmRows = rows.filter((r) => r.crmCode);
  const found = crmRows.filter((r) => r.sync && r.situacao !== 'nao_encontrado'); // conferidos e achados no CRM
  // médias: período = filtro "De/Até" (ou do 1º lead até agora/até o fim do filtro); mínimo de 1 dia
  const tss = raw.map((r) => Date.parse(r.ts)).filter(Number.isFinite);
  const start = opts.from || (tss.length ? Math.min(...tss) : Date.now());
  const end = Math.min(opts.to || Date.now(), Date.now());
  const dias = Math.max(1, Math.ceil((end - start) / 86400000));
  const mediaDia = rows.length / dias;
  return {
    total: rows.length,
    dias,
    mediaDia,
    mediaSemana: mediaDia * 7,
    mediaMes: mediaDia * 30,
    porVeiculo: tally(rows, 'veiculo'),
    porPlataforma: tally(rows, 'utm_source'),
    porCampanha: tally(rows, 'utm_campaign'),
    porCriativo: tally(rows, 'utm_content'),
    porMeio: tally(rows, 'utm_medium'),
    porTermo: tally(rows, 'utm_term'),
    porConta: tally(rows, 'act_id'),
    porPosicionamento: tally(rows, 'placement'),
    porPalavraChave: tally(rows, 'keyword'),
    porFormulario: tally(rows, 'origem_form'),
    porBotao: tally(rows.filter((r) => r.cta), 'cta'),
    porOrigemCrm: tally(sent, 'crmOrigin'),
    porVendedor: tally(rows.filter((r) => r.seller), 'seller'),
    porStatus: tally(rows, 'status'),
    // Power CRM: leads sem código (duplicados/falha de envio) nunca chegaram lá, então ficam fora do funil
    funil: Object.assign(funnelOf(crmRows), { semCodigo: rows.length - crmRows.length }),
    funilPor: Object.fromEntries(Object.entries(FUNNEL_DIMS).map(([k, col]) => [k, funnelBy(crmRows, col)])),
    porEtapaCrm: byStage(found),
    porMotivoCrm: tally(found.filter((r) => r.situacao === 'perdido'), 'motivo'),
    porTagCrm: tally(found.flatMap((r) => r.tags.map((tag) => ({ tag }))), 'tag')
  };
}

// Conciliação (scripts/lib/crmsync.js) ---------------------------------------------------------------------------

// leads que entram na rodada: têm código do CRM e (são recentes OU nunca foram conferidos OU ainda estão em andamento)
async function leadsForCrmSync(cutoffIso) {
  const cols = ['id', 'ts', 'crm_negotiation_code', 'crm_quotation_code', 'crm_sync_em'].concat(CRM_COLS);
  const or = 'or=(ts.gte.' + encodeURIComponent(cutoffIso) + ',crm_sync_em.is.null,crm_situacao.eq.aberto)';
  const res = await sb('/' + TABLE + '?select=' + cols.join(',') + '&crm_negotiation_code=not.is.null&order=ts.asc&limit=20000&' + or);
  return res.json();
}

// grava o resultado: plan.changes = [{ id, fields }] (retrato novo), plan.touch = [ids] (sem mudança, só atualiza a hora)
async function applyCrm(plan) {
  const syncEm = plan.syncEm || new Date().toISOString();
  const patch = (c) => sb('/' + TABLE + '?id=eq.' + encodeURIComponent(c.id), { method: 'PATCH', body: JSON.stringify(Object.assign({}, c.fields, { crm_sync_em: syncEm })) });
  for (let i = 0; i < plan.changes.length; i += 6) await Promise.all(plan.changes.slice(i, i + 6).map(patch));
  for (let i = 0; i < plan.touch.length; i += 80) {
    const ids = plan.touch.slice(i, i + 80).map(encodeURIComponent).join(',');
    await sb('/' + TABLE + '?id=in.(' + ids + ')', { method: 'PATCH', body: JSON.stringify({ crm_sync_em: syncEm }) });
  }
}

// para a tela: quantos leads têm código do CRM, quantos já foram conferidos e quando foi a última conferência
async function crmStatus() {
  const count = async (filter) => {
    const res = await sb('/' + TABLE + '?select=id&limit=1&' + filter, { headers: { Prefer: 'count=exact' } });
    const range = res.headers.get('content-range'); // "0-0/120" (ou "*/0")
    return range && range.includes('/') ? Number(range.split('/')[1]) || 0 : 0;
  };
  const [elegiveis, conciliados, last] = await Promise.all([
    count('crm_negotiation_code=not.is.null'),
    count('crm_sync_em=not.is.null'),
    sb('/' + TABLE + '?select=crm_sync_em&crm_sync_em=not.is.null&order=crm_sync_em.desc&limit=1').then((r) => r.json())
  ]);
  return { elegiveis, conciliados, ultima: last[0] ? last[0].crm_sync_em : null };
}

// o erro é "o banco ainda não tem as colunas crm_*" (migration 0005 não aplicada)?
const isSchemaMissing = (e) => /42703|PGRST204|column .*crm_.* does not exist|Could not find the .*crm_/i.test((e && e.message) || '');

// quantos leads cada vendedor ativo já tem, para um veículo — usado pelo rodízio (powercrm.js) para
// sortear o vendedor com MENOS leads até agora (funciona mesmo sem contador nenhum salvo à parte).
// `desde` (ISO, opcional): só conta leads a partir dessa data — usado quando um vendedor novo entra no rodízio.
async function countsBySeller(veiculo, desde) {
  const since = desde && !isNaN(Date.parse(desde)) ? '&ts=gte.' + encodeURIComponent(new Date(desde).toISOString()) : '';
  const res = await sb('/' + TABLE + '?select=vendedor&veiculo=eq.' + encodeURIComponent(veiculo) + '&vendedor=not.is.null' + since + '&limit=20000');
  const rows = await res.json();
  const counts = {};
  for (const r of rows) counts[r.vendedor] = (counts[r.vendedor] || 0) + 1;
  return counts;
}

module.exports = { recordCreated, recordStatus, listLeads, exportCsv, aggregate, countsBySeller, CRM_COLS, leadsForCrmSync, applyCrm, crmStatus, isSchemaMissing };
