'use strict';
/*
  Login do painel interno (/painel) — via Supabase Auth: cadastro ABERTO (qualquer pessoa cria uma
  conta com e-mail/senha) e qualquer conta válida vê TODOS os leads (é um painel de gestão só, sem
  permissão por pessoa). O navegador fala com o Supabase Auth direto (chave "anon", pública) pra
  cadastrar/entrar; o SERVIDOR só confere se o token que o Supabase devolveu é válido (1 chamada,
  só no login) e, se for, cria a MESMA sessão de sempre: um cookie assinado (HMAC-SHA256) — o resto
  do painel (rotas, páginas, /api/painel/*) continua igual, sem nenhuma outra dependência do
  Supabase Auth depois do login.

  PAINEL_SESSION_SECRET (cofre) continua sendo o segredo que assina esse cookie — trocar ele
  desloga todo mundo de uma vez. Nada disso é logado nem devolvido ao navegador em nenhuma resposta.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG_PATH = process.env.SUPABASE_CONFIG || path.join(ROOT, 'config', 'supabase.json');
const COOKIE = 'painel_sessao';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) { return null; } }

function configured() {
  if (!process.env.PAINEL_SESSION_SECRET) return false;
  const cfg = loadCfg();
  return !!(cfg && cfg.url && cfg.anonKey);
}

// compara em tempo constante mesmo quando os tamanhos diferem (evita vazar o tamanho por timing)
function safeEqual(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
  return crypto.timingSafeEqual(ab, bb);
}

function hmac(payload) {
  return crypto.createHmac('sha256', process.env.PAINEL_SESSION_SECRET).update(payload).digest('base64url');
}

// confere com o próprio Supabase se o token de acesso (que o navegador recebeu ao cadastrar/entrar)
// é válido. Devolve o e-mail da conta se for, ou null. É a ÚNICA vez que o Supabase Auth é
// consultado — depois disso a sessão é 100% nossa (cookie assinado), sem depender de mais nada.
async function verifySupabaseToken(accessToken) {
  if (!accessToken) return null;
  const cfg = loadCfg();
  if (!cfg || !cfg.url || !cfg.anonKey) return null;
  try {
    const res = await fetch(cfg.url.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + accessToken, apikey: cfg.anonKey }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.email ? user.email : null;
  } catch (e) { return null; }
}

function createSessionCookie(email) {
  const payload = Buffer.from(JSON.stringify({ u: email, exp: Date.now() + TTL_MS }), 'utf8').toString('base64url');
  const token = payload + '.' + hmac(payload);
  return COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(TTL_MS / 1000);
}

function clearSessionCookie() {
  return COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  const part = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  return part ? part.slice(COOKIE.length + 1) : null;
}

function verifyToken(token) {
  if (!process.env.PAINEL_SESSION_SECRET || !token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  const expected = hmac(payload);
  if (!safeEqual(sig, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!data || typeof data.exp !== 'number' || Date.now() > data.exp) return null;
  return data;
}

function isAuthenticated(req) {
  return !!verifyToken(readCookie(req));
}

// e-mail da conta logada (ou null) — usado só pra registrar quem criou um disparo
function sessionUser(req) {
  const d = verifyToken(readCookie(req));
  return d && d.u ? d.u : null;
}

// limite de tentativas de login por IP (não é sobre o /api/lead — usa seu próprio contador)
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
function rateLimited(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  attempts.set(ip, list);
  if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some((t) => now - t < WINDOW_MS)) attempts.delete(k);
  return list.length > MAX_ATTEMPTS;
}

module.exports = { configured, verifySupabaseToken, createSessionCookie, clearSessionCookie, isAuthenticated, sessionUser, rateLimited, COOKIE };
