[CmdletBinding()]
param(
  [string]$OutputDirectory = "artifacts\windows",
  [string]$ApiUrl = "",
  [string]$RelayUrl = "",
  [switch]$Sign,
  [switch]$AcceptEula,
  [string]$Certificate = $(if ($env:REYDESK_SIGN_CERT) { $env:REYDESK_SIGN_CERT } else { $env:DESKOS_SIGN_CERT }),
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ApiUrl)) { $ApiUrl = "http://localhost:4000" }
if ([string]::IsNullOrWhiteSpace($RelayUrl)) { $RelayUrl = "ws://localhost:4100/ws" }
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\.." )).Path
$compiledAgentBinary = Join-Path $root "apps\target\release\deskos-agent.exe"
$agentBinary = Join-Path $root "apps\target\release\reydesk-agent.exe"
$trayLauncher = Join-Path $root "packaging\windows\start-tray-helper.vbs"
$output = Join-Path $root $OutputDirectory
$msi = Join-Path $output "ReyDeskAgentSetup.msi"
$helperBinary = Join-Path $output "reydesk-helper.exe"

$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargoCommand) {
  $cargoPath = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
  if (Test-Path $cargoPath) {
    $cargoCommand = Get-Item $cargoPath
  } else {
    throw "Rust/Cargo is required to build the agent binary."
  }
}

$wixCommand = Get-Command wix -ErrorAction SilentlyContinue
if (-not $wixCommand) {
  $wixCandidates = @(
    (Join-Path ${env:ProgramFiles} 'WiX Toolset v7.0\bin\wix.exe'),
    (Join-Path ${env:ProgramFiles} 'WiX Toolset v6.0\bin\wix.exe'),
    (Join-Path ${env:ProgramFiles} 'WiX Toolset v5.0\bin\wix.exe')
  )
  $wixPath = $wixCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($wixPath) {
    $wixCommand = Get-Item $wixPath
  } else {
    throw "WiX Toolset v4+ is required. Install it separately, then rerun this script."
  }
}

$cargoExecutable = if ($cargoCommand.Source) { $cargoCommand.Source } else { $cargoCommand.FullName }
$wixExecutable = if ($wixCommand.Source) { $wixCommand.Source } else { $wixCommand.FullName }

New-Item -ItemType Directory -Force -Path $output | Out-Null
Push-Location $root
try {
  & $cargoExecutable build --release --manifest-path apps/Cargo.toml -p deskos-agent
  if (-not (Test-Path $compiledAgentBinary)) {
    throw "Release binary was not produced at $compiledAgentBinary"
  }
  Copy-Item -Force $compiledAgentBinary $agentBinary
  if (-not (Test-Path $trayLauncher)) {
    throw "Tray launcher was not found at $trayLauncher"
  }

  # The public connect endpoint serves this exact release binary as the
  # portable helper. Keep it in sync with the MSI build so a newly generated
  # web support code cannot be handed an older 8-digit-only helper.
  Copy-Item -Force $agentBinary $helperBinary
  Write-Host "Updated portable helper $helperBinary"

  $wixArgs = @('build', '-arch', 'x64', '-ext', 'WixToolset.UI.wixext')
  if ($AcceptEula) {
    $wixArgs += @('-acceptEula', 'wix7')
  }
  $wixArgs += @(
    'packaging\windows\ReyDeskAgent.wxs',
    '-d',
    "AgentBinary=$agentBinary",
    '-d',
    "DefaultApiUrl=$ApiUrl",
    '-d',
    "DefaultRelayUrl=$RelayUrl",
    '-d',
    "TrayLauncher=$trayLauncher",
    '-o',
    $msi
  )
  & $wixExecutable @wixArgs
  if ($LASTEXITCODE -ne 0) {
    throw "WiX failed with exit code $LASTEXITCODE. Pass -AcceptEula after accepting the WiX OSMF EULA if required."
  }

  if ($Sign) {
    if (-not $Certificate) {
      throw "-Sign requires -Certificate or REYDESK_SIGN_CERT (legacy DESKOS_SIGN_CERT is also accepted)."
    }
    if (-not (Get-Command signtool.exe -ErrorAction SilentlyContinue)) {
      throw "Windows SDK signtool.exe is required for MSI signing."
    }
    signtool.exe sign /fd SHA256 /a /f $Certificate /tr $TimestampUrl /td SHA256 $msi
  }

  Write-Host "Created $msi"
  if ($Sign) {
    Write-Host "Signed $msi"
  } else {
    Write-Warning "MSI is unsigned. Use -Sign for a production artifact."
  }
}
finally {
  Pop-Location
}
