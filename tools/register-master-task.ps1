# tools/register-master-task.ps1 - registers the weekly Windows task that updates the MASTER
# workbook (tools/update-master-workbook.ps1) on Glenn's PC.
#
# Tuesdays 09:00 local (Sydney) time = Mon 22:00/23:00 UTC, the morning after the server's weekly-new-listings
# job (Mon 06:15 UTC). Runs only while Glenn is logged on (Excel needs the desktop session).
# If the PC was off or asleep at 09:00 it runs at the next chance (StartWhenAvailable).
#
#   powershell -ExecutionPolicy Bypass -File tools\register-master-task.ps1            # create / replace
#   powershell -ExecutionPolicy Bypass -File tools\register-master-task.ps1 -Remove    # delete
#   Start-ScheduledTask -TaskName 'Hemnet MASTER weekly update'                         # run now
param([switch]$Remove)
$name = 'Hemnet MASTER weekly update'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; "removed $name"; return }
$script = Join-Path $PSScriptRoot 'update-master-workbook.ps1'
if (-not (Test-Path -LiteralPath $script)) { throw "missing $script" }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Tuesday -At '09:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Adds the latest week of Hemnet new listings to DATA MASTER\WEEKLY PROPERTIES\MASTER_updated_*.xlsx from the server CSV. Log: %LOCALAPPDATA%\hemnet-master-update.log' -Force | Out-Null
$t = Get-ScheduledTask -TaskName $name
"registered '$name': next run $((Get-ScheduledTaskInfo -TaskName $name).NextRunTime), state $($t.State)"
