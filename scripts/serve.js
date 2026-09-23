// Servidor estático mínimo (sem dependências) que serve a pasta dist/.
// Em hospedagem Node usa a porta do ambiente (PORT); localmente: npm run dev
// Flags opcionais: --port 4321 --host 127.0.0.1
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const build = require('./build');

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : undefined; };
const PORT = Number(arg('port') || process.env.PORT || 3000);
const HOST = arg('host') || process.env.HOST || '0.0.0.0';

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) build();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.svg', '.json', '.txt']);
const gz = new Map(); // cache: arquivo+mtime -> buffer gzip

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); res.end('bad request'); return; }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(dist, p));
  if (!file.startsWith(dist + path.sep) && file !== dist) { res.writeHead(403); res.end('forbidden'); return; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 - página não encontrada'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    };
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(500); res.end('erro'); return; }
      if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        const key = file + ':' + st.mtimeMs;
        if (!gz.has(key)) gz.set(key, zlib.gzipSync(buf, { level: 9 }));
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : gz.get(key));
        return;
      }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  });
});

server.on('error', (e) => { console.error('Erro ao iniciar (' + e.code + ') na porta ' + PORT); process.exit(1); });
server.listen(PORT, HOST, () => console.log('Unimotos LP em http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT));
