<#
  Busca o GASTO e os resultados diários dos anúncios da Unimotos no Meta Ads e no Google Ads e grava num arquivo local
  (.local\ads-raw.json). SÓ LEITURA nas plataformas — nenhuma campanha é alterada.

  Os acessos NÃO ficam neste projeto: usa o cofre da Niara Hub (C:\NIARA-HUB-IA-ADS, ou a pasta em $env:NIARA_HUB).
  O token do Meta que enxerga a conta é descoberto sozinho (testa os tokens do cofre); o do Google vem do cofre da Hub.
  Nada de token aparece na tela nem no arquivo gerado.

  Uso (normalmente via `npm run ads:sync`, que também grava no Supabase):
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\ads-fetch.ps1 [-Desde 2026-09-01] [-Ate 2026-11-17] [-Saida .local\ads-raw.json]

  Linhas geradas (uma por dia):
    nivel='campanha'  -> total da campanha no dia (fonte da verdade do investimento)
    nivel='anuncio'   -> detalhe por anúncio (Meta: nome do anúncio = utm_content; Google: ID do anúncio = utm_content)
  Meta: cliques = cliques no link (o que chega na página); leads_plataforma = ação "lead"; contatos_plataforma = conversas no WhatsApp.
  Google: leads_plataforma = conversões cujo nome casa com google.acaoLead (config/anuncios.json); contatos_plataforma = as demais (ex.: ligações).
#>
[CmdletBinding()]
param(
  [string]$Desde = '',
  [string]$Ate = '',
  [string]$Saida = '',
  [string]$Hub = $(if ($env:NIARA_HUB) { $env:NIARA_HUB } else { 'C:\NIARA-HUB-IA-ADS' })
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
$cfg = Get-Content (Join-Path $Root 'config\anuncios.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Desde) { $Desde = $cfg.desde }
if (-not $Ate) { $Ate = (Get-Date).ToString('yyyy-MM-dd') }
if (-not $Saida) { $Saida = Join-Path $Root '.local\ads-raw.json' }
if (-not (Test-Path (Join-Path $Hub 'lib\Bootstrap.psm1'))) { throw "Niara Hub não encontrada em '$Hub' (defina `$env:NIARA_HUB ou use -Hub)." }

# os módulos da Hub só imprimem avisos de "segredos carregados" — silenciados; o token nunca é impresso
Import-Module (Join-Path $Hub 'lib\Bootstrap.psm1') -Force -Global *> $null
Import-Module (Join-Path $Hub 'lib\MetaGraph.psm1') -Force -Global *> $null
Import-Module (Join-Path $Hub 'lib\GoogleAds.psm1') -Force -Global *> $null

$rows = New-Object System.Collections.Generic.List[object]
function Add-Row($dia, $plat, $nivel, $campId, $campNome, $adId, $adNome, $inv, $impr, $cliq, $leads, $contatos) {
  $rows.Add([pscustomobject][ordered]@{
    dia = $dia; plataforma = $plat; nivel = $nivel; campanha_id = [string]$campId; campanha_nome = [string]$campNome
    anuncio_id = [string]$adId; anuncio_nome = [string]$adNome
    investimento = [math]::Round([double]$inv, 2); impressoes = [long]$impr; cliques = [long]$cliq
    leads_plataforma = $leads; contatos_plataforma = $contatos
  })
}
$summary = [ordered]@{}

# ------------------------------------------------------------------ META
Write-Host "Meta Ads: conta $($cfg.meta.contaId) ($Desde a $Ate)"
$ver = Get-MetaGraphVersion
$conta = $cfg.meta.contaId
$token = $null
foreach ($e in (Get-MetaStoredTokens)) {   # descobre qual token do cofre enxerga a conta (sem depender de número de "slot")
  try { $null = Invoke-RestMethod -Uri ("https://graph.facebook.com/$ver/$conta" + '?fields=id&access_token=' + [uri]::EscapeDataString($e.token)); $token = $e.token; break } catch { }
}
if (-not $token) { throw "Nenhum token do cofre da Niara Hub enxerga a conta Meta $conta." }

function Get-MetaPages([string]$path, [hashtable]$q) {
  $qs = ($q.GetEnumerator() | ForEach-Object { "$($_.Key)=" + [uri]::EscapeDataString([string]$_.Value) }) -join '&'
  $url = "https://graph.facebook.com/$ver/$path`?$qs&access_token=" + [uri]::EscapeDataString($token)
  $out = New-Object System.Collections.Generic.List[object]
  $pages = 0
  while ($url -and $pages -lt 40) {
    $r = $null
    foreach ($try in 1..3) {
      try { $r = Invoke-RestMethod -Uri $url; break }
      catch {
        $msg = ''; try { $msg = [string]$_.ErrorDetails.Message } catch { }
        # 1/2 = instabilidade passageira do Meta; 4/17/32/613/80000/80004 = limite de chamadas -> espera e tenta de novo
        if ($try -eq 3 -or $msg -notmatch '"code":\s*(1|2|4|17|32|613|80000|80004)\b') { throw ("Meta: " + ($msg -replace 'access_token=[^&"\s]+', 'access_token=***')) }
        Start-Sleep -Seconds (8 * $try)
      }
    }
    foreach ($x in @($r.data)) { $out.Add($x) }
    $url = $r.paging.next; $pages++
  }
  return $out
}
function Get-Act($acts, [string]$type) { foreach ($a in @($acts)) { if ($a.action_type -eq $type) { return [double]$a.value } } return 0 }

# pede em janelas de 30 dias: consultas diárias de períodos longos podem dar "serviço indisponível" no Meta
function Get-MetaDaily([string]$level, [string]$fields) {
  $all = New-Object System.Collections.Generic.List[object]
  $a = [datetime]::ParseExact($Desde, 'yyyy-MM-dd', $null); $fim = [datetime]::ParseExact($Ate, 'yyyy-MM-dd', $null)
  while ($a -le $fim) {
    $b = $a.AddDays(29); if ($b -gt $fim) { $b = $fim }
    $range = "{'since':'$($a.ToString('yyyy-MM-dd'))','until':'$($b.ToString('yyyy-MM-dd'))'}"
    foreach ($x in (Get-MetaPages "$conta/insights" @{ level = $level; time_increment = 1; time_range = $range; limit = 200; fields = $fields })) { $all.Add($x) }
    $a = $b.AddDays(1); Start-Sleep -Milliseconds 700
  }
  return $all
}
$metaCamp = Get-MetaDaily 'campaign' 'campaign_id,campaign_name,spend,impressions,clicks,actions'
foreach ($i in $metaCamp) {
  $cliq = Get-Act $i.actions 'link_click'; if ($cliq -eq 0 -and $i.clicks) { $cliq = [double]$i.clicks }
  Add-Row $i.date_start 'meta' 'campanha' $i.campaign_id $i.campaign_name '' '' $i.spend $i.impressions $cliq (Get-Act $i.actions 'lead') (Get-Act $i.actions 'onsite_conversion.messaging_conversation_started_7d')
}
$metaAd = Get-MetaDaily 'ad' 'campaign_id,campaign_name,ad_id,ad_name,spend,impressions,clicks,actions'
foreach ($i in $metaAd) {
  $cliq = Get-Act $i.actions 'link_click'; if ($cliq -eq 0 -and $i.clicks) { $cliq = [double]$i.clicks }
  Add-Row $i.date_start 'meta' 'anuncio' $i.campaign_id $i.campaign_name $i.ad_id $i.ad_name $i.spend $i.impressions $cliq (Get-Act $i.actions 'lead') (Get-Act $i.actions 'onsite_conversion.messaging_conversation_started_7d')
}
$summary.meta = [ordered]@{ campanha = @($metaCamp).Count; anuncio = @($metaAd).Count }

# ------------------------------------------------------------------ GOOGLE
Write-Host "Google Ads: conta $($cfg.google.customerId) ($Desde a $Ate)"
$ctx = New-GoogleContext -CustomerId $cfg.google.customerId -LoginCustomerId $cfg.google.loginCustomerId
function Q([string]$q) { foreach ($i in 1..3) { try { return @(Search-GoogleAds -Ctx $ctx -Query $q) } catch { if ($i -eq 3) { throw }; Start-Sleep -Seconds (3 * $i) } } }
$between = "segments.date BETWEEN '$Desde' AND '$Ate'"
$acaoLead = [string]$cfg.google.acaoLead

# conversões por ação (para separar "lead do formulário" de "ligação" etc.)
$conv = @{}
foreach ($r in (Q "SELECT segments.date, campaign.id, segments.conversion_action_name, metrics.conversions FROM campaign WHERE $between AND metrics.conversions > 0")) {
  $k = "$($r.segments.date)|$($r.campaign.id)"
  if (-not $conv.ContainsKey($k)) { $conv[$k] = @{ lead = 0.0; outras = 0.0 } }
  if ([string]$r.segments.conversionActionName -match $acaoLead) { $conv[$k].lead += [double]$r.metrics.conversions } else { $conv[$k].outras += [double]$r.metrics.conversions }
}
$gCamp = Q "SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE $between AND campaign.status != 'REMOVED' AND metrics.impressions > 0"
foreach ($r in $gCamp) {
  $k = "$($r.segments.date)|$($r.campaign.id)"; $c = $conv[$k]
  Add-Row $r.segments.date 'google' 'campanha' $r.campaign.id $r.campaign.name '' '' ([double]$r.metrics.costMicros / 1e6) $r.metrics.impressions $r.metrics.clicks $(if ($c) { $c.lead } else { 0 }) $(if ($c) { $c.outras } else { 0 })
}
$gAd = Q "SELECT segments.date, campaign.id, campaign.name, ad_group_ad.ad.id, metrics.cost_micros, metrics.impressions, metrics.clicks FROM ad_group_ad WHERE $between AND campaign.status != 'REMOVED' AND metrics.impressions > 0"
foreach ($r in $gAd) {
  Add-Row $r.segments.date 'google' 'anuncio' $r.campaign.id $r.campaign.name $r.adGroupAd.ad.id '' ([double]$r.metrics.costMicros / 1e6) $r.metrics.impressions $r.metrics.clicks $null $null
}
$summary.google = [ordered]@{ campanha = @($gCamp).Count; anuncio = @($gAd).Count }

# ------------------------------------------------------------------ saída
$dir = Split-Path -Parent $Saida
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$payload = [ordered]@{ geradoEm = (Get-Date).ToUniversalTime().ToString('o'); desde = $Desde; ate = $Ate; contas = [ordered]@{ meta = $conta; google = [string]$cfg.google.customerId }; linhas = $rows }
[IO.File]::WriteAllText($Saida, ($payload | ConvertTo-Json -Depth 6 -Compress), (New-Object Text.UTF8Encoding($false)))

$br = [Globalization.CultureInfo]::GetCultureInfo('pt-BR')
foreach ($p in 'meta', 'google') {
  $tot = ($rows | Where-Object { $_.plataforma -eq $p -and $_.nivel -eq 'campanha' } | Measure-Object investimento -Sum).Sum
  Write-Host ("  {0}: {1} linhas de campanha, {2} de anúncio | investimento no período: R$ {3}" -f $p, $summary[$p].campanha, $summary[$p].anuncio, ([double]$tot).ToString('N2', $br))
}
Write-Host "Arquivo gerado: $Saida"
