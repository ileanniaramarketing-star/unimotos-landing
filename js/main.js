/* ==========================================================================
   UNIMOTOS · comportamento da landing page
   1) configuração/rastreamento  2) formulário/FAQ/sticky (sem GSAP)
   3) animações premium (GSAP + ScrollTrigger + Lenis)
   ========================================================================== */
(() => {
  'use strict';

  const cfg = window.UNI_CONFIG || {};
  const root = document.documentElement;
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const formatPhone = (raw) => {
    const v = digits(raw).slice(0, 11);
    if (v.length > 10) return v.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
    if (v.length > 6) return v.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
    if (v.length > 2) return v.replace(/(\d{2})(\d{0,5})/, '($1) $2');
    return v ? '(' + v : '';
  };
  const phoneValid = (raw) => { const d = digits(raw); return (d.length === 10 || d.length === 11) && d[0] !== '0'; };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const hasGsap = !!(window.gsap && window.ScrollTrigger);
  // cada página declara seu veículo: <body data-vehicle="moto|carro">
  const VEHICLE = document.body.getAttribute('data-vehicle') === 'carro' ? 'carro' : 'moto';
  const NOUN = VEHICLE === 'carro' ? { de: 'do carro', seu: 'o seu carro' } : { de: 'da moto', seu: 'a sua moto' };

  /* ------------------------------------------------------------------ *
   * 1. RASTREAMENTO + CONFIG
   * ------------------------------------------------------------------ */
  window.dataLayer = window.dataLayer || [];

  // UTMs / click ids: guardados na sessão para irem junto com o lead
  const utm = (() => {
    const found = {};
    try {
      const p = new URLSearchParams(location.search);
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'].forEach((k) => {
        if (p.get(k)) found[k] = p.get(k);
      });
      if (Object.keys(found).length) sessionStorage.setItem('uni_utm', JSON.stringify(found));
      else return JSON.parse(sessionStorage.getItem('uni_utm') || '{}');
    } catch (e) { /* storage indisponível */ }
    return found;
  })();

  function injectScript(src, attrs) {
    const s = document.createElement('script');
    s.async = true; s.src = src;
    Object.assign(s, attrs || {});
    document.head.appendChild(s);
  }

  function loadTracking() {
    if (cfg.gtmId) {
      window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
      injectScript('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(cfg.gtmId));
    }
    if (cfg.ga4Id) {
      window.gtag = function () { window.dataLayer.push(arguments); };
      injectScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(cfg.ga4Id));
      window.gtag('js', new Date());
      window.gtag('config', cfg.ga4Id);
    }
    if (cfg.metaPixelId) {
      /* eslint-disable */
      !function (f, b, e, v, n, t, s) {
        if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
        if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
        t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
      }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      /* eslint-enable */
      window.fbq('init', cfg.metaPixelId);
      window.fbq('track', 'PageView');
    }
  }

  // name: 'Contact' (clique no WhatsApp) | 'Lead' (formulário enviado)
  function track(name, params) {
    const data = Object.assign({ veiculo: VEHICLE }, params || {}, utm);
    try {
      window.dataLayer.push(Object.assign({ event: name === 'Lead' ? 'generate_lead' : 'whatsapp_click' }, data));
      if (window.fbq) window.fbq('track', name, data);
      if (window.gtag) window.gtag('event', name === 'Lead' ? 'generate_lead' : 'whatsapp_click', data);
    } catch (e) { /* nunca quebrar a página por causa de tracking */ }
  }

  function waUrl(kind, extra) {
    const msgs = cfg.messages || {};
    let text = msgs[kind] || msgs.default || '';
    if (text && typeof text === 'object') text = text[VEHICLE] || ''; // mensagens podem ser { moto, carro }
    if (extra && extra.append) text += '\n\n' + extra.append;
    return 'https://wa.me/' + digits(cfg.whatsapp) + '?text=' + encodeURIComponent(text);
  }

  function applyConfig() {
    // todos os botões de WhatsApp
    $$('[data-wa]').forEach((a) => {
      a.href = waUrl('default');
      a.target = '_blank';
      a.rel = 'noopener';
      a.addEventListener('click', () => track('Contact', { cta: a.getAttribute('data-cta') || 'wa' }));
    });

    // fotos opcionais dos cards de estilo
    $$('.scard[data-cta]').forEach((card) => {
      const src = (cfg.photos || {})[card.getAttribute('data-cta').replace('estilo-', '')];
      if (src) card.style.setProperty('--img', 'url("' + src + '")');
    });

    // ligar (mobile)
    if (cfg.phone) {
      const call = $('#stickyCall');
      call.href = 'tel:+' + digits(cfg.phone);
      call.hidden = false;
      call.addEventListener('click', () => track('Contact', { cta: 'ligar' }));
    }

    // rodapé
    const f = cfg.footer || {};
    if (f.address) $('#footAddress').textContent = f.address;
    if (f.hours) { $('#footHours').textContent = f.hours; $('#finalHours').textContent = 'Atendimento: ' + f.hours; }
    if (f.instagram) { const a = $('#footIg'); a.href = f.instagram; a.hidden = false; }
    if (f.facebook) { const a = $('#footFb'); a.href = f.facebook; a.hidden = false; }
    $('#year').textContent = new Date().getFullYear();

    // números institucionais (config.js -> stats). Só aparece se houver itens.
    const stats = Array.isArray(cfg.stats) ? cfg.stats : [];
    if (stats.length) {
      const grid = $('#statsGrid');
      stats.forEach((st) => {
        const val = Number(st.value) || 0;
        const card = document.createElement('div'); card.className = 'stat'; card.setAttribute('data-reveal', '');
        const n = document.createElement('span'); n.className = 'stat__n';
        const pre = document.createElement('em'); pre.textContent = st.prefix || '';
        const num = document.createElement('span'); num.className = 'stat__num'; num.setAttribute('data-to', String(val)); num.textContent = val.toLocaleString('pt-BR');
        const suf = document.createElement('em'); suf.textContent = st.suffix || '';
        n.append(pre, num, suf);
        const l = document.createElement('span'); l.className = 'stat__l'; l.textContent = st.label || '';
        card.append(n, l); grid.appendChild(card);
      });
      $('#numeros').hidden = false;
    }

    // avaliações reais (opcional)
    const list = Array.isArray(cfg.reviews) ? cfg.reviews : [];
    if (list.length) {
      const grid = $('#reviewsGrid');
      list.forEach((r) => {
        const el = document.createElement('article');
        el.className = 'rcard';
        el.setAttribute('data-reveal', '');
        const stars = document.createElement('div');
        stars.className = 'rcard__stars';
        stars.textContent = '★'.repeat(Math.max(1, Math.min(5, r.stars || 5)));
        const p = document.createElement('p');
        p.textContent = '“' + (r.text || '') + '”';
        const n = document.createElement('strong');
        n.textContent = r.name || '';
        el.append(stars, p, n);
        grid.appendChild(el);
      });
      if (cfg.reviewsLink) { const a = $('#reviewsAll'); a.href = cfg.reviewsLink; a.hidden = false; }
      $('#avaliacoes').hidden = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * COTAÇÃO PELA PLACA (nome + WhatsApp + placa)  ->  /api/lead (servidor) -> Power CRM
   * O navegador NUNCA fala com o CRM nem vê o token: só envia o lead ao próprio servidor do site.
   * A consulta automática da placa é opcional: só roda se cfg.plateLookupUrl estiver preenchida.
   * ------------------------------------------------------------------ */
  function postLead(lead) {
    const url = cfg.leadWebhook;
    if (!url) return;
    try {
      if (url.charAt(0) === '/') { // mesma origem: servidor do próprio site (guarda o token do CRM)
        fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lead) }).catch(() => {});
      } else { // webhook externo (Make, n8n…): text/plain evita preflight de CORS
        fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(lead) }).catch(() => {});
      }
    } catch (e) { /* o WhatsApp abre de qualquer jeito */ }
  }

  function initQuote() {
    const form = $('#quoteForm');
    if (!form) return;
    const nameEl = $('#qName'), phoneEl = $('#qPhone'), plateEl = $('#qPlate'), trap = $('#qWebsite');
    const result = $('#plateResult'), success = $('#qSuccess'), fields = $('#qFields');
    const cache = new Map();
    let found = null; // dados do veículo vindos da consulta (se houver)
    let sent = false;
    let seq = 0;

    const normPlate = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
    // antiga: ABC1234 · Mercosul: ABC1D23
    const plateOk = (p) => /^[A-Z]{3}[0-9]{4}$/.test(p) || /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/.test(p);
    const setErr = (el, on) => el.closest('.field').classList.toggle('has-err', on);
    const clip = (v) => String(v == null ? '' : v).trim().slice(0, 60);

    function showResult(kind, c) {
      result.textContent = '';
      if (kind === 'none') { result.hidden = true; return; }
      result.hidden = false;
      if (kind === 'loading') { result.textContent = 'Buscando os dados ' + NOUN.de + '…'; return; }
      if (kind === 'miss') { result.textContent = 'Não conseguimos confirmar os dados agora. Sem problema: a equipe confere no atendimento.'; return; }
      // textContent (nunca innerHTML): a resposta da API não é confiável
      const t = document.createElement('strong'); t.textContent = [c.marca, c.modelo].filter(Boolean).join(' ');
      const s = document.createElement('span'); s.textContent = [c.ano, c.cor].filter(Boolean).join(' · ');
      const n = document.createElement('em'); n.textContent = 'Confira se é ' + NOUN.seu + '.';
      result.append(t); if (s.textContent) result.append(s); result.append(n);
    }

    async function lookup(plate) {
      if (cache.has(plate)) return cache.get(plate);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      try {
        const sep = cfg.plateLookupUrl.indexOf('?') > -1 ? '&' : '?';
        const r = await fetch(cfg.plateLookupUrl + sep + 'placa=' + encodeURIComponent(plate), { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('http ' + r.status);
        const j = await r.json();
        const out = j && (j.marca || j.modelo)
          ? { marca: clip(j.marca), modelo: clip(j.modelo), ano: clip(j.ano || j.anoModelo), cor: clip(j.cor) }
          : null;
        cache.set(plate, out);
        return out;
      } catch (e) {
        return null; // falha de rede/API nunca bloqueia o envio
      } finally { clearTimeout(timer); }
    }

    plateEl.addEventListener('input', () => {
      const p = normPlate(plateEl.value);
      plateEl.value = p;
      setErr(plateEl, false);
      found = null; showResult('none'); seq++;
      clearTimeout(plateEl._t);
      if (!cfg.plateLookupUrl || !plateOk(p)) return;
      const mine = seq;
      plateEl._t = setTimeout(async () => {
        showResult('loading');
        const r = await lookup(p);
        if (mine !== seq) return; // digitou outra placa enquanto buscava
        found = r;
        showResult(r ? 'ok' : 'miss', r);
      }, 350);
    });
    phoneEl.addEventListener('input', () => { phoneEl.value = formatPhone(phoneEl.value); setErr(phoneEl, false); });
    nameEl.addEventListener('input', () => setErr(nameEl, false));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const plate = normPlate(plateEl.value);
      const okName = nameEl.value.trim().length >= 2, okPhone = phoneValid(phoneEl.value), okPlate = plateOk(plate);
      setErr(nameEl, !okName); setErr(phoneEl, !okPhone); setErr(plateEl, !okPlate);
      if (!okName || !okPhone || !okPlate || sent) { (!okName ? nameEl : !okPhone ? phoneEl : plateEl).focus(); return; }
      sent = true;

      const lead = {
        veiculo: VEHICLE,
        nome: nameEl.value.trim(),
        telefone: '55' + digits(phoneEl.value),
        placa: plate,
        website: trap ? trap.value : '', // isca anti-robô: pessoas deixam vazio
        pagina: location.origin + location.pathname,
        data: new Date().toISOString()
      };
      if (found) Object.assign(lead, { marca: found.marca, modelo: found.modelo, ano: found.ano, cor: found.cor });
      Object.assign(lead, utm);

      // dados pessoais (nome, telefone, placa) NÃO vão para Meta/GA — só o tipo do lead
      track('Lead', { lead_type: 'cotacao', placa_consultada: !!found });
      postLead(lead);

      const linhas = ['Nome: ' + lead.nome, 'Placa: ' + plate];
      if (found) linhas.push('Veículo (consulta): ' + [found.marca, found.modelo, found.ano].filter(Boolean).join(' '));
      const url = waUrl('quote', { append: linhas.join('\n') });

      fields.hidden = true;
      success.hidden = false;
      $('#qSuccessCta').href = url;
      if (window.gsap && !reduce) {
        gsap.fromTo(success, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: .7, ease: 'power3.out' });
        gsap.fromTo($('.fsuccess__ring', success), { scale: .4 }, { scale: 1, duration: .9, ease: 'elastic.out(1,.5)' });
      }
      // abre o WhatsApp dentro do clique do usuário (não é bloqueado como pop-up)
      const w = window.open(url, '_blank', 'noopener');
      if (!w) location.href = url;
    });
  }

  /* ------------------------------------------------------------------ *
   * FAQ
   * ------------------------------------------------------------------ */
  function initFaq() {
    const items = $$('.acc__item');
    items.forEach((it) => {
      const btn = $('.acc__q', it);
      btn.addEventListener('click', () => {
        const open = !it.classList.contains('is-open');
        items.forEach((o) => { o.classList.remove('is-open'); $('.acc__q', o).setAttribute('aria-expanded', 'false'); });
        if (open) { it.classList.add('is-open'); btn.setAttribute('aria-expanded', 'true'); }
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Barra fixa mobile / botão flutuante / progresso / nav
   * ------------------------------------------------------------------ */
  function initChrome() {
    const nav = $('#nav');
    const bar = $('#progressBar');
    const sticky = $('#sticky');
    const float = $('#waFloat');
    const hero = $('#hero');
    let hideZone = 0; // >0 = form ou CTA final visíveis (já têm CTA próprio)

    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { hideZone += e.isIntersecting ? 1 : -1; });
      hideZone = Math.max(0, hideZone);
      update();
    }, { threshold: .25 });
    ['#cotacao', '#final'].forEach((sel) => io.observe($(sel)));

    function update() {
      const y = window.scrollY || 0;
      const h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.transform = 'scaleX(' + (h > 0 ? Math.min(1, y / h) : 0) + ')';
      nav.classList.toggle('is-solid', y > 24);
      const on = y > hero.offsetHeight * .55 && hideZone === 0;
      sticky.classList.toggle('is-on', on);
      float.classList.toggle('is-on', y > hero.offsetHeight * .35);
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  /* ------------------------------------------------------------------ *
   * 3. ANIMAÇÕES
   * ------------------------------------------------------------------ */
  // ----- painel de instrumentos (tacômetro) -----
  const G = { v: 0, scroll: 0, hover: 0, intro: true, visible: true };
  const CX = 200, CY = 200;
  const NS = 'http://www.w3.org/2000/svg';
  const polar = (r, deg) => { const a = deg * Math.PI / 180; return [CX + r * Math.sin(a), CY - r * Math.cos(a)]; };

  function buildGauge() {
    const svgTicks = $('#gTicks'), svgNums = $('#gNums');
    if (!svgTicks) return null;
    const R = 178;
    const [x0, y0] = polar(R, -135), [x1, y1] = polar(R, 135);
    const d = 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A' + R + ' ' + R + ' 0 1 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2);
    $('#gTrack').setAttribute('d', d);
    $('#gFill').setAttribute('d', d);

    for (let i = 0; i <= 60; i++) {
      const major = i % 5 === 0;
      const deg = -135 + 270 * (i / 60);
      const [ax, ay] = polar(major ? 156 : 163, deg);
      const [bx, by] = polar(171, deg);
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', ax.toFixed(2)); l.setAttribute('y1', ay.toFixed(2));
      l.setAttribute('x2', bx.toFixed(2)); l.setAttribute('y2', by.toFixed(2));
      l.setAttribute('class', 'g-tick' + (major ? ' is-major' : '') + (i >= 45 ? ' is-red' : ''));
      svgTicks.appendChild(l);
    }
    for (let n = 0; n <= 12; n++) {
      const [tx, ty] = polar(134, -135 + 270 * (n / 12));
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', tx.toFixed(2)); t.setAttribute('y', ty.toFixed(2));
      t.setAttribute('class', 'g-num' + (n >= 9 ? ' is-red' : ''));
      t.textContent = n;
      svgNums.appendChild(t);
    }
    return { needle: $('#gNeedle'), fill: $('#gFill'), speed: $('#gSpeed') };
  }

  const gaugeEls = buildGauge();
  function renderGauge() {
    if (!gaugeEls) return;
    const v = Math.max(0, Math.min(1, G.v));
    const deg = -135 + 270 * v;
    gaugeEls.needle.setAttribute('transform', 'rotate(' + deg.toFixed(2) + ' 200 200)');
    gaugeEls.fill.style.strokeDashoffset = (1 - v).toFixed(4);
    const kmh = Math.round(Math.max(0, v - .1) / .9 * 240);
    gaugeEls.speed.textContent = String(kmh).padStart(3, '0');
  }
  G.v = .09; renderGauge();

  // ----- utilidades de texto -----
  function splitWords(el) {
    const walk = (node) => {
      Array.from(node.childNodes).forEach((n) => {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach((p) => {
            if (!p) return;
            if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(' ')); return; }
            const w = document.createElement('span'); w.className = 'w';
            const i = document.createElement('span'); i.textContent = p;
            w.appendChild(i); frag.appendChild(w);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1) walk(n);
      });
    };
    walk(el);
  }

  function initMotion() {
    gsap.registerPlugin(ScrollTrigger);

    // ----- rolagem suave -----
    let lenis = null;
    if (window.Lenis) {
      lenis = new Lenis({ lerp: .085, smoothWheel: true });
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add((t) => lenis.raf(t * 1000));
      gsap.ticker.lagSmoothing(0);
    }
    const scrollToEl = (target) => {
      if (!target) return;
      if (lenis) lenis.scrollTo(target, { offset: -72, duration: 1.5 });
      else target.scrollIntoView({ behavior: 'smooth' });
    };
    $$('a[href^="#"]').forEach((a) => {
      if (a.hasAttribute('data-wa')) return;
      a.addEventListener('click', (e) => {
        const id = a.getAttribute('href');
        const t = id === '#top' ? document.body : $(id);
        if (!t) return;
        e.preventDefault();
        if (id === '#top') { lenis ? lenis.scrollTo(0, { duration: 1.4 }) : window.scrollTo({ top: 0, behavior: 'smooth' }); } else scrollToEl(t);
      });
    });

    // ----- títulos: revelação por palavra -----
    $$('[data-split]').forEach((el) => {
      splitWords(el);
      const spans = $$('.w > span', el);
      gsap.set(spans, { yPercent: 115, y: 0 }); // y:0 zera o translateY(px) que o GSAP lê do CSS inicial
      ScrollTrigger.create({
        trigger: el, start: 'top 90%', once: true,
        onEnter: () => gsap.to(spans, { yPercent: 0, duration: 1.05, ease: 'power4.out', stagger: .055 })
      });
    });

    // ----- blocos: fade + sobe, em lote (stagger natural em grids) -----
    const reveals = $$('[data-reveal]');
    gsap.set(reveals, { opacity: 0, y: 34 });
    ScrollTrigger.batch(reveals, {
      start: 'top 90%', once: true,
      onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 1, ease: 'power3.out', stagger: .1, overwrite: 'auto' })
    });

    // ----- HERO: entrada -----
    const introTitle = $$('#heroTitle .line > span');
    gsap.set(introTitle, { yPercent: 112, y: 0 });
    const intro = gsap.timeline({ defaults: { ease: 'power4.out' } });
    intro
      .to(introTitle, { yPercent: 0, duration: 1.15, stagger: .13 }, .05)
      .fromTo('[data-hero="pill"]', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: .8 }, 0)
      .fromTo('[data-hero="sub"]', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .9 }, .5)
      .fromTo('[data-hero="cta"]', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .9 }, .62)
      .fromTo('[data-hero="proof"]', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .9 }, .76)
      .fromTo('[data-hero="visual"]', { opacity: 0 }, { opacity: 1, duration: .9 }, .15)
      .fromTo('.gauge__svg', { scale: .8, rotation: -14 }, { scale: 1, rotation: 0, duration: 1.5, ease: 'expo.out' }, .15)
      .fromTo('.chip', { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, duration: .8, stagger: .12, ease: 'back.out(1.7)' }, .95);

    // "dar uma acelerada" ao abrir a página
    G.v = 0; renderGauge();
    gsap.timeline({ delay: .45, onComplete: () => { G.intro = false; } })
      .to(G, { v: 1, duration: 1.05, ease: 'power2.in', onUpdate: renderGauge })
      .to(G, { v: .09, duration: 1.6, ease: 'power3.out', onUpdate: renderGauge });

    // ponteiro vivo: marcha lenta, reage ao scroll e ao hover do CTA
    gsap.ticker.add((time) => {
      if (G.intro || !G.visible) return;
      const idle = .09 + Math.sin(time * 41) * .004 + Math.sin(time * 27) * .003;
      const target = idle + G.scroll * .6 + G.hover * .72;
      G.v += (target - G.v) * .09;
      renderGauge();
    });
    ScrollTrigger.create({
      trigger: '#hero', start: 'top top', end: 'bottom top',
      onUpdate: (s) => { G.scroll = s.progress; },
      onToggle: (s) => { G.visible = s.isActive; }
    });
    $$('#heroCta, .hero__cta .btn').forEach((b) => {
      b.addEventListener('pointerenter', () => gsap.to(G, { hover: 1, duration: .5, overwrite: true }));
      b.addEventListener('pointerleave', () => gsap.to(G, { hover: 0, duration: .9, overwrite: true }));
    });

    // parallax do hero ao rolar
    gsap.to('#bgText', { xPercent: -8, yPercent: -10, ease: 'none', scrollTrigger: { trigger: '#hero', start: 'top top', end: 'bottom top', scrub: true } });
    gsap.to('.hero__visual', { y: -70, ease: 'none', scrollTrigger: { trigger: '#hero', start: 'top top', end: 'bottom top', scrub: true } });

    // ----- riscos de velocidade (canvas) -----
    initStreaks();

    // ----- parallax de mouse no hero + cursor + botões magnéticos -----
    if (fine) {
      root.classList.add('has-cursor');
      const cur = $('#cursor');
      const cx = gsap.quickTo(cur, 'x', { duration: .35, ease: 'power3' });
      const cy = gsap.quickTo(cur, 'y', { duration: .35, ease: 'power3' });
      window.addEventListener('pointermove', (e) => { cx(e.clientX); cy(e.clientY); cur.classList.add('is-on'); }, { passive: true });
      document.addEventListener('pointerleave', () => cur.classList.remove('is-on'));
      $$('a, button, label, .acc__q, [data-tilt]').forEach((el) => {
        el.addEventListener('pointerenter', () => cur.classList.add('is-hover'));
        el.addEventListener('pointerleave', () => cur.classList.remove('is-hover'));
      });

      const hero = $('#hero');
      const gauge = $('#gauge');
      const chips = $$('.chip');
      const bg = $('#bgText');
      hero.addEventListener('pointermove', (e) => {
        const r = hero.getBoundingClientRect();
        const nx = (e.clientX - r.left) / r.width - .5;
        const ny = (e.clientY - r.top) / r.height - .5;
        gsap.to(gauge, { rotationY: nx * 14, rotationX: -ny * 14, transformPerspective: 900, duration: .9, ease: 'power3.out', overwrite: 'auto' });
        chips.forEach((c) => gsap.to(c, { x: nx * (+c.dataset.depth) * 2.2, y: ny * (+c.dataset.depth) * 2.2, duration: 1, ease: 'power3.out', overwrite: 'auto' }));
        gsap.to(bg, { x: nx * -40, duration: 1.2, ease: 'power3.out', overwrite: 'auto' });
      });
      hero.addEventListener('pointerleave', () => {
        gsap.to(gauge, { rotationY: 0, rotationX: 0, duration: 1.1, ease: 'power3.out' });
        gsap.to(chips, { x: 0, y: 0, duration: 1.1, ease: 'power3.out' });
      });

      $$('[data-magnetic]').forEach((el) => {
        el.addEventListener('pointermove', (e) => {
          const r = el.getBoundingClientRect();
          gsap.to(el, { x: (e.clientX - (r.left + r.width / 2)) * .28, y: (e.clientY - (r.top + r.height / 2)) * .38, duration: .45, ease: 'power3.out' });
        });
        el.addEventListener('pointerleave', () => gsap.to(el, { x: 0, y: 0, duration: .9, ease: 'elastic.out(1,.4)' }));
      });

      // cards: spotlight + tilt 3D
      $$('[data-tilt]').forEach((el) => {
        el.addEventListener('pointermove', (e) => {
          const r = el.getBoundingClientRect();
          const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
          el.style.setProperty('--mx', (px * 100) + '%');
          el.style.setProperty('--my', (py * 100) + '%');
          gsap.to(el, { rotationY: (px - .5) * 8, rotationX: -(py - .5) * 8, transformPerspective: 1000, duration: .6, ease: 'power2.out' });
        });
        el.addEventListener('pointerleave', () => gsap.to(el, { rotationX: 0, rotationY: 0, duration: .9, ease: 'power3.out' }));
      });
    }

    // ----- marquee: acelera com a velocidade do scroll -----
    const track = $('#marqueeTrack');
    const loop = gsap.to(track, { xPercent: -25, ease: 'none', duration: 16, repeat: -1 });
    let ts = 1, dir = 1;
    ScrollTrigger.create({
      onUpdate: (self) => {
        const v = self.getVelocity();
        if (Math.abs(v) > 30) { dir = v > 0 ? 1 : -1; ts = dir * (1 + Math.min(Math.abs(v) / 240, 9)); }
      }
    });
    gsap.ticker.add(() => { ts += (dir - ts) * .06; loop.timeScale(ts); });

    // ----- ESTILOS: scroll horizontal com pin (desktop) -----
    const mm = gsap.matchMedia();
    mm.add('(min-width: 980px) and (min-height: 620px)', () => {
      const section = $('#estilos'), pin = $('#stylesPin'), rail = $('#stylesRail'), trackEl = $('#stylesTrack'), progress = $('#stylesBar');
      section.classList.add('is-hpin');
      const cs = () => getComputedStyle(rail);
      const dist = () => Math.max(0, trackEl.offsetWidth + parseFloat(cs().paddingLeft) + parseFloat(cs().paddingRight) - window.innerWidth);
      gsap.to(trackEl, {
        x: () => -dist(), ease: 'none',
        scrollTrigger: {
          trigger: pin, start: 'top top', end: () => '+=' + dist(), pin: true, scrub: .7,
          anticipatePin: 1, invalidateOnRefresh: true,
          onUpdate: (s) => { progress.style.transform = 'scaleX(' + s.progress + ')'; }
        }
      });
      return () => { section.classList.remove('is-hpin'); gsap.set(trackEl, { clearProps: 'transform' }); };
    });

    // ----- COMO FUNCIONA: a moto "roda" pela estrada conforme o scroll -----
    const stepEls = $$('.step');
    mm.add('(min-width: 900px)', () => {
      const road = $('#road'), bike = $('#bike'), lane = $('.road__lane i');
      const draw = $$('.b-body path, .b-body circle, .b-tank-hi');
      gsap.set(draw, { strokeDashoffset: 1 });
      gsap.set(['.b-tank', '.b-seat'], { opacity: 0 });
      const wheels = $$('.b-wheel');
      gsap.set(wheels, { opacity: 0 });

      // 1) desenha a moto quando a estrada entra na tela
      gsap.timeline({ scrollTrigger: { trigger: road, start: 'top 88%', end: 'top 55%', scrub: .6 } })
        .to(draw, { strokeDashoffset: 0, duration: 1, stagger: .05, ease: 'none' })
        .to(['.b-tank', '.b-seat'].concat(wheels), { opacity: 1, duration: .6, stagger: .08 }, '-=.6');

      // 2) ela anda; rodas giram junto; passos acendem
      const maxX = () => road.offsetWidth - bike.getBoundingClientRect().width;
      const state = { p: 0 };
      gsap.timeline({
        scrollTrigger: {
          trigger: road, start: 'top 78%', end: 'top 12%', scrub: .5, invalidateOnRefresh: true,
          onUpdate: (s) => {
            const f = Math.min(1, (s.progress * maxX() + bike.getBoundingClientRect().width * .5) / road.offsetWidth);
            state.p = f;
            stepEls.forEach((el, i) => el.classList.toggle('is-on', f >= (i + .3) / 4));
            gsap.set(lane, { scaleX: f });
          }
        }
      })
        .to(bike, { x: () => maxX(), ease: 'none' }, 0)
        .to(wheels, { rotation: 1500, svgOrigin: (i, el) => el.getAttribute('data-origin'), ease: 'none' }, 0);

      return () => { stepEls.forEach((el) => el.classList.remove('is-on')); };
    });
    mm.add('(max-width: 899px)', () => {
      const triggers = stepEls.map((el) => ScrollTrigger.create({
        trigger: el, start: 'top 68%', end: 'bottom 32%',
        onToggle: (s) => el.classList.toggle('is-on', s.isActive || s.progress === 1)
      }));
      return () => { triggers.forEach((t) => t.kill()); stepEls.forEach((el) => el.classList.remove('is-on')); };
    });

    // ----- números institucionais: contagem ao entrar na tela -----
    $$('.stat__num').forEach((num) => {
      const to = Number(num.getAttribute('data-to')) || 0;
      const o = { v: 0 };
      num.textContent = '0';
      ScrollTrigger.create({
        trigger: num, start: 'top 90%', once: true,
        onEnter: () => gsap.to(o, { v: to, duration: 1.9, ease: 'power2.out', onUpdate: () => { num.textContent = Math.round(o.v).toLocaleString('pt-BR'); } })
      });
    });

    // ----- CTA final -----
    gsap.fromTo('.final__rings i', { scale: .3 }, { scale: 1, duration: 0 });
    gsap.from('.final__inner .btn', { scale: .85, opacity: 0, duration: 1.1, ease: 'elastic.out(1,.55)', scrollTrigger: { trigger: '.final__inner .btn', start: 'top 92%', once: true } });

    // depois que fontes/imagens carregam, recalcula posições
    const refresh = () => ScrollTrigger.refresh();
    window.addEventListener('load', refresh);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
  }

  // ----- riscos de velocidade -----
  function initStreaks() {
    const cv = $('#streaks');
    if (!cv || reduce) return;
    const ctx = cv.getContext('2d');
    const many = window.innerWidth >= 900;
    const N = many ? 42 : 16;
    let w = 0, h = 0, dpr = 1, lines = [];

    const spawn = (initial) => ({
      x: initial ? Math.random() * w : -Math.random() * 300 - 100,
      y: Math.random() * h,
      len: 90 + Math.random() * 300,
      sp: 3 + Math.random() * 9,
      a: .05 + Math.random() * .2,
      wd: Math.random() < .2 ? 2 : 1,
      red: Math.random() < .6
    });
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lines = Array.from({ length: N }, () => spawn(true));
    };
    resize();
    window.addEventListener('resize', resize);

    gsap.ticker.add(() => {
      if (!G.visible) return;
      ctx.clearRect(0, 0, w, h);
      const boost = 1 + G.v * 2.4;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        l.x += l.sp * boost;
        if (l.x - l.len > w) lines[i] = spawn(false);
        const g = ctx.createLinearGradient(l.x - l.len, 0, l.x, 0);
        const c = l.red ? '255,58,63' : '255,255,255';
        g.addColorStop(0, 'rgba(' + c + ',0)');
        g.addColorStop(1, 'rgba(' + c + ',' + (l.a * (.7 + G.v)).toFixed(3) + ')');
        ctx.fillStyle = g;
        ctx.fillRect(l.x - l.len, l.y, l.len, l.wd);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * BOOT
   * ------------------------------------------------------------------ */
  function boot() {
    loadTracking();
    applyConfig();
    initQuote();
    initFaq();
    initChrome();

    if (!hasGsap || reduce) {
      // sem animações: tudo visível, painel estático
      if (!hasGsap) { root.classList.remove('js'); root.classList.add('no-js'); }
      $$('.step').forEach((s) => s.classList.add('is-on'));
      $$('#stylesRail').forEach((r) => r.setAttribute('tabindex', '0'));
      return;
    }
    // espera as fontes (máx. 900ms) para não "pular" o texto durante a animação
    const fontsReady = document.fonts && document.fonts.ready ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 900))]) : Promise.resolve();
    fontsReady.then(initMotion).catch(() => { root.classList.remove('js'); root.classList.add('no-js'); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
