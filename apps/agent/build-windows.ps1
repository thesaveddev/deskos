$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  cargo build --release --manifest-path apps/Cargo.toml -p deskos-agent
  $source = Join-Path $root 'apps/target/release/deskos-agent.exe'
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

  $hash = (Get-FileHash $helper -Algorithm SHA256).Hash.ToLowerInvariant()
  $size = (Get-Item $helper).Length
  [PSCustomObject]@{ file = $helper; bytes = $size; sha256 = $hash } | ConvertTo-Json | Set-Content (Join-Path $outputDir 'reydesk-helper.sha256.json')
  Write-Host "Helper: $helper"
  Write-Host "Size: $size bytes"
  Write-Host "SHA-256: $hash"
} finally {
  Pop-Location
}
