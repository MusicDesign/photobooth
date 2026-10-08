# Installation complète de la borne sous Windows (PowerShell), selon ce qui manque, puis lancement.
#   scripts\install.cmd                installe ce qui manque et lance la borne
#   scripts\install.cmd -NoStart       installe seulement
#   scripts\install.cmd -Check         affiche l'état, n'installe rien
#   scripts\install.cmd -NoModels      sans le modèle IA de détourage précis (114 Mo)
# Windows sert aux essais : pas de gphoto2 (webcam du navigateur seulement) ni d'impression CUPS.
param([switch]$NoStart, [switch]$Check, [switch]$NoModels)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
function Say($t) { Write-Host "`n> $t" -ForegroundColor Cyan }

# 1. Node.js 22.12 ou plus (winget)
function NodeVersion {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return [version]'0.0' }
  $v = ((node -v) -replace '^v', '') -split '\.'
  return [version]"$($v[0]).$($v[1])"
}
if ((NodeVersion) -lt [version]'22.12') {
  if ($Check) { Write-Host 'x Node.js 22.12 ou plus absent'; exit 1 }
  Say 'Node.js'
  # Déjà installé mais trop ancien : winget install ne fait rien, c'est une mise à niveau
  if (Get-Command node -ErrorAction SilentlyContinue) { winget upgrade --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements }
  else { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements }
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if ((NodeVersion) -lt [version]'22.12') { Write-Host 'Node.js 22.12 ou plus requis (nodejs.org) : relancez ce script après l''avoir installé.'; exit 1 }
}
Write-Host "Windows $([Environment]::OSVersion.Version) · Node.js $(node -v) · npm $(npm -v)"

# 2. Dépendances npm
if (-not (Test-Path 'node_modules\electron\dist') -or -not (Test-Path 'node_modules\sharp')) {
  if ($Check) { Write-Host 'x Dépendances npm absentes : npm install' }
  else { Say 'Dépendances npm'; npm install; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
}

# 3. Le reste, selon ce qui manque (server/setup.js)
if ($Check) { npm run --silent check; exit $LASTEXITCODE }
Say 'Modules nécessaires'
if ($NoModels) { npm run --silent setup -- --no-models } else { npm run --silent setup }
if ($LASTEXITCODE) { exit $LASTEXITCODE }

# 4. Lancement
if (-not $NoStart) { Say 'Lancement'; Start-Process npm -ArgumentList 'run', '--silent', 'app' -WindowStyle Hidden }
