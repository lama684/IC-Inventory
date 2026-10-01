param(
    [int]$Port = 3210,
    [string]$DataDir = '',
    [string]$ListenHost = '0.0.0.0'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw '请先安装 Node.js 24 LTS，并重新打开终端。' }
$major = [int]((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0])
if ($major -lt 24) { throw '需要 Node.js 24 或更高版本。' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules/qrcode'))) { throw '请在项目根目录执行 npm ci，或 pnpm install --frozen-lockfile 安装依赖。' }
if (-not $DataDir) { $DataDir = Join-Path $projectRoot 'data' }
$env:PORT = [string]$Port
$env:HOST = $ListenHost
$env:DATA_DIR = [System.IO.Path]::GetFullPath($DataDir)
Set-Location -LiteralPath $projectRoot
& $nodeCommand.Source (Join-Path $projectRoot 'backend/server.mjs')
exit $LASTEXITCODE
