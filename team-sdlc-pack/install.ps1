param(
  [Parameter(Mandatory=$true)][string]$TeamWorkspace,
  [switch]$AllowPlaceholder
)
$ErrorActionPreference = 'Stop'
$argsList = @((Join-Path $PSScriptRoot 'scripts/install.mjs'), '--team-workspace', $TeamWorkspace)
if ($AllowPlaceholder) { $argsList += '--allow-placeholder' }
& node @argsList
if ($LASTEXITCODE -ne 0) { throw 'TEAM_PACK_INSTALL_FAILED' }
