[CmdletBinding()]
param(
  [ValidateRange(0.1, 100.0)]
  [double]$TimeScale = 1,
  [switch]$Install
)

$ErrorActionPreference = 'Stop'
$KitRoot = $PSScriptRoot
$Runtime = Join-Path $env:USERPROFILE '.codex\mtm-kit\0.3.2\tool\mtm.mjs'

if ($Install) {
  & node (Join-Path $KitRoot 'install.mjs')
  if ($LASTEXITCODE -ne 0) { throw "MTM-KIT install failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path $Runtime)) {
  throw "MTM-KIT 0.3.2 is not installed. Run: .\run-rehearsal.ps1 -Install"
}

& npm.cmd --prefix $KitRoot run rehearsal:autoplay -- --time-scale $TimeScale
exit $LASTEXITCODE
