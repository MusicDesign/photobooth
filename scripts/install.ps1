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

# 1. Node.js 20 ou plus (winget)
$major = 0
if (Get-Command node -ErrorAction SilentlyContinue) { $major = [int](((node -v) -replace '^v', '') -split '\.')[0] }
if ($major -lt 20) {
  if ($Check) { Write-Host 'x Node.js 20 ou plus absent'; exit 1 }
  Say 'Node.js'
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
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
