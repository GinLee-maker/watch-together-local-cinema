param(
  [switch]$Public
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $project

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found. Run .\setup-windows.ps1 first.'
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Warning 'FFmpeg was not found. The site can start, but MKV conversion will not work. Run .\setup-windows.ps1.'
}

if (-not (Test-Path (Join-Path $project 'node_modules'))) {
  npm install
}

$server = Start-Process node -ArgumentList @('server.js') -WorkingDirectory $project -NoNewWindow -PassThru
$tunnel = $null

try {
  for ($i = 0; $i -lt 30; $i++) {
    try {
      Invoke-WebRequest 'http://localhost:3210/healthz' -UseBasicParsing -ErrorAction Stop | Out-Null
      break
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }

  $openUrl = 'http://localhost:3210'
  if ($Public) {
    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
      throw 'cloudflared was not found. Run .\setup-windows.ps1 first.'
    }
    New-Item -ItemType Directory -Force (Join-Path $project 'data') | Out-Null
    $tunnelLog = Join-Path $project 'data\cloudflared-error.log'
    $tunnelOut = Join-Path $project 'data\cloudflared-output.log'
    $tunnel = Start-Process cloudflared -ArgumentList @('tunnel', '--url', 'http://localhost:3210') -WindowStyle Hidden -RedirectStandardOutput $tunnelOut -RedirectStandardError $tunnelLog -PassThru
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-Path $tunnelLog) {
        $match = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -Last 1
        if ($match) {
          $openUrl = $match.Matches[0].Value
          Write-Host "Public URL: $openUrl"
          break
        }
      }
    }
  }

  Start-Process $openUrl
  Write-Host 'The cinema is running. Close this window to stop it.'
  Wait-Process -Id $server.Id
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
