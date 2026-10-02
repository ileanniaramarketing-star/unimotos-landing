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
    async function supabaseAuth(path, email, password, extra) {
      // redirect_to explícito: o link do e-mail volta pra tela de login do painel (não pra "/")
      const sep = path.includes('?') ? '&' : '?';
      const url = cfg.supabaseUrl + '/auth/v1/' + path + (path.startsWith('signup') || path === 'resend' ? sep + 'redirect_to=' + encodeURIComponent(location.origin + '/painel/login') : '');
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey },
        body: JSON.stringify(Object.assign({ email, password }, extra || {}))
      });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data: j };
    }

    // botão "reenviar e-mail de confirmação" (link vence em 1h / pode ser consumido por antivírus de e-mail)
    function showResend(email) {
      let b = $('#resendBtn');
      if (!b) { b = document.createElement('button'); b.id = 'resendBtn'; b.type = 'button'; b.className = 'painel-link'; b.textContent = 'Reenviar e-mail de confirmação'; msg.insertAdjacentElement('afterend', b); }
      b.hidden = false;
      b.onclick = async () => {
        b.disabled = true;
        try {
          const r = await supabaseAuth('resend', email, undefined, { type: 'signup' });
          if (r.ok) showMsg('Enviamos um novo e-mail de confirmação. Clique no link mais recente.', true);
          else if (r.status === 429) showMsg('Limite de e-mails atingido. Aguarde cerca de 1 hora e tente de novo.');
          else showMsg('Não deu para reenviar agora. Tente novamente.');
        } catch (e) { showMsg('Falha de conexão. Tente de novo.'); }
        finally { b.disabled = false; }
      };
    }

    // link de confirmação do e-mail volta pra cá com o token no #hash (ou um erro, se o link venceu):
    // entra direto, sem pedir senha de novo.
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (hash.get('access_token') || hash.get('error_code')) {
      history.replaceState(null, '', location.pathname);
      if (hash.get('error_code')) showMsg('Esse link de confirmação venceu ou já foi usado. Tente entrar com e-mail e senha; se não der, cadastre-se de novo.');
      else {
        fetch('/api/painel/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: hash.get('access_token') }) })
          .then((r) => { if (r.ok) location.href = '/painel/'; else showMsg('E-mail confirmado! Agora entre com seu e-mail e senha.', true); })
          .catch(() => showMsg('E-mail confirmado! Agora entre com seu e-mail e senha.', true));
      }
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
            const code = (res.data && (res.data.error_code || res.data.code)) || '';
            const m = (res.data && (res.data.msg || res.data.error_description)) || '';
            if (code === 'email_not_confirmed' || /not confirmed/i.test(m)) {
              showMsg('Seu e-mail ainda não foi confirmado. Abra o e-mail "Confirm your email address" (veja o spam) e clique no link. Se o link venceu, peça outro abaixo.');
              showResend(email);
            }
            else if (res.status === 429) showMsg('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
            else if (res.status === 400) showMsg('E-mail ou senha incorretos.');
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
   * DISPAROS EM MASSA (WhatsApp via Z-API) — a fila roda no servidor; aqui só
   * montamos a lista/mensagem/mídia, iniciamos e acompanhamos o andamento.
   * ------------------------------------------------------------------ */
  const normKey = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const digitsOf = (s) => String(s == null ? '' : s).replace(/\D/g, '');
  const looksPhone = (s) => digitsOf(s).length >= 10 && digitsOf(s).length <= 14;

  function splitCsvLine(line, d) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === d) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  // texto colado / .csv -> { rows:[{nome,telefone,vars}], extras:[nomes das colunas extras] }
  function parseContacts(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (!lines.length) return { rows: [], extras: [] };
    const counts = [';', '\t', ','].map((d) => [d, lines[0].split(d).length - 1]).sort((a, b) => b[1] - a[1])[0];
    const delim = counts[1] > 0 ? counts[0] : null;
    const cells = (l) => {
      if (delim) return splitCsvLine(l, delim);
      const m = /^(.*?)[\s]+(\+?[\d()\-\s.]{10,})$/.exec(l.trim()); // "Maria 31999991111"
      if (m && m[1].trim()) return [m[1].trim(), m[2].trim()];
      return looksPhone(l) ? ['', l.trim()] : [l.trim()]; // só o telefone -> sem nome
    };
    let first = cells(lines[0]);
    const hasHeader = !first.some(looksPhone);
    let header = null, body = lines;
    if (hasHeader) { header = first.map((h, i) => normKey(h) || 'col' + (i + 1)); body = lines.slice(1); }
    const sample = cells(body[0] || '');
    let phoneIdx = header ? header.findIndex((h) => /(tel|cel|whats|fone|phone|numero)/.test(h)) : -1;
    if (phoneIdx < 0) phoneIdx = sample.findIndex(looksPhone);
    if (phoneIdx < 0) phoneIdx = 0;
    let nameIdx = header ? header.findIndex((h, i) => i !== phoneIdx && /(nome|name|cliente)/.test(h)) : -1;
    if (nameIdx < 0) nameIdx = sample.findIndex((c, i) => i !== phoneIdx);
    const names = (header || sample.map((_, i) => 'col' + (i + 1))).map((h, i) => (i === phoneIdx ? 'telefone' : i === nameIdx ? 'nome' : h));
    const extras = names.filter((n) => n !== 'telefone' && n !== 'nome');
    const rows = body.map((l) => {
      const c = cells(l); const vars = {};
      names.forEach((n, i) => { if (n !== 'telefone' && n !== 'nome' && c[i] !== undefined && c[i] !== '') vars[n] = c[i]; });
      return { nome: nameIdx >= 0 ? (c[nameIdx] || '') : '', telefone: c[phoneIdx] || '', vars };
    }).filter((r) => r.telefone);
    return { rows, extras };
  }

  function initDisparos() {
    const $d = (id) => document.getElementById(id);
    const form = $d('dispForm'); if (!form) return { active() {} };
    const msgEl = $d('dMsg'), statusEl = $d('dispStatus'), listaEl = $d('dLista'), msgBox = $d('dMensagem');
    let midia = null, pollTimer = null, openId = null, sending = false;

    const showMsg = (t, ok) => { msgEl.textContent = t; msgEl.className = 'painel-msg ' + (ok ? 'painel-msg--ok' : 'painel-msg--erro'); msgEl.hidden = false; };
    async function call(method, path, body) {
      const r = await fetch('/api/painel/disparos' + path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 401) { location.href = '/painel/login'; return { ok: false, status: 401, data: {} }; }
      return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
    }
    const ERR = {
      mensagem_vazia: 'Escreva a mensagem (ou escolha uma foto/vídeo).', lista_vazia: 'A lista de contatos está vazia.', nenhum_telefone_valido: 'Nenhum telefone válido na lista (use DDD + número).',
      lista_grande: 'Lista grande demais. Divida em disparos menores.', mensagem_longa: 'Mensagem longa demais (máximo 4000 caracteres).', not_configured: 'A Z-API ainda não foi configurada no servidor.',
      rate_limited: 'Muitos testes seguidos. Aguarde alguns minutos.', telefone_invalido: 'Telefone de teste inválido (use DDD + número).', envio_falhou: 'A Z-API recusou o envio.',
      midia_invalida: 'Mídia inválida. Envie o arquivo de novo.', intervalo_invalido: 'Intervalo inválido.'
    };
    const errText = (d, fb) => ERR[d && d.error] || fb;

    // ----- lista de contatos -----
    function parsed() { return parseContacts(listaEl.value); }
    function refreshList() {
      const { rows, extras } = parsed();
      const ok = rows.filter((r) => digitsOf(r.telefone).length >= 10).length;
      $d('dListaInfo').textContent = rows.length ? ok + ' contato(s) com telefone' + (rows.length - ok ? ' · ' + (rows.length - ok) + ' inválido(s)' : '') : 'Nenhum contato ainda.';
      const box = $d('dVars'); box.textContent = '';
      for (const v of ['nome', 'primeiro_nome'].concat(extras)) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = '{' + v + '}';
        b.addEventListener('click', () => { const s = msgBox.selectionStart || msgBox.value.length, e = msgBox.selectionEnd || s; msgBox.value = msgBox.value.slice(0, s) + '{' + v + '}' + msgBox.value.slice(e); msgBox.focus(); msgBox.selectionStart = msgBox.selectionEnd = s + v.length + 2; });
        box.appendChild(b);
      }
      refreshTime(ok);
    }
    function refreshTime(n) {
      const min = Number($d('dMin').value) || 15, max = Number($d('dMax').value) || min;
      const count = n == null ? parsed().rows.length : n;
      const sec = count * ((min + max) / 2), h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
      $d('dTempo').textContent = count ? 'Tempo estimado: ' + (h ? h + ' h ' : '') + m + ' min (um envio a cada ' + min + '–' + max + ' s, de forma aleatória, para proteger o número).' : '';
    }
    listaEl.addEventListener('input', refreshList);
    $d('dMin').addEventListener('input', () => refreshTime()); $d('dMax').addEventListener('input', () => refreshTime());
    $d('dArquivo').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { listaEl.value = await f.text(); refreshList(); } catch (e2) { showMsg('Não deu para ler o arquivo.'); }
      e.target.value = '';
    });

    // ----- mídia -----
    function clearMedia() { midia = null; $d('dMidiaPreview').textContent = ''; $d('dMidiaInfo').textContent = ''; $d('dMidiaRemover').hidden = true; }
    $d('dMidiaRemover').addEventListener('click', clearMedia);
    $d('dMidia').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      const isVideo = f.type === 'video/mp4', isImg = /^image\/(jpeg|png|webp)$/.test(f.type);
      if (!isVideo && !isImg) { showMsg('Formato não aceito. Use JPG, PNG, WEBP ou MP4.'); return; }
      if (f.size > (isVideo ? 16 : 5) * 1024 * 1024) { showMsg(isVideo ? 'Vídeo acima de 16 MB.' : 'Foto acima de 5 MB.'); return; }
      $d('dMidiaInfo').textContent = 'Enviando arquivo…'; msgEl.hidden = true;
      try {
        const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(f); });
        const r = await call('POST', '/midia', { contentType: f.type, data: String(dataUrl).split(',')[1] });
        if (!r.ok) { $d('dMidiaInfo').textContent = ''; showMsg(r.status === 413 ? 'Arquivo grande demais.' : 'Não deu para enviar o arquivo. Tente de novo.'); return; }
        midia = { url: r.data.url, tipo: r.data.tipo };
        $d('dMidiaInfo').textContent = f.name; $d('dMidiaRemover').hidden = false;
        const pv = $d('dMidiaPreview'); pv.textContent = '';
        const el = document.createElement(isVideo ? 'video' : 'img'); el.src = URL.createObjectURL(f); if (isVideo) el.controls = true; else el.alt = 'Prévia'; pv.appendChild(el);
      } catch (e2) { $d('dMidiaInfo').textContent = ''; showMsg('Falha ao enviar o arquivo.'); }
    });

    // ----- teste e início -----
    $d('dTesteBtn').addEventListener('click', async () => {
      msgEl.hidden = true; const btn = $d('dTesteBtn'); btn.disabled = true;
      const first = parsed().rows[0] || {};
      try {
        const r = await call('POST', '/teste', { telefone: $d('dTeste').value, mensagem: msgBox.value, nome: first.nome || 'Cliente', vars: first.vars || {}, midia });
        showMsg(r.ok ? 'Teste enviado! Confira no seu WhatsApp.' : errText(r.data, 'Não deu para enviar o teste.'), r.ok);
      } catch (e) { showMsg('Falha de conexão.'); } finally { btn.disabled = false; }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); if (sending) return; msgEl.hidden = true;
      const { rows } = parsed();
      if (!rows.length) { showMsg(ERR.lista_vazia); return; }
      if (!msgBox.value.trim() && !midia) { showMsg(ERR.mensagem_vazia); return; }
      const min = Number($d('dMin').value) || 15, max = Number($d('dMax').value) || min;
      if (!confirm('Iniciar o disparo para ' + rows.length + ' contato(s), com um envio a cada ' + min + '–' + max + ' segundos?\n\nDepois de iniciado dá para pausar ou cancelar.')) return;
      sending = true; const btn = $d('dIniciar'); btn.disabled = true;
      try {
        const r = await call('POST', '', { nome: $d('dNome').value, mensagem: msgBox.value, midia, intervaloMin: min, intervaloMax: max, destinatarios: rows });
        if (!r.ok) { showMsg(errText(r.data, r.status === 413 ? 'Lista grande demais.' : 'Não deu para iniciar o disparo agora.')); return; }
        const d = r.data; showMsg('Disparo iniciado para ' + d.total + ' contato(s)' + (d.invalidos ? ' · ' + d.invalidos + ' telefone(s) inválido(s) ignorado(s)' : '') + (d.duplicados ? ' · ' + d.duplicados + ' repetido(s) ignorado(s)' : '') + '.', true);
        form.reset(); clearMedia(); refreshList(); refresh();
      } catch (e2) { showMsg('Falha de conexão.'); } finally { sending = false; btn.disabled = false; }
    });

    // ----- acompanhamento -----
    const STATUS = { rodando: 'Enviando', pausado: 'Pausado', concluido: 'Concluído', cancelado: 'Cancelado', pendente: 'Na fila', enviando: 'Enviando', enviado: 'Enviado', falhou: 'Falhou' };
    const badge = (s) => { const sp = document.createElement('span'); sp.className = 'status-badge status-' + s; sp.textContent = STATUS[s] || s; return sp; };
    const txt = (tag, t, cls) => { const el = document.createElement(tag); el.textContent = t; if (cls) el.className = cls; return el; };
    function actionBtn(label, fn) { const b = txt('button', label, 'disp-link'); b.type = 'button'; b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } finally { refresh(); } }); return b; }

    function renderList(camps) {
      const box = $d('dLista2'); box.textContent = '';
      if (!camps.length) { box.appendChild(txt('p', 'Nenhum disparo ainda.', 'disp-hint')); return; }
      for (const c of camps) {
        const item = document.createElement('div'); item.className = 'disp-item';
        const top = document.createElement('div'); top.className = 'disp-item__top';
        top.append(txt('span', c.nome, 'disp-item__name'), badge(c.status));
        const done = c.enviados + c.falhas, pct = c.total ? Math.round((done / c.total) * 100) : 0;
        const bar = document.createElement('div'); bar.className = 'disp-bar'; const fill = document.createElement('i'); fill.style.width = pct + '%'; bar.appendChild(fill);
        const meta = txt('div', c.enviados + ' enviado(s) · ' + c.falhas + ' falha(s) · ' + c.restantes + ' restante(s) de ' + c.total + ' — ' + fmtDate(c.criadoEm), 'disp-item__meta');
        const act = document.createElement('div'); act.className = 'disp-actions';
        if (c.status === 'rodando') act.appendChild(actionBtn('Pausar', () => call('POST', '/' + c.id + '/pausar', {})));
        if (c.status === 'pausado') act.appendChild(actionBtn('Retomar', () => call('POST', '/' + c.id + '/retomar', {})));
        if (c.status === 'rodando' || c.status === 'pausado') act.appendChild(actionBtn('Cancelar', async () => { if (confirm('Cancelar este disparo? Quem ainda não recebeu não receberá.')) await call('POST', '/' + c.id + '/cancelar', {}); }));
        const ver = txt('button', openId === c.id ? 'Ocultar contatos' : 'Ver contatos', 'disp-link'); ver.type = 'button';
        ver.addEventListener('click', () => { openId = openId === c.id ? null : c.id; refresh(); }); act.appendChild(ver);
        item.append(top, bar, meta);
        if (c.motivo && c.status === 'pausado') item.appendChild(txt('div', c.motivo, 'disp-motivo'));
        item.appendChild(act);
        box.appendChild(item);
      }
    }
    async function renderDetail() {
      const box = $d('dDetalhe'); box.hidden = !openId; if (!openId) { box.textContent = ''; return; }
      const r = await call('GET', '/' + openId); if (!r.ok) return;
      const c = r.data.campanha; box.textContent = '';
      box.appendChild(txt('h3', 'Contatos de “' + c.nome + '”', 'disp-hint'));
      const wrap = document.createElement('div'); wrap.className = 'painel-table-wrap disp-detail-table';
      const t = document.createElement('table'); t.className = 'painel-table';
      const head = document.createElement('tr'); ['Nome', 'Telefone', 'Status', 'Detalhe'].forEach((h) => head.appendChild(txt('th', h)));
      const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
      const tb = document.createElement('tbody');
      for (const d of c.destinatarios) {
        const tr = document.createElement('tr'); const st = document.createElement('td'); st.appendChild(badge(d.status));
        tr.append(txt('td', d.nome || '—'), txt('td', fmtPhone(d.telefone)), st, txt('td', d.erro || (d.enviadoEm ? fmtDate(d.enviadoEm) : '—')));
        tb.appendChild(tr);
      }
      t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
      if (c.total > c.destinatarios.length) box.appendChild(txt('p', 'Mostrando os primeiros ' + c.destinatarios.length + ' de ' + c.total + '.', 'disp-hint'));
    }
    async function refresh() {
      try {
        const r = await call('GET', ''); if (!r.ok) return;
        const z = r.data.zapi || {};
        statusEl.className = 'disp-status ' + (z.connected ? 'is-ok' : 'is-bad');
        statusEl.textContent = !z.configured ? 'Z-API não configurada no servidor (faltam ZAPI_INSTANCE_ID, ZAPI_TOKEN e ZAPI_CLIENT_TOKEN). Dá para montar o disparo, mas ele só envia depois de configurar.'
          : z.connected ? 'WhatsApp conectado. Limite de ' + r.data.limiteDiario + ' envios por dia (proteção do número).'
          : 'WhatsApp DESCONECTADO na Z-API — reconecte lendo o QR code no painel da Z-API. Os disparos ficam parados até lá.';
        renderList(r.data.campanhas || []); await renderDetail();
      } catch (e) { /* tenta de novo no próximo ciclo */ }
    }
    refreshList();
    return {
      active(on) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (on) { refresh(); pollTimer = setInterval(refresh, 5000); }
      }
    };
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
    const tabs = { leads: $('#tabBtnLeads'), relatorios: $('#tabBtnRelatorios'), disparos: $('#tabBtnDisparos') };
    const panels = { leads: $('#painelLeads'), relatorios: $('#painelRelatorios'), disparos: $('#painelDisparos') };
    let reportsLoaded = false;
    const disparos = initDisparos();
    function showTab(name) {
      for (const k of Object.keys(tabs)) { tabs[k].classList.toggle('is-active', k === name); tabs[k].setAttribute('aria-selected', String(k === name)); panels[k].hidden = k !== name; }
      if (name === 'relatorios' && !reportsLoaded) { reportsLoaded = true; loadReports(); }
      disparos.active(name === 'disparos');
    }
    tabs.leads.addEventListener('click', () => showTab('leads'));
    tabs.relatorios.addEventListener('click', () => showTab('relatorios'));
    tabs.disparos.addEventListener('click', () => showTab('disparos'));

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
