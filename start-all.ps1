# FinVerify OS — Start All Services
# Launches: Python extraction worker (8091) → TS API (8080) → Go gateway (8090) → React (21950)
# Run from repo root:  powershell -ExecutionPolicy Bypass -File .\start-all.ps1

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Go PATH fix ──────────────────────────────────────────────────────────────
$GoPath = "C:\Program Files\Go\bin"
if (Test-Path "$GoPath\go.exe") { $env:PATH = "$GoPath;$env:PATH" }

# ── Load .env ────────────────────────────────────────────────────────────────
$EnvFile = Join-Path $Root ".env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match "^[^#=\s][^=]*=.+" } | ForEach-Object {
        $parts = $_ -split "=", 2
        $key   = $parts[0].Trim()
        $value = $parts[1].Trim().Trim("'").Trim('"')
        if ($key -and $value) { [System.Environment]::SetEnvironmentVariable($key, $value, "Process") }
    }
}

# Port config
if (-not $env:PORT)               { $env:PORT               = "8080" }
if (-not $env:GO_API_PORT)        { $env:GO_API_PORT        = "8090" }
if (-not $env:PYTHON_WORKER_PORT) { $env:PYTHON_WORKER_PORT = "8091" }
$env:TYPESCRIPT_API_URL = "http://localhost:$($env:PORT)"
$env:PYTHON_WORKER_URL  = "http://localhost:$($env:PYTHON_WORKER_PORT)"

Write-Host ""
Write-Host "  FinVerify OS" -ForegroundColor Green
Write-Host "  React frontend  -> http://localhost:21950" -ForegroundColor Cyan
Write-Host "  Go gateway      -> http://localhost:$($env:GO_API_PORT)  (main API entry)" -ForegroundColor Cyan
Write-Host "  TS API          -> http://localhost:$($env:PORT)" -ForegroundColor Gray
Write-Host "  Python worker   -> http://localhost:$($env:PYTHON_WORKER_PORT)" -ForegroundColor Gray
Write-Host ""

# ── 1. Python extraction worker ─────────────────────────────────────────────
$PyDir = Join-Path $Root "backend\worker"
Write-Host "[1/4] Python worker on :$($env:PYTHON_WORKER_PORT)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoProfile","-Command",
    "cd '$PyDir'; python -m uvicorn app.main:app --host 0.0.0.0 --port $($env:PYTHON_WORKER_PORT) 2>&1" `
    -WindowStyle Hidden

Start-Sleep -Seconds 3

# ── 2. TypeScript API server — with auto-restart watchdog ────────────────────
Write-Host "[2/4] TypeScript API on :$($env:PORT) (with watchdog)..." -ForegroundColor Yellow
$tsWatchdog = @"
`$Root = '$Root'
`$Port = '$($env:PORT)'
`$PythonWorkerUrl = '$($env:PYTHON_WORKER_URL)'
while (`$true) {
    # Clear any stale binding on the port
    Get-NetTCPConnection -LocalPort `$Port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique |
        ForEach-Object { Stop-Process -Id `$_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
    Write-Host "[ts-watchdog] Starting TypeScript API..."
    `$env:PORT = `$Port
    `$env:PYTHON_WORKER_URL = `$PythonWorkerUrl
    `$p = Start-Process -FilePath 'node' -ArgumentList '--enable-source-maps','./dist/index.mjs' -WorkingDirectory (Join-Path `$Root 'backend\api') -PassThru -NoNewWindow
    `$p.WaitForExit()
    Write-Host "[ts-watchdog] TypeScript API exited (code `$(`$p.ExitCode)) — restarting in 2s..."
    Start-Sleep -Seconds 2
}
"@
Start-Process powershell -ArgumentList "-NoProfile","-Command",$tsWatchdog -WindowStyle Hidden

Start-Sleep -Seconds 6

# ── 3. Go gateway — with auto-restart watchdog ───────────────────────────────
$GoDir = Join-Path $Root "backend\gateway"
$GoExe = Join-Path $GoDir "api-go.exe"
Write-Host "[3/4] Go gateway on :$($env:GO_API_PORT) (with watchdog)..." -ForegroundColor Yellow

# Always rebuild to pick up latest code
Write-Host "      Building Go gateway..." -ForegroundColor Cyan
Push-Location $GoDir
& "$GoPath\go.exe" build -o $GoExe ./cmd/api
Pop-Location

# Watchdog: restarts the gateway within 2s if it crashes for any reason
$goWatchdog = @"
`$GoExe = '$GoExe'
`$GoDir = '$GoDir'
`$GoPort = '$($env:GO_API_PORT)'
while (`$true) {
    # Kill any stale process on the port first
    Get-NetTCPConnection -LocalPort `$GoPort -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique |
        ForEach-Object { Stop-Process -Id `$_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 300
    Write-Host "[go-watchdog] Starting gateway..."
    `$p = Start-Process -FilePath `$GoExe -WorkingDirectory `$GoDir -PassThru -NoNewWindow
    `$p.WaitForExit()
    Write-Host "[go-watchdog] Gateway exited (code `$(`$p.ExitCode)) — restarting in 2s..."
    Start-Sleep -Seconds 2
}
"@
Start-Process powershell -ArgumentList "-NoProfile","-Command",$goWatchdog -WindowStyle Hidden

Start-Sleep -Seconds 2

# ── 4. React frontend ────────────────────────────────────────────────────────
Write-Host "[4/4] React frontend on :21950..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoProfile","-Command",
    "cd '$Root'; `$env:PORT='21950'; pnpm dev:frontend 2>&1" `
    -WindowStyle Hidden

Write-Host ""
Write-Host "  All services starting. Open: http://localhost:21950" -ForegroundColor Green
Write-Host "  Go gateway watchdog active — restarts automatically if it crashes." -ForegroundColor DarkGray
