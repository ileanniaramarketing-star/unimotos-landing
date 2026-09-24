// Servidor da landing (sem dependências): arquivos estáticos + /api/lead (encaminha ao Power CRM).
//   npm start                 serve dist/ (produção; porta = PORT da hospedagem)
//   npm run dev               serve os arquivos-fonte em 127.0.0.1:4321, com o cofre carregado
// Flags: --port 4321  --host 127.0.0.1  --src (serve os arquivos-fonte em vez de dist/)
//
// SEGURANÇA: segredos (POWERCRM_TOKEN) só existem aqui, no servidor, como variável de ambiente.
// Nada em index.html, css/, js/ ou assets/ referencia ou recebe o token.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const build = require('./build');
const { processLead } = require('./lib/lead');
const { status: crmStatus } = require('./lib/powercrm');

const has = (name) => process.argv.includes('--' + name);
const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : undefined; };
const PORT = Number(arg('port') || process.env.PORT || 3000);
const HOST = arg('host') || process.env.HOST || '0.0.0.0';
const SRC = has('src');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const PUBLIC = ['index.html', 'motos', 'carros', 'css', 'js', 'assets'];
let webRoot = root;
if (!SRC) { if (!fs.existsSync(path.join(dist, 'index.html'))) build(); webRoot = dist; }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.svg', '.json', '.txt']);
const gz = new Map();
const allowedHosts = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' };

function json(res, code, obj) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC));
  res.end(JSON.stringify(obj));
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // chamadas sem Origin (curl/servidor) não são navegador
  try {
    const h = new URL(o).host;
    return h === req.headers.host || h === req.headers['x-forwarded-host'] || allowedHosts.includes(h);
  } catch (e) { return false; }
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (over) return;                 // já estourou: descarta o resto (a conexão é fechada após a resposta 413)
      if (size > limit) { over = true; chunks.length = 0; reject(Object.assign(new Error('too_large'), { code: 413 })); }
      else chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(Object.assign(new Error('bad_json'), { code: 400 })); } });
    req.on('error', reject);
  });
}

async function api(req, res, p) {
  if (p === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, crm: crmStatus().state });
  if (p === '/api/lead') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });
    if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden' });
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'unsupported_media_type' });
    try {
      const body = await readJson(req);
      const out = await processLead(body, { ip: clientIp(req) });
      return json(res, out.status, out.body);
    } catch (e) {
      if (e.code === 413) { res.setHeader('Connection', 'close'); res.once('finish', () => req.destroy()); }
      return json(res, e.code || 400, { ok: false, error: e.message === 'too_large' ? 'too_large' : 'invalid' });
    }
  }
  return json(res, 404, { ok: false, error: 'not_found' });
}

function serveStatic(req, res, p) {
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(webRoot, p));
  if (!file.startsWith(webRoot + path.sep) && file !== webRoot) { res.writeHead(403, SEC); res.end('forbidden'); return; }
  if (SRC) { // modo dev: só expõe o que é público (nunca package.json, scripts/, config/, .local/, .git/…)
    const first = path.relative(webRoot, file).split(path.sep)[0];
    if (!PUBLIC.includes(first)) { res.writeHead(404, SEC); res.end('404'); return; }
  }
  fs.stat(file, (err, st) => {
    // /motos -> /motos/ (mantém a query string das campanhas: ?utm_source=...)
    if (!err && st.isDirectory() && !req.url.split('?')[0].endsWith('/')) {
      const q = req.url.indexOf('?') > -1 ? req.url.slice(req.url.indexOf('?')) : '';
      res.writeHead(301, Object.assign({ Location: req.url.split('?')[0] + '/' + q }, SEC)); res.end(); return;
    }
    if (err || !st.isFile()) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SEC)); res.end('404 - página não encontrada'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': SRC ? 'no-store' : (ext === '.html' ? 'no-cache' : 'public, max-age=3600')
    }, SEC);
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(500, SEC); res.end('erro'); return; }
      if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        const key = file + ':' + st.mtimeMs;
        if (!gz.has(key)) gz.set(key, zlib.gzipSync(buf, { level: 9 }));
        headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : gz.get(key)); return;
      }
      res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : buf);
    });
  });
}

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); res.end('bad request'); return; }
  if (p.startsWith('/api/')) { api(req, res, p).catch(() => json(res, 500, { ok: false, error: 'server_error' })); return; }
  serveStatic(req, res, p);
});

server.on('error', (e) => { console.error('Erro ao iniciar (' + e.code + ') na porta ' + PORT); process.exit(1); });
server.listen(PORT, HOST, () => {
  console.log('Unimotos LP em http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + (SRC ? '  [modo dev: arquivos-fonte]' : '  [dist/]'));
  console.log('CRM: ' + crmStatus().state);
});
