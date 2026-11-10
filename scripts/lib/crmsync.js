'use strict';
/*
  Conciliação com o Power CRM — é o que roda quando alguém clica em "Conciliar com o Power CRM" no painel.

  Para cada lead que foi enviado ao CRM (tem o código da negociação em crm_negotiation_code), busca no Power CRM
  em que ETAPA do funil ele está, se foi VENDIDO ou DESCARTADO (e o MOTIVO) e os dados da venda (plano, mensalidade,
  adesão, datas) e guarda esse retrato no próprio lead (colunas crm_* do Supabase). Com isso o painel mostra o
  resultado de cada lead e os relatórios cruzam vendas × campanha/criativo/plataforma.

  De onde vem o dado: POST /api/report/db/paginated ("Relatório do banco de dados"). É a única rota da API com o
  motivo do arquivamento (shelvedReason) e as datas do funil; GET /api/negotiation/{código} só diz a coluna e se
  está arquivada, sem motivo. O que aprendemos testando contra o CRM real (2026-11-06):
    - o relatório devolve a EMPRESA INTEIRA (panfletos, planilhas importadas, outras cooperativas) e, em cada linha,
      dado pessoal de cliente e CPF do vendedor. Aqui só interessam os NOSSOS leads: filtramos pelo código da
      negociação (cardId) assim que a página chega e descartamos o resto; só os campos da lista KEEP sobrevivem —
      nada de terceiros é guardado, logado ou devolvido ao navegador;
    - stringFilterTypeDate=1 filtra pela data de CRIAÇÃO (3 = data da venda; 0, 5 e 6 dão HTTP 502; 2 vem vazio);
    - janelas grandes (meses) dão HTTP 502: pedimos em blocos de poucos dias e, se um bloco falhar, dividimos ao
      meio até chegar em 1 dia (o dia que ainda assim falhar fica de fora e é avisado no resultado);
    - uma página pode vir com até ~1000 linhas; se vier cheia pedimos a próxima;
    - cardStatus é só o número da coluna (1 Cotação Recebida, 2 Em negociação, 3 Vistorias, 5 Vendas concretizadas…);
      o NOME da coluna vem de GET /api/negotiation/{código} (pipelineColumn) e é descoberto a cada rodada, então
      renomear/criar colunas no CRM não quebra nada;
    - negociação inexistente responde HTTP 412 "Negociação não encontrada!"; token inválido, HTTP 401.

  Regras de classificação (VENDIDO / DESCARTADO / EM ANDAMENTO) ficam em config/powercrm.json -> conciliacao.
  Só LÊ do Power CRM (nunca escreve lá). Escreve apenas as colunas crm_* do lead, no Supabase.
*/
const fs = require('fs');
const path = require('path');
const defaultStore = require('./store');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG_PATH = process.env.POWERCRM_CONFIG || path.join(ROOT, 'config', 'powercrm.json'); // POWERCRM_CONFIG: só testes
const token = () => process.env.POWERCRM_TOKEN || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const redact = (s) => { const t = token(); return t ? String(s).split(t).join('[REDACTED]') : String(s); };
const log = (...a) => console.log('[crmsync]', ...a.map((x) => redact(typeof x === 'string' ? x : JSON.stringify(x))));

const DEFAULT_RULES = {
  janelaDias: 90,
  blocoDias: 15,
  etapasConhecidas: { 1: 'Cotação Recebida', 2: 'Em negociação', 3: 'Vistorias', 4: 'Liberadas para cadastro', 5: 'Vendas concretizadas' }, // só reserva: o nome real é perguntado ao CRM
  etapasGanho: ['Vendas concretizadas'],
  tagsGanho: ['ASSOCIADO'],
  tagsPerda: ['PERDIDO'],
  motivosPorTag: { 'FECHOU EM OUTRA': 'FECHOU EM OUTRA', 'SEM CONTATO': 'SEM CONTATO' }
};

// colunas crm_* que a conciliação escreve (a lista é a do store, fonte única também usada em CSV/relatórios)
const CRM_COLS = defaultStore.CRM_COLS;
const NUMERIC = new Set(['crm_etapa_cod', 'crm_mensalidade', 'crm_adesao', 'crm_rastreador']);

// ÚNICOS campos do relatório que sobrevivem (lista de permitidos). O relatório também traz nome, telefone, CPF,
// endereço e e-mail do cliente e CPF/e-mail do vendedor — nada disso é copiado.
const KEEP = ['cardId', 'quotationCode', 'cardStatus', 'isShelved', 'shelvedReason', 'descriptionReason', 'quoteShelvedDate', 'tags',
  'responsibleSalesman', 'namePlan', 'namePriceTable', 'monthlyPaymentsPrice', 'currentMonthlyTotal', 'acquisitionPrice', 'trackerPrice', 'hasTracker',
  'inspectionScheduledDate', 'clearForInspectionDate', 'inspectionReceivedDate', 'inspectionFinalizedDate', 'sentToHinovaDate', 'hinovaSentDate'];

const PAGE_FULL = 700;       // página com pelo menos isto de linhas -> pode haver próxima página
const MAX_PAGES = 40;
const MAX_VERIFY = 60;       // quantos leads "sumidos" conferimos um a um por rodada

function loadCfg() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const auth = cfg.auth || {};
  return {
    base: String(cfg.baseUrl || '').replace(/\/+$/, ''),
    header: auth.header || 'Authorization',
    scheme: auth.scheme || 'Bearer',
    rules: Object.assign({}, DEFAULT_RULES, cfg.conciliacao || {})
  };
}

/* ----------------------------------------------------------------------------------------------- *
 * Funções puras (texto/data/dinheiro/classificação) — exportadas em _t para os testes
 * ----------------------------------------------------------------------------------------------- */

// texto limpo: tira espaços repetidos/pontas; "-" (como o CRM marca vazio) vira ''
function clean(v) {
  if (v == null) return '';
  const t = String(v).replace(/\s+/g, ' ').trim();
  return t === '-' ? '' : t;
}
// para comparar nomes de etapa/tag: sem acento, sem diferenciar maiúsculas
const norm = (s) => clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// "06/11/2026 - 09:26" (horário de Brasília, sem horário de verão desde 2019) -> ISO UTC; vazio/"-" -> null
function parseBrDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s*-\s*(\d{2}):(\d{2}))?/.exec(clean(s));
  if (!m) return null;
  const t = Date.parse(m[3] + '-' + m[2] + '-' + m[1] + 'T' + (m[4] || '00') + ':' + (m[5] || '00') + ':00-03:00');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// "R$ 1.876,96" / "200,00" / "34244,00" -> número; vazio -> null
function parseBrl(s) {
  if (s == null) return null;
  const t = String(s).replace(/[^\d,.-]/g, '');
  if (!/\d/.test(t)) return null;
  const n = (!t.includes(',') && /\.\d{1,2}$/.test(t)) ? Number(t) : Number(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// dia (AAAA-MM-DD) no horário de Brasília para um instante em ms
const brtDay = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const minOf = (a, b) => (a < b ? a : b);

function earliest(list) {
  const ts = list.filter(Boolean).map((x) => Date.parse(x)).filter(Number.isFinite);
  return ts.length ? new Date(Math.min(...ts)).toISOString() : null;
}

// Retrato do lead no CRM a partir de uma linha do relatório + nome da etapa. Chaves = colunas crm_* do banco.
function snapshot(row, etapa, rules) {
  const cod = Number(row.cardStatus);
  const tags = (Array.isArray(row.tags) ? row.tags : []).map(clean).filter(Boolean);
  const tagSet = new Set(tags.map(norm));
  const hasTag = (list) => (list || []).some((t) => tagSet.has(norm(t)));
  const shelved = String(row.isShelved || '').toUpperCase() === 'S';
  const vendaEm = parseBrDate(row.sentToHinovaDate) || parseBrDate(row.hinovaSentDate);
  const won = !!vendaEm || (rules.etapasGanho || []).some((e) => norm(e) === norm(etapa)) || hasTag(rules.tagsGanho);

  let situacao = 'aberto', via = null, motivo = null, obs = null;
  if (shelved && !vendaEm) { // arquivado no CRM (e que não chegou a virar associado) = descartado, com o motivo oficial
    situacao = 'perdido'; via = 'arquivo';
    motivo = clean(row.shelvedReason) || 'NÃO INFORMADO';
    obs = clean(row.descriptionReason) || null;
  } else if (won) {
    situacao = 'ganho';
  } else if (hasTag(rules.tagsPerda)) { // os vendedores marcam PERDIDO sem arquivar: o motivo, quando há, sai de outra tag
    situacao = 'perdido'; via = 'tag';
    const hit = Object.entries(rules.motivosPorTag || {}).find(([tag]) => tagSet.has(norm(tag)));
    motivo = hit ? hit[1] : 'SEM MOTIVO INFORMADO';
  }

  const mensal = clean(row.monthlyPaymentsPrice) ? row.monthlyPaymentsPrice : row.currentMonthlyTotal;
  return {
    crm_situacao: situacao,
    crm_etapa: clean(etapa) || null,
    crm_etapa_cod: Number.isFinite(cod) ? cod : null,
    crm_motivo: motivo,
    crm_motivo_obs: obs,
    crm_perda_via: via,
    crm_arquivado_em: shelved ? parseBrDate(row.quoteShelvedDate) : null,
    crm_tags: tags,
    crm_responsavel: clean(row.responsibleSalesman) || null,
    crm_plano: clean(row.namePlan) || null,
    crm_tabela: clean(row.namePriceTable) || null,
    crm_mensalidade: parseBrl(mensal),
    crm_adesao: parseBrl(row.acquisitionPrice),
    crm_rastreador: String(row.hasTracker || '').toUpperCase() === 'S' ? parseBrl(row.trackerPrice) : null,
    crm_vistoria_em: earliest([parseBrDate(row.inspectionScheduledDate), parseBrDate(row.clearForInspectionDate), parseBrDate(row.inspectionReceivedDate), parseBrDate(row.inspectionFinalizedDate)]),
    crm_venda_em: vendaEm
  };
}

// lead que o CRM não conhece mais (apagado lá): limpa o retrato antigo e marca
function missingSnapshot() {
  const o = {};
  for (const c of CRM_COLS) o[c] = null;
  o.crm_situacao = 'nao_encontrado';
  o.crm_tags = [];
  return o;
}

// o valor guardado no banco é igual ao novo? (timestamp vem do banco como "+00:00", daqui como "Z"; tags comparam como lista)
function same(col, a, b) {
  const n = (v) => {
    if (v == null || v === '') return null;
    if (Array.isArray(v)) return v.length ? JSON.stringify(v) : null;
    if (col.endsWith('_em')) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
    if (NUMERIC.has(col)) return Number(v);
    return v;
  };
  return n(a) === n(b);
}

/* ----------------------------------------------------------------------------------------------- *
 * Conversa com o Power CRM (somente leitura)
 * ----------------------------------------------------------------------------------------------- */

const fatal = (code, msg) => Object.assign(new Error(msg), { fatal: code });

async function crmCall(method, pathname, body, o) {
  o = o || {};
  const cfg = loadCfg();
  let last = 'sem resposta';
  for (let i = 0; i < (o.tries || 3); i++) {
    if (i) await sleep(500 * i * i); // 0, 0,5 s, 2 s
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || 30000);
    try {
      const res = await fetch(cfg.base + pathname, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', [cfg.header]: cfg.scheme + ' ' + token() },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      const text = await res.text();
      if (res.status >= 500 || res.status === 429) { last = 'HTTP ' + res.status; continue; }
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* corpo que não é JSON */ }
      return { status: res.status, json };
    } catch (e) {
      last = e && e.name === 'AbortError' ? 'tempo esgotado' : (e && e.message) || 'falha de rede';
    } finally { clearTimeout(timer); }
  }
  throw new Error('Power CRM: ' + last);
}

// um pedaço de datas (AAAA-MM-DD a AAAA-MM-DD, inclusive), página por página; só devolve linhas dos NOSSOS leads
async function fetchChunk(from, to, ctx) {
  const out = []; const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await crmCall('POST', '/api/report/db/paginated', { from, to, page, stringFilterTypeDate: 1 }, { tries: 2 });
    if (r.status === 401 || r.status === 403) throw fatal('crm_auth', 'Power CRM recusou o token (HTTP ' + r.status + ')');
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.items)) throw new Error('relatório HTTP ' + r.status);
    const items = r.json.items;
    let novos = 0;
    for (const it of items) {
      const key = it.cardId + '|' + it.quotationCode;
      if (seen.has(key)) continue;
      seen.add(key); novos++;
      if (ctx.wanted.has(it.cardId)) { const o = {}; for (const k of KEEP) o[k] = it[k]; out.push(o); }
    }
    if (items.length < PAGE_FULL || !novos) break; // página não cheia (ou repetida): acabou
  }
  return out;
}

// tenta o bloco inteiro; se falhar, divide ao meio (até 1 dia). Dia que não vem fica em "failed".
async function fetchRange(from, to, ctx) {
  const n = daysBetween(from, to) + 1;
  if (Date.now() > ctx.deadline) { ctx.parcial = true; return { rows: [], failed: Array.from({ length: n }, (_, i) => addDays(from, i)) }; }
  try {
    return { rows: await fetchChunk(from, to, ctx), failed: [] };
  } catch (e) {
    if (e.fatal) throw e;
    if (n <= 1) { log('dia sem resposta do relatório:', from, '-', e.message); return { rows: [], failed: [from] }; }
    const mid = addDays(from, Math.floor(n / 2) - 1);
    const a = await fetchRange(from, mid, ctx);
    const b = await fetchRange(addDays(mid, 1), to, ctx);
    return { rows: a.rows.concat(b.rows), failed: a.failed.concat(b.failed) };
  }
}

// true = o CRM confirma que não existe; false = existe; null = não deu para saber
async function missingInCrm(code) {
  const r = await crmCall('GET', '/api/negotiation/' + encodeURIComponent(code), null, { tries: 2 }).catch(() => null);
  if (!r) return null;
  if (r.status === 404) return true;
  if (r.status === 412 && /n[aã]o encontrad/i.test(JSON.stringify(r.json || ''))) return true;
  if (r.status === 200 && r.json && r.json.code) return false;
  return null;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

/* ----------------------------------------------------------------------------------------------- *
 * A conciliação
 * ----------------------------------------------------------------------------------------------- */

let running = false;
let runningSince = 0;

async function run(opts) {
  const t0 = Date.now();
  const st = opts.store || defaultStore;
  const { rules } = loadCfg();
  const known = rules.etapasConhecidas || {};
  const now = opts.now || Date.now();
  const cutoff = new Date(now - rules.janelaDias * 86400000).toISOString();

  const leads = await st.leadsForCrmSync(cutoff);
  const out = {
    ok: true, parcial: false, simulacao: !!opts.dryRun, duracaoMs: 0, janela: null,
    leads: leads.length, conciliados: 0, atualizados: 0, inalterados: 0,
    naoEncontrados: 0, foraDoRelatorio: 0, semResposta: 0, diasComFalha: [],
    situacao: { aberto: 0, ganho: 0, perdido: 0 },
    mudancas: { novosGanhos: 0, novosDescartes: 0, mudaramDeEtapa: 0 },
    etapas: {}
  };
  if (!leads.length) return out;

  // janela de datas: do dia (BRT) do lead mais antigo, menos 1 dia de folga, até hoje
  const days = leads.map((l) => brtDay(Date.parse(l.ts))).sort();
  const minDay = addDays(days[0], -1);
  const maxDay = [brtDay(now), addDays(days[days.length - 1], 1)].sort().pop();
  out.janela = { de: minDay, ate: maxDay };

  const ctx = { wanted: new Set(leads.map((l) => l.crm_negotiation_code)), deadline: t0 + (opts.maxMs || 100000), parcial: false };
  const chunks = [];
  for (let d = minDay; d <= maxDay; d = addDays(d, rules.blocoDias)) chunks.push([d, minOf(addDays(d, rules.blocoDias - 1), maxDay)]);
  const parts = await pool(chunks, 3, ([a, b]) => fetchRange(a, b, ctx));
  const failed = new Set(parts.flatMap((p) => p.failed));
  out.diasComFalha = [...failed].sort();
  out.parcial = ctx.parcial;

  const byCard = new Map();
  for (const r of parts.flatMap((p) => p.rows)) { if (!byCard.has(r.cardId)) byCard.set(r.cardId, []); byCard.get(r.cardId).push(r); }
  const pick = (lead) => {
    const list = byCard.get(lead.crm_negotiation_code) || [];
    return list.find((r) => r.quotationCode === lead.crm_quotation_code) || list[0] || null;
  };

  // nome de cada etapa (o relatório só traz o número): pergunta a UM lead de cada número, a cada rodada
  const sample = new Map();
  for (const lead of leads) { const r = pick(lead); if (r && !sample.has(String(r.cardStatus))) sample.set(String(r.cardStatus), lead.crm_negotiation_code); }
  const names = {};
  await pool([...sample], 3, async ([cod, neg]) => {
    const r = await crmCall('GET', '/api/negotiation/' + encodeURIComponent(neg), null, { tries: 2 }).catch(() => null);
    const n = r && r.status === 200 && r.json && clean(r.json.pipelineColumn);
    names[cod] = n || known[cod] || ('Etapa ' + cod);
  });
  out.etapas = names;

  // plano de escrita
  const changes = [], touch = [], missing = [];
  const detalhes = [];
  const bump = (lead, snap) => {
    out.conciliados++;
    out.situacao[snap.crm_situacao] = (out.situacao[snap.crm_situacao] || 0) + 1;
    const wasGanho = lead.crm_situacao === 'ganho', wasPerdido = lead.crm_situacao === 'perdido';
    if (lead.crm_sync_em) {
      if (snap.crm_situacao === 'ganho' && !wasGanho) out.mudancas.novosGanhos++;
      if (snap.crm_situacao === 'perdido' && !wasPerdido) out.mudancas.novosDescartes++;
      if (lead.crm_etapa && snap.crm_etapa && lead.crm_etapa !== snap.crm_etapa) out.mudancas.mudaramDeEtapa++;
    }
  };
  const decide = (lead, snap) => {
    const unchanged = lead.crm_sync_em && CRM_COLS.every((c) => same(c, lead[c], snap[c]));
    if (unchanged) { touch.push(lead.id); out.inalterados++; } else { changes.push({ id: lead.id, fields: snap }); out.atualizados++; }
    if (opts.detalhes) detalhes.push({ negociacao: lead.crm_negotiation_code, mudou: !unchanged, situacao: snap.crm_situacao, etapa: snap.crm_etapa, motivo: snap.crm_motivo, via: snap.crm_perda_via, plano: snap.crm_plano, mensalidade: snap.crm_mensalidade, adesao: snap.crm_adesao, vendaEm: snap.crm_venda_em, vistoriaEm: snap.crm_vistoria_em, tags: snap.crm_tags });
  };

  for (const lead of leads) {
    const row = pick(lead);
    if (!row) { missing.push(lead); continue; }
    const snap = snapshot(row, names[String(row.cardStatus)], rules);
    bump(lead, snap);
    decide(lead, snap);
  }

  // leads que não vieram no relatório: confere um a um se o CRM ainda os conhece
  const near = (lead) => { const d = brtDay(Date.parse(lead.ts)); return [addDays(d, -1), d, addDays(d, 1)].some((x) => failed.has(x)); };
  const checkable = missing.filter((l) => !near(l));
  out.semResposta += missing.length - checkable.length;
  const toCheck = checkable.slice(0, MAX_VERIFY);
  out.semResposta += checkable.length - toCheck.length;
  const verdicts = await pool(toCheck, 4, (l) => missingInCrm(l.crm_negotiation_code));
  toCheck.forEach((lead, i) => {
    if (verdicts[i] === true) {
      const snap = missingSnapshot();
      out.naoEncontrados++;
      decide(lead, snap);
    } else if (verdicts[i] === false) out.foraDoRelatorio++;
    else out.semResposta++;
  });

  if (!opts.dryRun) await st.applyCrm({ changes, touch, syncEm: new Date(now).toISOString() });
  if (opts.detalhes) out.detalhes = detalhes;
  out.duracaoMs = Date.now() - t0;
  log('concluída:', { leads: out.leads, conciliados: out.conciliados, atualizados: out.atualizados, naoEncontrados: out.naoEncontrados, foraDoRelatorio: out.foraDoRelatorio, semResposta: out.semResposta, diasComFalha: out.diasComFalha.length, parcial: out.parcial, ms: out.duracaoMs, simulacao: out.simulacao });
  return out;
}

// opts (só para testes/pré-visualização): store (outro armazenamento), dryRun (não grava), detalhes, now, maxMs
async function reconcile(opts) {
  opts = opts || {};
  if (!token()) return { ok: false, status: 503, error: 'no_token' };
  if (running) return { ok: false, status: 409, error: 'em_andamento', desde: runningSince };
  running = true; runningSince = Date.now();
  try {
    const out = await run(opts);
    return Object.assign({ status: 200 }, out);
  } catch (e) {
    log('falhou:', e && e.message);
    if (e && e.fatal) return { ok: false, status: 502, error: e.fatal };
    if (defaultStore.isSchemaMissing(e)) return { ok: false, status: 503, error: 'migration_pendente' };
    if (/Supabase/i.test((e && e.message) || '')) return { ok: false, status: 502, error: 'store_unavailable' };
    return { ok: false, status: 502, error: 'crm_indisponivel' };
  } finally { running = false; }
}

// estado para a tela: token configurado? rodando? última conciliação e quantos leads já conciliados
async function status(opts) {
  const st = (opts && opts.store) || defaultStore;
  return Object.assign({ configurado: !!token(), emAndamento: running }, await st.crmStatus());
}

module.exports = {
  reconcile, status,
  _t: { clean, norm, parseBrDate, parseBrl, brtDay, addDays, daysBetween, snapshot, missingSnapshot, same, earliest, KEEP, DEFAULT_RULES }
};
