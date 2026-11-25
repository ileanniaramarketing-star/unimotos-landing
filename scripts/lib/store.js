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
const adspend = require('./adspend');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG_PATH = process.env.SUPABASE_CONFIG || path.join(ROOT, 'config', 'supabase.json');
const TABLE = process.env.SUPABASE_LEADS_TABLE || 'leads'; // testes automatizados usam "leads_test"
const ADS_TABLE = process.env.SUPABASE_ADSPEND_TABLE || 'ad_spend_diario'; // gasto diário dos anúncios (migration 0006)
const ADS_CFG_PATH = process.env.ANUNCIOS_CONFIG || path.join(ROOT, 'config', 'anuncios.json');
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

// O Supabase corta cada resposta num teto (1000 linhas, não importa o "limit" pedido): lê em páginas até acabar.
// A consulta precisa ter "order" estável, senão as páginas podem repetir/pular linhas.
async function fetchAll(pathWithQuery) {
  const PAGE = 1000, out = [];
  for (let off = 0; off < 500000; off += PAGE) {
    const res = await sb(pathWithQuery + (pathWithQuery.includes('?') ? '&' : '?') + 'limit=' + PAGE + '&offset=' + off);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

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

// coluna "Liberadas para cadastro" do funil do Power CRM. Casa pelo NOME (sem acento/caixa): o nome vem do próprio CRM a cada
// conciliação, enquanto o número da coluna muda se reordenarem o funil.
const isReleasedStage = (etapa) => /^liberad[ao]s?\b.*\bcadastro/.test(String(etapa || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase());

// funil de vendas do Power CRM para um grupo de leads (que têm código do CRM). "conciliados" = já conferidos no CRM e
// encontrados lá; "vistorias" = chegaram à vistoria (ou já viraram venda); "liberadas" = em andamento e, AGORA, na etapa
// "Liberadas para cadastro" (quem foi descartado ou já vendeu não conta; os descartados que pararam ali vão em
// "liberadasDescartadas", para o número bater com o cartão "Etapas no CRM"); taxa de venda = vendidos ÷ leads do grupo.
function funnelOf(rows) {
  const f = { leads: rows.length, conciliados: 0, naoEncontrados: 0, abertos: 0, liberadas: 0, liberadasDescartadas: 0, vistorias: 0, ganhos: 0, perdidos: 0, mensalidades: 0, adesoes: 0 };
  for (const r of rows) {
    if (!r.sync) continue;
    if (r.situacao === 'nao_encontrado') { f.naoEncontrados++; continue; }
    f.conciliados++;
    if (r.situacao === 'ganho') { f.ganhos++; f.mensalidades += r.mensal; f.adesoes += r.adesao; }
    else if (r.situacao === 'perdido') { f.perdidos++; if (isReleasedStage(r.etapa)) f.liberadasDescartadas++; }
    else { f.abertos++; if (isReleasedStage(r.etapa)) f.liberadas++; }
    if (r.vistoria || r.situacao === 'ganho') f.vistorias++;
  }
  f.mensalidades = round2(f.mensalidades); f.adesoes = round2(f.adesoes);
  f.taxaVenda = f.leads ? f.ganhos / f.leads : 0;
  return f;
}
const sortFunnel = (list) => list.sort((a, b) => b.leads - a.leads || b.ganhos - a.ganhos || (b.investimento || 0) - (a.investimento || 0)).slice(0, 40);
function funnelBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = r[key] || '(não informado)'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return sortFunnel([...m.entries()].map(([label, list]) => Object.assign({ label }, funnelOf(list))));
}
const FUNNEL_DIMS = { veiculo: 'veiculo', vendedor: 'seller' }; // sem gasto próprio (um anúncio não é "de" um veículo/vendedor)

// ---- gasto dos anúncios (tabela ad_spend_diario, gravada por scripts/sync-ads.js) ------------------------------------
const ZERO_SPEND = { investimento: 0, impressoes: 0, cliques: 0 };
// junta o gasto a uma linha do funil: custo por lead = investimento ÷ leads; custo por venda = investimento ÷ vendidos
const withSpend = (f, s) => Object.assign(f, { investimento: adspend.round2(s.investimento), impressoes: s.impressoes, cliques: s.cliques, cpl: adspend.cost(s.investimento, f.leads), custoVenda: adspend.cost(s.investimento, f.ganhos) });

// agrupa os leads por um critério, ligando cada grupo ao gasto correspondente. spendOf(grupo) -> totais ou undefined;
// extras = grupos que gastaram no período mas não tiveram nenhum lead (ex.: campanha de WhatsApp direto).
function funnelWithSpend(rows, groupOf, spendOf, extras) {
  const groups = new Map();
  for (const r of rows) {
    const g = groupOf(r);
    if (!groups.has(g.key)) groups.set(g.key, Object.assign({ list: [] }, g));
    groups.get(g.key).list.push(r);
  }
  const out = [];
  for (const g of groups.values()) {
    const s = spendOf(g);
    out.push(withSpend(Object.assign({ label: (s && s.label) || g.label, plataforma: s && s.plataforma, campanhaId: g.campId }, funnelOf(g.list)), s || ZERO_SPEND));
  }
  for (const x of extras(groups)) out.push(withSpend(Object.assign({ label: x.label, plataforma: x.plataforma, campanhaId: x.campanhaId, semLeads: true, foraDoPainel: x.foraDoPainel }, funnelOf([])), x));
  return sortFunnel(out);
}

function funnelCampanhas(rows, ads) {
  const { model, lpIds } = ads;
  return funnelWithSpend(rows,
    (r) => r.campId ? { key: 'id:' + r.campId, label: r.utm_campaign || '(não informado)', campId: r.campId } : { key: 'nome:' + (r.utm_campaign || ''), label: r.utm_campaign || '(não informado)' },
    (g) => g.campId ? model.campaigns.get(g.campId) && Object.assign({}, model.campaigns.get(g.campId), { label: model.campaigns.get(g.campId).nome }) : undefined,
    (groups) => [...model.campaigns.values()].filter((c) => c.investimento > 0 && !groups.has('id:' + c.id)).map((c) => ({ label: c.nome, plataforma: c.plataforma, campanhaId: c.id, foraDoPainel: !lpIds.has(c.id), investimento: c.investimento, impressoes: c.impressoes, cliques: c.cliques })));
}
function funnelCriativos(rows, ads) {
  const { model, lpIds } = ads;
  return funnelWithSpend(rows,
    (r) => r.adKey ? { key: 'ad:' + r.adKey, label: r.utm_content, adKey: r.adKey } : { key: 'nome:' + (r.utm_content || ''), label: r.utm_content || '(não informado)' },
    (g) => g.adKey ? Object.assign({}, model.ads.get(g.adKey)) : undefined,
    (groups) => [...model.ads.values()].filter((a) => a.investimento > 0 && !groups.has('ad:' + a.key)).map((a) => ({ label: a.label, plataforma: a.plataforma, foraDoPainel: [...a.campanhaIds].every((id) => !lpIds.has(id)), investimento: a.investimento, impressoes: a.impressoes, cliques: a.cliques })));
}
function funnelPlataformas(rows, ads) {
  const { model, lpIds } = ads;
  const lp = {}; for (const p of ['meta', 'google']) lp[p] = adspend.sumCampaigns(model, (c) => c.plataforma === p && lpIds.has(c.id));
  // agrupa pela plataforma de anúncio (facebook, instagram e meta viram "Meta"): o gasto é da plataforma, não dá para separar por origem do clique
  const NOME = { meta: 'Meta', google: 'Google' };
  const groupOf = (r) => { const p = adspend.platformOfSource(r.utm_source); return p ? { key: p, label: NOME[p], plat: p } : { key: 'raw:' + (r.utm_source || ''), label: r.utm_source || '(não informado)' }; };
  return funnelWithSpend(rows, groupOf, (g) => (g.plat ? Object.assign({ plataforma: g.plat }, lp[g.plat]) : undefined), () => []);
}

// campo do funil/KPIs que depende do gasto: investimento nas campanhas "da LP" (com ao menos um lead no painel, de qualquer época)
// ÷ leads/vendas vindos de anúncio. Campanhas sem lead no painel (ex.: conversa direta no WhatsApp) entram à parte, para não inflar o custo.
function spendKpis(crmRows, ads) {
  const { model, lpIds } = ads;
  const lp = adspend.sumCampaigns(model, (c) => lpIds.has(c.id)), all = adspend.sumCampaigns(model);
  const paid = crmRows.filter((r) => r.paid);
  const ganhosPagos = paid.filter((r) => r.sync && r.situacao === 'ganho').length;
  return {
    investimento: lp.investimento, investimentoOutras: adspend.round2(all.investimento - lp.investimento), impressoes: lp.impressoes, cliques: lp.cliques,
    leadsPagos: paid.length, ganhosPagos, cpl: adspend.cost(lp.investimento, paid.length), custoVenda: adspend.cost(lp.investimento, ganhosPagos),
    // leads de anúncio sem o criativo identificado (link sem utm_content ou com o parâmetro em branco, ex.: {{ad.name}}): o custo por criativo fica acima do real
    leadsSemCriativo: paid.filter((r) => !r.adKey).length
  };
}
// conferência com o que a PLATAFORMA contou (gasto, cliques, leads) × o que o site registrou
function adsConference(model, lpIds, rows) {
  return ['meta', 'google'].map((p) => {
    const all = adspend.sumCampaigns(model, (c) => c.plataforma === p), lp = adspend.sumCampaigns(model, (c) => c.plataforma === p && lpIds.has(c.id));
    return { plataforma: p, investimento: all.investimento, investimentoForaDoPainel: adspend.round2(all.investimento - lp.investimento), impressoes: all.impressoes, cliques: all.cliques, leadsPlataforma: all.leadsPlataforma, contatosPlataforma: all.contatosPlataforma, leadsPainel: rows.filter((r) => adspend.platformOfSource(r.utm_source) === p).length };
  }).filter((x) => x.investimento > 0 || x.leadsPainel > 0);
}

const AD_COLS = ['dia', 'plataforma', 'nivel', 'campanha_id', 'anuncio_id', 'campanha_nome', 'anuncio_nome', 'investimento', 'impressoes', 'cliques', 'leads_plataforma', 'contatos_plataforma', 'atualizado_em'];
// o erro é "a tabela de gasto ainda não existe" (migration 0006 não aplicada)?
const isAdsMissing = (e) => /PGRST205|42P01|Could not find the table|ad_spend_diario.*does not exist/i.test((e && e.message) || '');
function loadAdsCfg() { try { return JSON.parse(fs.readFileSync(ADS_CFG_PATH, 'utf8')); } catch (e) { return {}; } }
const brtDay = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10); // dia de calendário em Brasília

// primeiro/último dia com gasto e quando foi sincronizado pela última vez ({ } se a tabela está vazia)
async function adSpendInfo() {
  const one = async (order) => (await (await sb('/' + ADS_TABLE + '?select=dia,atualizado_em&order=' + order + '&limit=1')).json())[0];
  const [first, last, upd] = await Promise.all([one('dia.asc'), one('dia.desc'), one('atualizado_em.desc')]);
  return first ? { desde: first.dia, ate: last.dia, atualizadoEm: upd.atualizado_em } : {};
}
async function listAdSpend(desdeDia, ateDia) {
  const q = ['select=' + AD_COLS.join(','), 'order=dia.asc,plataforma.asc,nivel.asc,campanha_id.asc,anuncio_id.asc'];
  if (desdeDia) q.push('dia=gte.' + desdeDia);
  if (ateDia) q.push('dia=lte.' + ateDia);
  return fetchAll('/' + ADS_TABLE + '?' + q.join('&'));
}
// grava/atualiza (sem duplicar) as linhas de gasto: chave = dia + plataforma + nível + campanha + anúncio
async function upsertAdSpend(rows, atualizadoEm) {
  const now = atualizadoEm || new Date().toISOString();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => Object.assign({}, r, { atualizado_em: now }));
    await sb('/' + ADS_TABLE + '?on_conflict=dia,plataforma,nivel,campanha_id,anuncio_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(chunk) });
  }
  return rows.length;
}
// lê o gasto do período do filtro. { disponivel:false, motivo } quando a tabela não existe ou está vazia.
async function loadAds(opts) {
  let info;
  try { info = await adSpendInfo(); } catch (e) { if (isAdsMissing(e)) return { disponivel: false, motivo: 'sem_tabela' }; throw e; }
  if (!info.ate) return { disponivel: false, motivo: 'sem_dados' };
  const spendRows = await listAdSpend(opts.from ? brtDay(opts.from) : undefined, opts.to ? brtDay(opts.to) : undefined);
  return { disponivel: true, info, spendRows };
}

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
  const params = ['select=ts,veiculo,utm_source,utm_medium,utm_campaign,utm_content,utm_term,utm_id,act_id,placement,keyword,origem_form,cta,crm_origem,vendedor,status,crm_negotiation_code,crm_sync_em,crm_situacao,crm_etapa,crm_etapa_cod,crm_motivo,crm_tags,crm_mensalidade,crm_adesao,crm_vistoria_em', 'order=ts.asc'];
  const from = toIso(opts.from), to = toIso(opts.to);
  if (from) params.push('ts=gte.' + encodeURIComponent(from));
  if (to) params.push('ts=lte.' + encodeURIComponent(to));
  const raw = await fetchAll('/' + TABLE + '?' + params.join('&'));
  // gasto dos anúncios no período (ou "não disponível": o resto do relatório funciona igual sem ele)
  let adsLoad, ads = null;
  try {
    adsLoad = await loadAds(opts);
    if (adsLoad.disponivel) {
      const model = adspend.buildModel(adsLoad.spendRows, loadAdsCfg().apelidosCampanha);
      // campanhas "da LP" = ligadas a algum lead do painel, de QUALQUER época (uma campanha que gastou e não gerou lead no período continua sendo da LP)
      const lpIds = new Set();
      for (const k of await fetchAll('/' + TABLE + '?select=utm_campaign,utm_id&order=ts.asc')) { const id = model.resolveCampaign(k.utm_id, k.utm_campaign); if (id) lpIds.add(id); }
      ads = { model, lpIds };
    }
  } catch (e) { // um problema no gasto não pode derrubar o relatório de leads/vendas
    log('gasto dos anúncios indisponível:', e.message);
    adsLoad = { disponivel: false, motivo: 'erro' }; ads = null;
  }
  const rows = raw.map((r) => ({
    campId: ads ? ads.model.resolveCampaign(r.utm_id, r.utm_campaign) : null, adKey: ads ? ads.model.resolveAd(r.utm_content) : null,
    veiculo: r.veiculo, utm_source: r.utm_source, utm_medium: r.utm_medium, utm_campaign: r.utm_campaign, utm_content: r.utm_content, utm_term: r.utm_term, act_id: r.act_id, placement: r.placement, keyword: r.keyword,
    origem_form: r.origem_form === 'whatsapp' ? 'Pop-up do WhatsApp' : 'Formulário do site', cta: r.cta, crmOrigin: r.crm_origem, seller: r.vendedor, status: r.status,
    crmCode: !!r.crm_negotiation_code, sync: r.crm_sync_em, situacao: r.crm_situacao, etapa: r.crm_etapa, etapaCod: r.crm_etapa_cod, motivo: r.crm_motivo,
    tags: r.crm_tags || [], mensal: Number(r.crm_mensalidade) || 0, adesao: Number(r.crm_adesao) || 0, vistoria: r.crm_vistoria_em
  }));
  // lead "vindo de anúncio" = ligado a uma campanha, ou com utm_source Meta/Google (base do custo por lead e por venda)
  for (const r of rows) r.paid = !!r.campId || !!adspend.platformOfSource(r.utm_source);
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
    funil: Object.assign(funnelOf(crmRows), { semCodigo: rows.length - crmRows.length }, ads ? spendKpis(crmRows, ads) : {}),
    funilPor: Object.assign(
      ads ? { campanha: funnelCampanhas(crmRows, ads), criativo: funnelCriativos(crmRows, ads), plataforma: funnelPlataformas(crmRows, ads) }
        : { campanha: funnelBy(crmRows, 'utm_campaign'), criativo: funnelBy(crmRows, 'utm_content'), plataforma: funnelBy(crmRows, 'utm_source') },
      Object.fromEntries(Object.entries(FUNNEL_DIMS).map(([k, col]) => [k, funnelBy(crmRows, col)]))),
    // gasto dos anúncios: quando existe, de/até que dia está sincronizado e a conferência com o que Meta/Google contaram
    anuncios: ads
      ? { disponivel: true, desde: adsLoad.info.desde, ate: adsLoad.info.ate, atualizadoEm: adsLoad.info.atualizadoEm, atrasoDias: Math.max(0, Math.round((Date.parse(brtDay(Date.now())) - Date.parse(adsLoad.info.ate)) / 86400000)), conferencia: adsConference(ads.model, ads.lpIds, rows) }
      : { disponivel: false, motivo: adsLoad.motivo },
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

module.exports = { upsertAdSpend, adSpendInfo, isAdsMissing, recordCreated, recordStatus, listLeads, exportCsv, aggregate, countsBySeller, CRM_COLS, leadsForCrmSync, applyCrm, crmStatus, isSchemaMissing };
