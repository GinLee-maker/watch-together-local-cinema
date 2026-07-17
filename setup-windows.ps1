$ErrorActionPreference = 'Stop'

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'winget was not found. Install App Installer from Microsoft Store first.'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Node.js LTS...'
  winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing FFmpeg...'
  winget install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements
}

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Cloudflare Tunnel...'
  winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
}

Write-Host 'Setup complete. Reopen PowerShell, then run .\start-windows.ps1.'
