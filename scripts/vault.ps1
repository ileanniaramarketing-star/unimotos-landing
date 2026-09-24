<#
  Cofre local de segredos do projeto (Windows DPAPI, escopo do usuário atual).

  Onde fica:   .local\secrets.vault.json   (ignorado pelo Git; ACL só do dono)
  Segurança:   cada valor é cifrado com a chave do SEU usuário do Windows nesta máquina.
               Copiar o arquivo para outro PC/usuário não revela nada.
  Regra:       segredo NUNCA vai para index.html, css/, js/, assets/ nem para o Git.
               Só o servidor (scripts/serve.js) lê, via variável de ambiente.

  Comandos:
    vault.ps1 set NOME              guarda (valor lido do stdin ou digitado, sem eco)
    vault.ps1 list                  nomes + tamanho + impressão digital (nunca o valor)
    vault.ps1 get NOME              imprime o valor (uso em scripts; cuidado com o terminal)
    vault.ps1 remove NOME           apaga
    vault.ps1 run -- comando args   roda o comando com TODOS os segredos como variáveis de ambiente
    vault.ps1 scan                  procura os valores do cofre em arquivos do projeto e no histórico do Git
    vault.ps1 scan-staged           idem, só nos arquivos do commit em andamento (usado pelo pre-commit)
#>
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 iniciado por pwsh 7, Git Bash ou hooks herda um PSModulePath que quebra o
# carregamento de módulos nativos (ex.: ConvertTo-SecureString). Reinicia com o padrão do sistema.
if ($PSVersionTable.PSVersion.Major -le 5) {
  $sys = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
  $usr = Join-Path $HOME 'Documents\WindowsPowerShell\Modules'
  $env:PSModulePath = (@($usr, $sys) | Where-Object { $_ }) -join ';'
}
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$root = Split-Path $PSScriptRoot -Parent
$dir  = Join-Path $root '.local'
$file = Join-Path $dir 'secrets.vault.json'

function Protect-Value([string]$plain) {
  ConvertFrom-SecureString (ConvertTo-SecureString -String $plain -AsPlainText -Force)
}
function Unprotect-Value([string]$cipher) {
  $sec  = ConvertTo-SecureString $cipher
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function Read-Store {
  $h = [ordered]@{}
  if (Test-Path $file) {
    $raw = Get-Content $file -Raw
    if ($raw -and $raw.Trim()) {
      $j = $raw | ConvertFrom-Json
      foreach ($p in $j.PSObject.Properties) { $h[$p.Name] = $p.Value }
    }
  }
  $h
}
function Write-Store($h) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  [IO.File]::WriteAllText($file, ($h | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  # só o dono do Windows acessa a pasta
  & icacls $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" 2>&1 | Out-Null
}
function Get-Plain {
  $out = [ordered]@{}
  $store = Read-Store
  foreach ($k in $store.Keys) { $out[$k] = Unprotect-Value $store[$k] }
  $out
}
function Get-Fingerprint([string]$plain) {
  $sha = [Security.Cryptography.SHA256]::Create()
  ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($plain)) | Select-Object -First 4 | ForEach-Object { $_.ToString('x2') }) -join ''
}
function Test-Name([string]$n) { if ($n -notmatch '^[A-Z][A-Z0-9_]{1,63}$') { throw "Nome inválido '$n'. Use MAIUSCULAS_E_UNDERSCORE (ex.: POWERCRM_TOKEN)." } }

# para scan/scan-staged: cofre existe mas não abre => sai com 2 (o hook trata como bloqueio)
function Get-PlainOrExit {
  try { Get-Plain } catch { Write-Host ("ERRO: não consegui abrir o cofre (" + $_.Exception.Message + ")"); exit 2 }
}
function Find-InText($secrets, [string]$text, [string]$label, [ref]$found) {
  foreach ($k in $secrets.Keys) {
    if ($secrets[$k].Length -ge 8 -and $text.Contains($secrets[$k])) { Write-Host "VAZAMENTO: $label contém o segredo $k"; $found.Value = $true }
  }
}

$cmd  = $args[0]
$name = if ($args.Count -gt 1) { $args[1] } else { $null }

switch ($cmd) {
  'set' {
    Test-Name $name
    if ([Console]::IsInputRedirected) { $plain = [Console]::In.ReadToEnd().Trim() }
    else {
      $s = Read-Host "Valor de $name (não aparece na tela)" -AsSecureString
      $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
      try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    }
    if (-not $plain) { throw 'Valor vazio.' }
    $store = Read-Store
    $store[$name] = Protect-Value $plain
    Write-Store $store
    Write-Host ("OK: {0} guardado no cofre (tamanho {1}, impressão {2})" -f $name, $plain.Length, (Get-Fingerprint $plain))
  }
  'list' {
    $plain = Get-Plain
    if ($plain.Count -eq 0) { Write-Host 'cofre vazio'; break }
    foreach ($k in $plain.Keys) { Write-Host ("{0,-28} tamanho={1,-4} impressão={2}" -f $k, $plain[$k].Length, (Get-Fingerprint $plain[$k])) }
  }
  'get' {
    Test-Name $name
    $plain = Get-Plain
    if (-not $plain.Contains($name)) { Write-Error "Segredo $name não existe no cofre."; exit 2 }
    [Console]::Out.Write($plain[$name])
  }
  'remove' {
    Test-Name $name
    $store = Read-Store
    if ($store.Contains($name)) { $store.Remove($name); Write-Store $store; Write-Host "OK: $name removido" } else { Write-Host "$name não estava no cofre" }
  }
  'run' {
    $rest = @($args | Select-Object -Skip 1)
    if ($rest.Count -gt 0 -and $rest[0] -eq '--') { $rest = @($rest | Select-Object -Skip 1) }
    if ($rest.Count -eq 0) { throw 'Uso: vault.ps1 run -- comando [args]' }
    $plain = Get-Plain
    foreach ($k in $plain.Keys) { [Environment]::SetEnvironmentVariable($k, $plain[$k], 'Process') }
    Push-Location $root
    try { & $rest[0] @($rest | Select-Object -Skip 1); exit $LASTEXITCODE } finally { Pop-Location }
  }
  'scan' {
    $secrets = Get-PlainOrExit
    if ($secrets.Count -eq 0) { Write-Host 'cofre vazio: nada a verificar'; exit 0 }
    Push-Location $root
    $found = $false
    try {
      $paths = New-Object System.Collections.Generic.HashSet[string]
      foreach ($p in @(git ls-files 2>$null) + @(git ls-files --others --exclude-standard 2>$null)) { if ($p) { [void]$paths.Add($p) } }
      if (Test-Path 'dist') { Get-ChildItem 'dist' -Recurse -File | ForEach-Object { [void]$paths.Add((Resolve-Path -Relative $_.FullName).TrimStart('.', '\')) } }
      $n = 0
      foreach ($p in $paths) {
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
        if ((Get-Item -LiteralPath $p).Length -gt 8MB) { continue }
        $bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $p))
        Find-InText $secrets ([Text.Encoding]::GetEncoding(28591).GetString($bytes)) $p ([ref]$found); $n++
      }
      foreach ($k in $secrets.Keys) {
        $hits = @(git log --all --format=%h "-S$($secrets[$k])" 2>$null)
        if ($hits.Count -gt 0) { Write-Host "VAZAMENTO: $k aparece no histórico do Git (commits: $($hits -join ', '))"; $found = $true }
      }
      if ($found) { exit 1 } else { Write-Host "OK: nenhum segredo do cofre em $n arquivos (nem no histórico do Git)" }
    } finally { Pop-Location }
  }
  'scan-staged' {
    $secrets = Get-PlainOrExit
    if ($secrets.Count -eq 0) { exit 0 }
    Push-Location $root
    $found = $false
    try {
      foreach ($f in @(git diff --cached --name-only --diff-filter=ACM)) {
        if (-not $f) { continue }
        $text = (git show ":$f" 2>$null) -join "`n"
        Find-InText $secrets $text $f ([ref]$found)
      }
      if ($found) { exit 1 }
    } finally { Pop-Location }
  }
  default { Write-Host 'Uso: vault.ps1 set|list|get|remove|run|scan|scan-staged  (veja o cabeçalho do arquivo)'; exit 64 }
}
