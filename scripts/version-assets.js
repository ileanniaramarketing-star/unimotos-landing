'use strict';
/*
  Versiona os arquivos estáticos nas páginas: /css/style.css -> /css/style.css?v=3fa9c1d2
  O "v" é um hash do CONTEÚDO do arquivo. Muda o CSS/JS => muda o endereço => o navegador/CDN
  busca a versão nova. Isso evita o defeito "HTML novo + CSS velho em cache" depois de um deploy
  (ícones gigantes, espaço vazio no topo etc.).

  Roda sozinho no `npm run build` e no pre-commit (para hospedagem estática sem build).
  Uso manual: node scripts/version-assets.js
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PAGES = ['index.html', 'motos/index.html', 'carros/index.html'];
const REF = /((?:href|src)=")(\/(?:css|js|assets\/(?:vendor|brand|partners))\/[^"?#]+)(?:\?v=[0-9a-f]+)?(")/g;

// hash independe de CRLF/LF (Windows x Linux geram o mesmo valor)
function hashOf(root, rel) {
  const txt = fs.readFileSync(path.join(root, rel)).toString('latin1').replace(/\r\n/g, '\n');
  return crypto.createHash('sha1').update(Buffer.from(txt, 'latin1')).digest('hex').slice(0, 8);
}

function run(root) {
  root = root || ROOT;
  const changed = [];
  for (const page of PAGES) {
    const file = path.join(root, page);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(REF, (m, pre, url, post) => {
      const rel = url.replace(/^\//, '');
      if (!fs.existsSync(path.join(root, rel))) return m; // arquivo não existe: deixa como está
      return pre + url + '?v=' + hashOf(root, rel) + post;
    });
    if (after !== before) { fs.writeFileSync(file, after, 'utf8'); changed.push(page); }
  }
  return changed;
}

if (require.main === module) {
  const c = run();
  console.log(c.length ? 'versões atualizadas em: ' + c.join(', ') : 'versões já estavam em dia');
}
module.exports = { run, hashOf };
