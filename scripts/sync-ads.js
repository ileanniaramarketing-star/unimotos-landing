#!/usr/bin/env node
'use strict';
/*
  Sincroniza o GASTO dos anúncios (Meta Ads + Google Ads) com o painel: busca nas plataformas (só leitura), confere e grava na
  tabela ad_spend_diario do Supabase. Roda no computador de quem gerencia os anúncios — o servidor do site NÃO tem (nem precisa
  ter) acesso às contas de anúncio.

    npm run ads:sync                       busca tudo desde config/anuncios.json -> "desde" e grava
    npm run ads:sync -- --simular          busca e mostra o que seria gravado, sem gravar nada
    npm run ads:sync -- --desde 2026-11-01 --ate 2026-11-17
    npm run ads:sync -- --sem-buscar       só grava o arquivo da última busca (.local/ads-raw.json)

  Segredos: o Supabase vem do cofre deste projeto (npm run ads:sync já roda dentro dele); Meta e Google vêm do cofre da
  Niara Hub (veja scripts/ads-fetch.ps1). Nada de token é impresso.
*/
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const adspend = require('./lib/adspend');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const RAW = process.env.ADS_RAW || path.join(ROOT, '.local', 'ads-raw.json');
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const brl = (n) => 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const die = (m) => { console.error('\n✖ ' + m); process.exit(1); };

(async () => {
  if (!flag('sem-buscar')) {
    const a = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'ads-fetch.ps1'), '-Saida', RAW];
    if (opt('desde')) a.push('-Desde', opt('desde'));
    if (opt('ate')) a.push('-Ate', opt('ate'));
    const r = spawnSync(process.env.PWSH || 'pwsh', a, { stdio: 'inherit', env: process.env });
    if (r.error && r.error.code === 'ENOENT') die('PowerShell 7 ("pwsh") não encontrado. Instale em https://aka.ms/powershell ou defina PWSH com o caminho dele.');
    if (r.status !== 0) die('A busca nas plataformas falhou (veja a mensagem acima). Nada foi gravado.');
  }
  if (!fs.existsSync(RAW)) die('Arquivo da busca não encontrado: ' + RAW + ' (rode sem --sem-buscar).');
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const { ok, erros } = adspend.validateRows(raw.linhas);
  if (erros.length) { erros.slice(0, 10).forEach((e) => console.error('  - ' + e)); die(erros.length + ' linha(s) inválida(s) na busca — nada foi gravado.'); }
  if (!ok.length) die('A busca não trouxe nenhuma linha de gasto (' + raw.desde + ' a ' + raw.ate + '). Nada foi gravado.');

  console.log('\nBusca de ' + raw.desde + ' a ' + raw.ate + ' (gerada em ' + raw.geradoEm + ')');
  for (const p of ['meta', 'google']) {
    const camp = ok.filter((r) => r.plataforma === p && r.nivel === 'campanha');
    if (!camp.length) continue;
    const dias = new Set(camp.map((r) => r.dia));
    console.log('  ' + p.padEnd(7) + brl(camp.reduce((s, r) => s + r.investimento, 0)).padStart(14) + ' em ' + new Set(camp.map((r) => r.campanha_id)).size + ' campanha(s), ' + dias.size + ' dia(s) com gasto, ' + ok.filter((r) => r.plataforma === p && r.nivel === 'anuncio').length + ' linhas de anúncio');
  }
  if (flag('simular')) { console.log('\n(simulação: nada foi gravado)'); return; }

  if (!process.env.SUPABASE_SERVICE_KEY) die('SUPABASE_SERVICE_KEY ausente — rode pelo cofre: npm run ads:sync');
  try {
    await store.upsertAdSpend(ok);
  } catch (e) {
    if (store.isAdsMissing(e)) die('A tabela ad_spend_diario ainda não existe no Supabase — aplique supabase/migrations/0006_ad_spend_diario.sql primeiro.');
    die('Não consegui gravar no Supabase: ' + e.message);
  }
  const info = await store.adSpendInfo();
  console.log('\n✔ ' + ok.length + ' linhas gravadas. Gasto disponível no painel de ' + info.desde + ' a ' + info.ate + '.');
})().catch((e) => die(e.message));
