$ErrorActionPreference = 'Stop'
$taskName = 'IC-Inventory'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host '开机任务已移除，库存数据库保留。'
} else { Write-Host '没有找到 IC-Inventory 开机任务。' }
