// Gera dist/ com apenas os arquivos públicos da landing (sem dependências, sem bundler).
// Uso: npm run build
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
const PUBLIC = ['index.html', 'motos', 'carros', 'css', 'js', 'assets'];

function build() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const item of PUBLIC) {
    const src = path.join(root, item);
    if (!fs.existsSync(src)) throw new Error('Arquivo/pasta obrigatório não encontrado: ' + item);
    fs.cpSync(src, path.join(out, item), { recursive: true });
  }
  console.log('dist/ pronto (' + PUBLIC.join(', ') + ')');
  return out;
}

if (require.main === module) build();
module.exports = build;
