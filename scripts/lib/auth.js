'use strict';
/*
  Login do painel interno (/painel) — ESTÁTICO: um usuário e uma senha fixos, guardados no cofre
  (PAINEL_USER, PAINEL_PASS) + um segredo de assinatura (PAINEL_SESSION_SECRET). Sem banco de
  usuários, sem cadastro. A sessão é um cookie assinado (HMAC-SHA256): o servidor não guarda nada
  em memória além do limite de tentativas de login — reiniciar o processo não invalida sessões
  válidas, mas trocar PAINEL_SESSION_SECRET invalida todas de uma vez.

  Nada disso é logado nem devolvido ao navegador em nenhuma resposta.
*/
const crypto = require('crypto');

const COOKIE = 'painel_sessao';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

function configured() {
  return !!(process.env.PAINEL_USER && process.env.PAINEL_PASS && process.env.PAINEL_SESSION_SECRET);
}

// compara em tempo constante mesmo quando os tamanhos diferem (evita vazar o tamanho da senha certa)
function safeEqual(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
  return crypto.timingSafeEqual(ab, bb);
}

function hmac(payload) {
  return crypto.createHmac('sha256', process.env.PAINEL_SESSION_SECRET).update(payload).digest('base64url');
}

function checkCredentials(user, pass) {
  if (!configured()) return false;
  const okUser = safeEqual(user, process.env.PAINEL_USER);
  const okPass = safeEqual(pass, process.env.PAINEL_PASS);
  return okUser && okPass;
}

function createSessionCookie(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + TTL_MS }), 'utf8').toString('base64url');
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
  if (!configured() || !token) return null;
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

module.exports = { configured, checkCredentials, createSessionCookie, clearSessionCookie, isAuthenticated, rateLimited, COOKIE };
