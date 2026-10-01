param([int]$Port = 3210, [string]$DataDir = '')
$ErrorActionPreference = 'Stop'
$taskName = 'IC-Inventory'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请用管理员终端执行此脚本，以注册服务器开机任务。' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if (-not $DataDir) { $DataDir = Join-Path $projectRoot 'data' }
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$runner = Join-Path $PSScriptRoot 'run-scheduled.ps1'
$escapedNode = $nodePath.Replace("'", "''")
$escapedRoot = $projectRoot.Replace("'", "''")
$escapedData = $DataDir.Replace("'", "''")
$runText = "`$env:PORT='$Port'`r`n`$env:HOST='0.0.0.0'`r`n`$env:DATA_DIR='$escapedData'`r`nSet-Location -LiteralPath '$escapedRoot'`r`n& '$escapedNode' '$escapedRoot/backend/server.mjs' >> '$escapedData/service.log' 2>&1`r`nexit `$LASTEXITCODE`r`n"
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
[System.IO.File]::WriteAllText($runner, $runText, [System.Text.UTF8Encoding]::new($true))
$powerShellPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description 'IC 元件管理家庭服务器' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "已注册并启动 $taskName，端口 $Port，数据目录 $DataDir。"
Write-Host '若工作机访问失败，请在服务器允许专用网络的入站 TCP 端口。'
