'use strict';
/*
  Cruza o GASTO dos anúncios (tabela ad_spend_diario, gravada por scripts/sync-ads.js) com os leads do painel.
  Funções puras (sem rede, sem banco): o store.js busca os dados e chama estas funções; assim dá para testar o cruzamento sozinho.

  Como um lead é ligado a uma campanha/anúncio (nesta ordem, só o que for CONFIRMADO — nunca "parecido"):
    campanha: 1) utm_id numérico = ID da campanha (sobrevive a renomeações)   2) utm_campaign = nome da campanha
              3) apelido explícito em config/anuncios.json (utm_campaign antigo -> ID da campanha atual)
    anúncio : utm_content = nome do anúncio (Meta) ou ID do anúncio (Google)
  Nomes são comparados sem acento, sem maiúsculas e ignorando pontuação ("[IMG" e "[IMG]" são o mesmo).
*/

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// 'meta' | 'google' | null, a partir do utm_source do lead (mesma regra do envio ao CRM)
function platformOfSource(src) {
  const s = String(src || '').toLowerCase();
  if (/google|gads|adwords/.test(s)) return 'google';
  if (/insta|face|meta|^fb$|^ig$/.test(s)) return 'meta';
  return null;
}

const round2 = (n) => Math.round(n * 100) / 100;
const zero = () => ({ investimento: 0, impressoes: 0, cliques: 0, leadsPlataforma: 0, contatosPlataforma: 0 });
function add(t, r) {
  t.investimento += Number(r.investimento) || 0; t.impressoes += Number(r.impressoes) || 0; t.cliques += Number(r.cliques) || 0;
  t.leadsPlataforma += Number(r.leads_plataforma) || 0; t.contatosPlataforma += Number(r.contatos_plataforma) || 0;
}

// rows = linhas de ad_spend_diario do período; aliases = { "utm_campaign antigo": "id da campanha" }
function buildModel(rows, aliases) {
  const campaigns = new Map(); // id -> { id, plataforma, nome, ...totais }
  const ads = new Map();       // chave normalizada (nome do anúncio ou ID) -> { key, label, plataforma, campanhaIds:Set, ...totais }
  const lastDay = new Map();   // id da campanha -> dia mais recente (para ficar com o nome mais novo se foi renomeada)
  for (const r of rows || []) {
    if (r.nivel === 'campanha') {
      let c = campaigns.get(r.campanha_id);
      if (!c) { c = Object.assign({ id: r.campanha_id, plataforma: r.plataforma, nome: r.campanha_nome || '' }, zero()); campaigns.set(r.campanha_id, c); }
      if (!lastDay.has(r.campanha_id) || r.dia >= lastDay.get(r.campanha_id)) { lastDay.set(r.campanha_id, r.dia); if (r.campanha_nome) c.nome = r.campanha_nome; }
      add(c, r);
    } else if (r.nivel === 'anuncio') {
      const label = r.anuncio_nome || r.anuncio_id || '';
      const key = norm(label);
      if (!key) continue;
      let a = ads.get(key);
      if (!a) { a = Object.assign({ key, label, plataforma: r.plataforma, campanhaIds: new Set() }, zero()); ads.set(key, a); }
      a.campanhaIds.add(r.campanha_id);
      add(a, r);
    }
  }
  const byName = new Map(); // nome normalizado -> ids (se 2 campanhas tiverem o mesmo nome, é ambíguo e não liga por nome)
  for (const c of campaigns.values()) { const k = norm(c.nome); if (k) { if (!byName.has(k)) byName.set(k, new Set()); byName.get(k).add(c.id); } }
  const alias = new Map();
  for (const [k, v] of Object.entries(aliases || {})) if (!k.startsWith('_') && v) alias.set(norm(k), String(v));

  function resolveCampaign(utmId, utmCampaign) {
    const id = String(utmId || '').trim();
    if (/^\d{6,}$/.test(id) && campaigns.has(id)) return id;
    const k = norm(utmCampaign);
    if (!k) return null;
    const hit = byName.get(k);
    if (hit && hit.size === 1) return [...hit][0];
    if (alias.has(k)) return alias.get(k);
    return null;
  }
  const resolveAd = (utmContent) => { const k = norm(utmContent); return k && ads.has(k) ? k : null; };
  return { campaigns, ads, resolveCampaign, resolveAd };
}

// soma dos totais de um conjunto de campanhas
function sumCampaigns(model, pred) {
  const t = zero();
  for (const c of model.campaigns.values()) if (!pred || pred(c)) add(t, { investimento: c.investimento, impressoes: c.impressoes, cliques: c.cliques, leads_plataforma: c.leadsPlataforma, contatos_plataforma: c.contatosPlataforma });
  t.investimento = round2(t.investimento);
  return t;
}

// custo = investimento ÷ quantidade (null quando não há como calcular)
const cost = (inv, n) => (inv > 0 && n > 0 ? round2(inv / n) : null);

// confere as linhas que vêm do extrator (scripts/ads-fetch.ps1) ANTES de gravar: uma linha estranha não pode sujar o banco.
// Devolve { ok:[linhas limpas], erros:[mensagens] } — quem chama decide abortar se houver qualquer erro.
const COLS_TXT = ['campanha_nome', 'anuncio_nome'];
function validateRows(rows) {
  const ok = [], erros = [], seen = new Set();
  (Array.isArray(rows) ? rows : []).forEach((r, i) => {
    const where = 'linha ' + (i + 1);
    const bad = (m) => erros.push(where + ': ' + m);
    if (!r || typeof r !== 'object') return bad('não é um objeto');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.dia || '')) return bad('dia inválido (' + r.dia + ')');
    if (!['meta', 'google'].includes(r.plataforma)) return bad('plataforma inválida (' + r.plataforma + ')');
    if (!['campanha', 'anuncio'].includes(r.nivel)) return bad('nível inválido (' + r.nivel + ')');
    if (!String(r.campanha_id || '').trim()) return bad('campanha_id vazio');
    if (r.nivel === 'anuncio' && !String(r.anuncio_id || '').trim()) return bad('anuncio_id vazio numa linha de anúncio');
    const n = (v) => (v == null ? null : Number(v));
    for (const c of ['investimento', 'impressoes', 'cliques']) { const v = n(r[c]); if (v == null || !Number.isFinite(v) || v < 0) return bad(c + ' inválido (' + r[c] + ')'); }
    for (const c of ['leads_plataforma', 'contatos_plataforma']) { const v = n(r[c]); if (v != null && (!Number.isFinite(v) || v < 0)) return bad(c + ' inválido (' + r[c] + ')'); }
    const key = [r.dia, r.plataforma, r.nivel, r.campanha_id, r.nivel === 'campanha' ? '' : r.anuncio_id].join('|');
    if (seen.has(key)) return bad('linha repetida (' + key + ')');
    seen.add(key);
    const clean = {
      dia: r.dia, plataforma: r.plataforma, nivel: r.nivel, campanha_id: String(r.campanha_id), anuncio_id: r.nivel === 'campanha' ? '' : String(r.anuncio_id),
      investimento: round2(Number(r.investimento)), impressoes: Math.round(Number(r.impressoes)), cliques: Math.round(Number(r.cliques)),
      leads_plataforma: n(r.leads_plataforma) == null ? null : round2(n(r.leads_plataforma)), contatos_plataforma: n(r.contatos_plataforma) == null ? null : round2(n(r.contatos_plataforma))
    };
    for (const c of COLS_TXT) clean[c] = r[c] ? String(r[c]).slice(0, 300) : null;
    ok.push(clean);
  });
  return { ok, erros };
}

module.exports = { norm, platformOfSource, buildModel, sumCampaigns, cost, round2, validateRows };
