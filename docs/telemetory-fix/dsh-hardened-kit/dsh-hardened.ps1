<#
.SYNOPSIS
  Launch DeepSeek Harness with all telemetry / session-log side channels disabled and the egress guard loaded.
.EXAMPLE
  .\dsh-hardened.ps1 web
  .\dsh-hardened.ps1 --profile headless "summarise README.md"
  .\dsh-hardened.ps1 -Strict web          # strict allow-list (see $DefaultAllow)
  .\dsh-hardened.ps1 -InstallHomePatch    # also copy the overlay into $DSH_HOME\cordis.patch.yml (covers Desktop)
#>
# No param() block on purpose: PowerShell would try to bind DSH flags such as --profile / --patch as
# its own parameters. Our three switches are parsed by hand; everything else is passed through verbatim.
$Strict = $false; $Audit = $false; $InstallHomePatch = $false
$DshArgs = @()
foreach ($a in $args) {
  switch -Exact ($a) {
    '-Strict'           { $Strict = $true }
    '-Audit'            { $Audit = $true }
    '-InstallHomePatch' { $InstallHomePatch = $true }
    default             { $DshArgs += [string]$a }
  }
}
$ErrorActionPreference = 'Stop'
$Kit = $PSScriptRoot

# --- Node must strip TypeScript natively (22.18+ / 24+)
$nodeVer = [version]((node -p "process.versions.node").Trim())
if ($nodeVer -lt [version]'22.18.0') { throw "Node $nodeVer cannot load .ts preloads; need >= 22.18 (DSH itself needs ^22.19 || >=24)." }

# --- 1. upstream opt-outs (OTel hard opt-out; DSH_TELEMETRY_DISABLED is 'any non-empty value')
$env:DSH_TELEMETRY_DISABLED = '1'
$env:DSH_TELEMETRY_MODE     = 'DISABLED'

# --- 2. egress guard policy
$DefaultAllow = 'api.deepseek.com,registry.npmjs.org,*.npmjs.org,github.com,*.githubusercontent.com'
if ($Strict -and -not $env:DSH_EGRESS_ALLOW) { $env:DSH_EGRESS_ALLOW = $DefaultAllow }
$env:DSH_EGRESS_MODE = if ($Audit) { 'audit' } else { 'enforce' }
if (-not $env:DSH_EGRESS_LOG) { $env:DSH_EGRESS_LOG = Join-Path $Kit 'egress-audit.jsonl' }

# --- 3. optional home-level overlay (applies to every profile incl. Desktop that shares this DSH_HOME)
$overlay = Join-Path $Kit 'privacy-hardened.patch.yml'
if ($InstallHomePatch) {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $homePatch = Join-Path $dshHome 'cordis.patch.yml'
  if (Test-Path $homePatch) {
    if (-not (Select-String -Path $homePatch -Pattern 'session-log-deepseek' -Quiet)) {
      Copy-Item $homePatch "$homePatch.bak-$(Get-Date -Format yyyyMMddHHmmss)"
      Add-Content -Path $homePatch -Value "`n$(Get-Content $overlay -Raw)" -Encoding utf8
      Write-Host "appended overlay to $homePatch (backup kept)"
    } else { Write-Host "$homePatch already mentions session-log-deepseek — review it manually" }
  } else {
    New-Item -ItemType Directory -Force -Path $dshHome | Out-Null
    Copy-Item $overlay $homePatch
    Write-Host "installed $homePatch"
  }
  if ($DshArgs.Count -eq 0) { return }
}

# --- 4. resolve the real DSH entry (works without dsh.cmd on PATH, e.g. nvm4w)
if ($env:DSH_ENTRY) { $entry = $env:DSH_ENTRY } else {
  $pkgDir = Join-Path ((npm root -g) | Out-String).Trim() '@deepseek-ai\dsh'
  if (-not (Test-Path (Join-Path $pkgDir 'package.json'))) { throw "@deepseek-ai/dsh not found under npm root -g; set DSH_ENTRY to the JS entry of your build/fork." }
  $pkg = Get-Content (Join-Path $pkgDir 'package.json') -Raw | ConvertFrom-Json
  $bin = if ($pkg.bin -is [string]) { $pkg.bin } else { $pkg.bin.dsh }
  $entry = Join-Path $pkgDir $bin
}

$guardUrl = ([System.Uri](Join-Path $Kit 'egress-guard.ts')).AbsoluteUri
Write-Host "[dsh-hardened] entry=$entry guard=$($env:DSH_EGRESS_MODE) allow=$(if ($env:DSH_EGRESS_ALLOW) { $env:DSH_EGRESS_ALLOW } else { '(deny-list only)' })"
& node "--import=$guardUrl" $entry @DshArgs --patch $overlay
exit $LASTEXITCODE
