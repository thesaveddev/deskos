$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $root
try {
  cargo build --release --manifest-path apps/Cargo.toml -p deskos-agent
  $source = Join-Path $root 'apps/target/release/deskos-agent.exe'
  # Optional Authenticode signing. Configure REYDESK_SIGN_CERT_THUMBPRINT and
  # REYDESK_SIGN_TIMESTAMP_URL in the CI secret/environment; never commit a
  # certificate or password. Unsigned builds remain valid for local development.
  $signThumbprint = $env:REYDESK_SIGN_CERT_THUMBPRINT
  $timestampUrl = if ($env:REYDESK_SIGN_TIMESTAMP_URL) { $env:REYDESK_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
  if ($signThumbprint) {
    $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if (-not $signtool) { throw 'REYDESK_SIGN_CERT_THUMBPRINT is set, but signtool.exe is unavailable.' }
    & $signtool.Source sign /sha1 $signThumbprint /fd SHA256 /tr $timestampUrl /td SHA256 $source
    if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing failed.' }
  } else {
    Write-Warning 'No signing certificate configured; helper will be unsigned.'
  }
  $outputDir = Join-Path $root 'artifacts/windows'
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
  $helper = Join-Path $outputDir 'reydesk-helper.exe'
  Copy-Item $source $helper -Force

  $upx = Get-Command upx -ErrorAction SilentlyContinue
  if (-not $upx) {
    $choco = Get-Command choco -ErrorAction SilentlyContinue
    if ($choco) {
      & $choco.Source install upx -y --no-progress | Out-Host
      $upx = Get-Command upx -ErrorAction SilentlyContinue
    }
  }
  if ($upx) {
    & $upx.Source --best --lzma $helper | Out-Host
  } else {
    Write-Warning 'UPX is not installed; keeping the uncompressed release binary. Install UPX separately for a smaller portable download.'
  }

  if ($signThumbprint) {
    & $signtool.Source verify /pa /all $helper
    if ($LASTEXITCODE -ne 0) { throw 'Signed helper verification failed.' }
  }
  $hash = (Get-FileHash $helper -Algorithm SHA256).Hash.ToLowerInvariant()
  $size = (Get-Item $helper).Length
  [PSCustomObject]@{ file = $helper; bytes = $size; sha256 = $hash } | ConvertTo-Json | Set-Content (Join-Path $outputDir 'reydesk-helper.sha256.json')
  Write-Host "Helper: $helper"
  Write-Host "Size: $size bytes"
  Write-Host "SHA-256: $hash"
} finally {
  Pop-Location
}
