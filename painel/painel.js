/* ==========================================================================
   PAINEL INTERNO (/painel) — login estático, lista de leads e relatórios.
   JS simples (sem framework, sem dependências), como o resto do site.
   ========================================================================== */
(() => {
  'use strict';
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));

  const STATUS_LABEL = {
    sent: 'Enviado', 'dry-run': 'Simulado', retrying: 'Pendente', pendente: 'Pendente',
    failed: 'Falhou', duplicado: 'Duplicado', not_configured: 'CRM não configurado', no_token: 'CRM sem token'
  };
  const fmtDate = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fmtPhone = (e164) => { const d = String(e164 || '').replace(/\D/g, '').replace(/^55/, ''); return d.length >= 10 ? '(' + d.slice(0, 2) + ') ' + d.slice(2, -4) + '-' + d.slice(-4) : (e164 || ''); };

  /* ------------------------------------------------------------------ *
   * LOGIN / CADASTRO — fala direto com o Supabase Auth (chave pública "anon")
   * pra cadastrar ou entrar; o token que ele devolve é conferido pelo NOSSO
   * servidor uma única vez (/api/painel/login), que aí cria a sessão de sempre.
   * Cadastro é aberto: qualquer e-mail/senha válidos criam uma conta com
   * acesso a tudo (é um painel de gestão só, sem permissão por pessoa).
   * ------------------------------------------------------------------ */
  function initLogin() {
    const form = $('#loginForm'); if (!form) return;
    const btn = $('#loginBtn'), msg = $('#loginMsg'), toggle = $('#toggleModeBtn');
    const title = $('#loginTitle'), sub = $('#loginSub');
    const cfg = window.PAINEL_CONFIG || {};
    let mode = 'login'; // 'login' | 'signup'

    const showMsg = (t, ok) => { msg.textContent = t; msg.className = 'painel-msg ' + (ok ? 'painel-msg--ok' : 'painel-msg--erro'); msg.hidden = false; };

    function applyMode() {
      if (mode === 'login') {
        title.textContent = 'Painel interno'; sub.textContent = 'Entre com seu e-mail e senha.';
        btn.textContent = 'Entrar'; toggle.textContent = 'Ainda não tem conta? Cadastre-se';
      } else {
        title.textContent = 'Criar conta'; sub.textContent = 'Cadastre-se para acessar o painel.';
        btn.textContent = 'Cadastrar'; toggle.textContent = 'Já tem conta? Entrar';
      }
      msg.hidden = true;
    }
    toggle.addEventListener('click', () => { mode = mode === 'login' ? 'signup' : 'login'; applyMode(); });

    // pede ao Supabase Auth pra criar a conta ou entrar numa já existente
    async function supabaseAuth(path, email, password) {
      const r = await fetch(cfg.supabaseUrl + '/auth/v1/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey },
        body: JSON.stringify({ email, password })
      });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data: j };
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.hidden = true; btn.disabled = true;
      const email = $('#loginUser').value.trim(), pass = $('#loginPass').value;
      try {
        if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) { showMsg('O painel ainda não foi configurado.'); return; }

        let accessToken = null;
        if (mode === 'signup') {
          const res = await supabaseAuth('signup', email, pass);
          if (!res.ok) {
            const m = (res.data && res.data.msg) || (res.data && res.data.error_description) || '';
            if (res.status === 422 || /already registered|already exists/i.test(m)) showMsg('Esse e-mail já tem conta. Clique em "Já tem conta? Entrar".');
            else if (/password/i.test(m)) showMsg('Senha muito curta (mínimo 6 caracteres).');
            else showMsg('Não deu para cadastrar agora. Tente novamente.');
            return;
          }
          if (res.data && res.data.access_token) accessToken = res.data.access_token;
          else { showMsg('Conta criada! Confira seu e-mail para confirmar antes de entrar.', true); mode = 'login'; applyMode(); return; }
        } else {
          const res = await supabaseAuth('token?grant_type=password', email, pass);
          if (!res.ok) {
            if (res.status === 400) showMsg('E-mail ou senha incorretos.');
            else showMsg('Não deu para entrar agora. Tente novamente.');
            return;
          }
          accessToken = res.data && res.data.access_token;
        }
        if (!accessToken) { showMsg('Não deu para entrar agora. Tente novamente.'); return; }

        // token do Supabase confirmado pelo nosso servidor -> cria a sessão do painel (cookie de sempre)
        const r = await fetch('/api/painel/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken }) });
        if (r.ok) { location.href = '/painel/'; return; }
        if (r.status === 429) showMsg('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
        else if (r.status === 503) showMsg('O painel ainda não foi configurado (faltam as credenciais no servidor).');
        else showMsg('Não deu para confirmar a sessão agora. Tente novamente.');
      } catch (e2) { showMsg('Falha de conexão. Verifique a internet e tente de novo.'); }
      finally { btn.disabled = false; }
    });
  }

  /* ------------------------------------------------------------------ *
   * PAINEL (leads + relatórios)
   * ------------------------------------------------------------------ */
  function initPanel() {
    const shell = $('#painelLeads'); if (!shell) return;

    $('#logoutBtn').addEventListener('click', async () => {
      try { await fetch('/api/painel/logout', { method: 'POST' }); } catch (e) { /* segue mesmo assim */ }
      location.href = '/painel/login';
    });

    // ----- abas -----
    const tabs = { leads: $('#tabBtnLeads'), relatorios: $('#tabBtnRelatorios') };
    const panels = { leads: $('#painelLeads'), relatorios: $('#painelRelatorios') };
    let reportsLoaded = false;
    function showTab(name) {
      for (const k of Object.keys(tabs)) { tabs[k].classList.toggle('is-active', k === name); tabs[k].setAttribute('aria-selected', String(k === name)); panels[k].hidden = k !== name; }
      if (name === 'relatorios' && !reportsLoaded) { reportsLoaded = true; loadReports(); }
    }
    tabs.leads.addEventListener('click', () => showTab('leads'));
    tabs.relatorios.addEventListener('click', () => showTab('relatorios'));

    async function api(path) {
      const r = await fetch(path, { headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/painel/login'; return null; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }

    // ----- LEADS -----
    const leadsForm = $('#leadsFilters'), body = $('#leadsBody'), empty = $('#leadsEmpty'), countEl = $('#leadsCount');
    function paramsFrom(form) {
      const p = new URLSearchParams();
      new FormData(form).forEach((v, k) => { if (v) p.set(k, v); });
      return p;
    }
    function cell(text) { const td = document.createElement('td'); td.textContent = text == null || text === '' ? '—' : text; return td; }
    function statusBadge(status) {
      const td = document.createElement('td');
      const span = document.createElement('span');
      span.className = 'status-badge status-' + status;
      span.textContent = STATUS_LABEL[status] || status;
      td.appendChild(span);
      return td;
    }
    async function loadLeads() {
      const data = await api('/api/painel/leads?' + paramsFrom(leadsForm).toString());
      if (!data) return;
      body.textContent = '';
      countEl.textContent = data.total + (data.total === 1 ? ' lead encontrado' : ' leads encontrados') + (data.leads.length < data.total ? ' (mostrando os ' + data.leads.length + ' mais recentes)' : '');
      empty.hidden = data.leads.length > 0;
      for (const l of data.leads) {
        const tr = document.createElement('tr');
        tr.append(
          cell(fmtDate(l.ts)), cell(l.nome), cell(fmtPhone(l.telefone)), cell(l.placa), cell(l.veiculo === 'carro' ? 'Carro' : 'Moto'),
          cell(l.utm_source), cell(l.utm_campaign), cell(l.utm_content), cell(l.gclid), cell(l.fbclid),
          cell(l.seller), statusBadge(l.status)
        );
        body.appendChild(tr);
      }
    }
    leadsForm.addEventListener('submit', (e) => { e.preventDefault(); loadLeads().catch(() => { countEl.textContent = 'Não deu para carregar os leads agora.'; }); });

    // ----- RELATÓRIOS -----
    const reportForm = $('#reportFilters');
    function renderList(elId, rows, totalForPct) {
      const el = $(elId); el.textContent = '';
      if (!rows.length) { const p = document.createElement('p'); p.className = 'report-empty'; p.textContent = 'Sem dados ainda.'; el.appendChild(p); return; }
      for (const row of rows.slice(0, 12)) {
        const div = document.createElement('div'); div.className = 'report-row';
        const label = document.createElement('span'); label.textContent = row.label;
        const b = document.createElement('b'); b.textContent = row.count + (totalForPct ? ' (' + Math.round((row.count / totalForPct) * 100) + '%)' : '');
        div.append(label, b); el.appendChild(div);
      }
    }
    async function loadReports() {
      const data = await api('/api/painel/relatorios?' + paramsFrom(reportForm).toString());
      if (!data) return;
      $('#repTotal').firstChild.textContent = data.total;
      $('#repTotalSub').textContent = data.total === 1 ? 'lead no período' : 'leads no período';
      renderList('#repVeiculo', data.porVeiculo, data.total);
      renderList('#repPlataforma', data.porPlataforma, data.total);
      renderList('#repCampanha', data.porCampanha, data.total);
      renderList('#repCriativo', data.porCriativo, data.total);
      renderList('#repOrigem', data.porOrigemCrm);
      renderList('#repVendedor', data.porVendedor);
      renderList('#repStatus', data.porStatus, data.total);
    }
    reportForm.addEventListener('submit', (e) => { e.preventDefault(); loadReports().catch(() => {}); });

    loadLeads().catch(() => { countEl.textContent = 'Não deu para carregar os leads agora.'; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { initLogin(); initPanel(); });
  else { initLogin(); initPanel(); }
})();
