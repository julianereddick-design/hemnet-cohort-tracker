# tools/update-master-workbook.ps1 - adds the new weeks to Glenn's MASTER workbook
# (DATA MASTER\WEEKLY PROPERTIES\MASTER_updated_DDMMYY.xlsx) from the server's weekly CSV.
#
# Runs on Glenn's PC (Excel is needed: editing through Excel keeps the charts and formulas;
# ExcelJS drops charts). Scheduled weekly by tools/register-master-task.ps1, Tuesdays 09:00
# Sydney time, after the server's weekly-new-listings job (Mon 06:15 UTC) has written
#   http://<server>:3800/view-data/weekly-new-listings/master-series.csv
#
# What it does, the same way the 3 Nov 2026 update was done by hand:
#   1. Finds the newest MASTER_updated_*.xlsx and the last week in it.
#   2. Takes the weeks after that from the CSV (must follow on week by week).
#   3. Works on a temp COPY: appends the weeks to the six raw sheets (+ the three pre-market
#      formula sheets), copies the last Analysis_TOT / _FS / _PM data row down into new rows
#      inserted above each summary block, extends charts that ended at the old last row,
#      writes the source of each new week in raw-sheet column C, sets the Dashboard week.
#   4. Checks the copy (new values match the CSV, no new formula errors), then saves it as a
#      NEW file MASTER_updated_<DDMMYY of the last week>.xlsx. Never overwrites a file and
#      never touches the previous one.
#   On any failure it writes MASTER_update_FAILED_<date>.txt next to the workbook saying why.
#
#   powershell -File tools\update-master-workbook.ps1                 # normal run
#   powershell -File tools\update-master-workbook.ps1 -CsvPath x.csv  # from a local CSV
#   powershell -File tools\update-master-workbook.ps1 -DryRun         # report only
param(
  [string]$Folder = "C:\Users\GlennCullinane\Decade Partners\Investing - Companies\Hemnet\DATA MASTER\WEEKLY PROPERTIES",
  [string]$CsvUrl = "http://170.64.197.241:3800/view-data/weekly-new-listings/master-series.csv",
  [string]$CsvPath = "",
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$LogFile = Join-Path $env:LOCALAPPDATA 'hemnet-master-update.log'
function Log([string]$m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Write-Output $line; Add-Content -LiteralPath $LogFile -Value $line }

$RAW = [ordered]@{ sweden_tot='All Sweden_TOT'; stockholm_tot='Stockholm_TOT'; vg_tot='VG_TOT'; sweden_fs='All Sweden_FS'; stockholm_fs='Stockholm_FS'; vg_fs='VG_FS' }
$PM_SHEETS = @('All Sweden_PM','Stockholm_PM','VG_PM')
$ANALYSIS = @('Analysis_TOT','Analysis_FS','Analysis_PM')

function Open-Excel {
  $xl = New-Object -ComObject Excel.Application
  Start-Sleep -Seconds 3
  $xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false
  return $xl
}
function Open-Book($xl, [string]$path, [bool]$readOnly) {
  for ($i = 0; $i -lt 40; $i++) { try { return $xl.Workbooks.Open($path, 0, $readOnly) } catch { Start-Sleep -Milliseconds 750 } }
  throw "Excel would not open $path"
}
function Iso($v) { if ($v -is [double]) { [DateTime]::FromOADate($v).ToString('yyyy-MM-dd') } else { ([DateTime]::Parse([string]$v)).ToString('yyyy-MM-dd') } }
function Last-Row($ws, [int]$col) { $ws.Cells.Item($ws.Rows.Count, $col).End(-4162).Row }
# Last data row of an Analysis sheet: the row before the first empty column-A cell below row 2.
function Last-Data-Row($ws) { $r = 2; while ([string]$ws.Cells.Item($r + 1, 1).Formula -ne '') { $r++ }; $r }
function Error-Count($wb) { $n = 0; foreach ($ws in $wb.Worksheets) { try { $n += $ws.UsedRange.SpecialCells(-4123, 16).Count } catch {} }; $n }

$xl = $null; $wb = $null; $work = $null
try {
  # 1. newest workbook and its last week
  $files = Get-ChildItem -LiteralPath $Folder -Filter 'MASTER_updated_*.xlsx' | Where-Object { $_.Name -match '^MASTER_updated_(\d{6})\.xlsx$' } |
    ForEach-Object { [pscustomobject]@{ File = $_; Date = [DateTime]::ParseExact($Matches[1], 'ddMMyy', $null) } } | Sort-Object Date
  if (-not $files) { throw "no MASTER_updated_DDMMYY.xlsx in $Folder" }
  $src = $files[-1].File.FullName
  Log "workbook: $src"

  # 2. the CSV
  if ($CsvPath) { $csvText = Get-Content -LiteralPath $CsvPath -Raw } else {
    $csvText = (Invoke-WebRequest -Uri $CsvUrl -UseBasicParsing -TimeoutSec 60).Content
    if ($csvText -is [byte[]]) { $csvText = [Text.Encoding]::UTF8.GetString($csvText) }
  }
  $csv = $csvText | ConvertFrom-Csv
  if (-not $csv -or -not ($csv[0].PSObject.Properties.Name -contains 'sweden_tot')) { throw "CSV not in the expected format" }

  $xl = Open-Excel
  $work = Join-Path $env:TEMP "master-update-$(Get-Random).xlsx"
  Copy-Item -LiteralPath $src -Destination $work
  $wb = Open-Book $xl $work $false
  $tot = $wb.Worksheets.Item('All Sweden_TOT')
  $lastRow = Last-Row $tot 2
  $lastWeek = Iso $tot.Cells.Item($lastRow, 1).Value2
  Log "last week in workbook: $lastWeek (raw row $lastRow)"

  # the CSV must agree with the workbook on the weeks they share (latest 8)
  foreach ($k in $RAW.Keys) {
    $ws = $wb.Worksheets.Item($RAW[$k])
    for ($r = $lastRow - 7; $r -le $lastRow; $r++) {
      $w = Iso $ws.Cells.Item($r, 1).Value2; $row = $csv | Where-Object { $_.week_start -eq $w }
      if ($row -and [int]$row.$k -ne [int]$ws.Cells.Item($r, 2).Value2) { throw "CSV and workbook differ for $w $k ($($row.$k) vs $($ws.Cells.Item($r, 2).Value2)) - not updating" }
    }
  }
  $new = @($csv | Where-Object { $_.week_start -gt $lastWeek } | Sort-Object week_start)
  if ($new.Count -eq 0) { Log "nothing new: CSV ends $(($csv | Sort-Object week_start)[-1].week_start)"; return }
  $expect = [DateTime]::Parse($lastWeek)
  foreach ($n in $new) {
    $expect = $expect.AddDays(7)
    if ($n.week_start -ne $expect.ToString('yyyy-MM-dd')) { throw "CSV weeks do not follow on: expected $($expect.ToString('yyyy-MM-dd')), got $($n.week_start)" }
    foreach ($k in $RAW.Keys) { if ([string]$n.$k -notmatch '^\d+$') { throw "missing value $k for $($n.week_start)" } }
  }
  $count = $new.Count; $newLastWeek = $new[-1].week_start
  Log "adding $count week(s): $(($new | ForEach-Object { $_.week_start + ($(if ($_.is_estimate -eq 'true') { ' (estimate)' } else { '' })) }) -join ', ')"
  if ($DryRun) { Log 'dry run: nothing written'; return }
  $errorsBefore = Error-Count $wb

  # 3a. raw sheets: copy the last row (date formula + format) down, then values and source
  foreach ($k in $RAW.Keys) {
    $ws = $wb.Worksheets.Item($RAW[$k])
    if ([string]$ws.Cells.Item(1, 3).Formula -eq '') { $ws.Cells.Item(1, 3).Value2 = 'Source' }
    [void]$ws.Range("A${lastRow}:B${lastRow}").Copy($ws.Range("A$($lastRow + 1):B$($lastRow + $count)"))
    for ($i = 0; $i -lt $count; $i++) {
      $ws.Cells.Item($lastRow + 1 + $i, 2).Value2 = [int]$new[$i].$k
      $ws.Cells.Item($lastRow + 1 + $i, 3).Value2 = [string]$new[$i].source
    }
  }
  foreach ($s in $PM_SHEETS) { $ws = $wb.Worksheets.Item($s); [void]$ws.Range("A${lastRow}:B${lastRow}").Copy($ws.Range("A$($lastRow + 1):B$($lastRow + $count)")) }

  # 3b. analysis sheets: new rows above the summary, last data row's formulas copied down
  $oldLast = @{}
  foreach ($s in $ANALYSIS) {
    $ws = $wb.Worksheets.Item($s); $L = Last-Data-Row $ws; $oldLast[$s] = $L
    if ((Iso $ws.Cells.Item($L, 1).Value2) -ne $lastWeek) { throw "$s last data row $L is $(Iso $ws.Cells.Item($L,1).Value2), not $lastWeek" }
    [void]$ws.Rows("$($L + 1):$($L + $count)").Insert()
    [void]$ws.Rows($L).Copy($ws.Rows("$($L + 1):$($L + $count)"))
  }
  # 3c. charts that ended at the old last data row
  foreach ($s in 'Analysis_TOT','Analysis_FS') {
    $ws = $wb.Worksheets.Item($s); $L = $oldLast[$s]
    foreach ($co in $ws.ChartObjects()) { foreach ($ser in $co.Chart.SeriesCollection()) {
      $f = $ser.Formula
      # '$$' in a .NET replacement is one literal '$'
      if ($f -match ('\$' + $L + '\b')) { $ser.Formula = ($f -replace ('\$' + $L + '\b'), ('$$' + ($L + $count))); Log "chart $s [$($co.Name)] extended to row $($L + $count)" }
    } }
  }
  # 3d. dashboard
  $d = $wb.Worksheets.Item('Dashboard')
  $d.Range('C3').Value2 = [DateTime]::Parse($newLastWeek).ToOADate()
  $d.Range('A2').Value2 = "Data to wk $([DateTime]::Parse($newLastWeek).ToString('d MMM yyyy')). To wk 12 Oct 2026: Hemnet nytillkomna. From wk 19 Oct: paid-only new listings counted by Decade's ad registry (see raw sheets col C; 19 + 26 Oct are estimates). Updated automatically $(Get-Date -Format 'd MMM yyyy')."
  $xl.CalculateFull()

  # 4. checks on the copy
  foreach ($k in $RAW.Keys) {
    $ws = $wb.Worksheets.Item($RAW[$k])
    for ($i = 0; $i -lt $count; $i++) {
      $r = $lastRow + 1 + $i
      if ((Iso $ws.Cells.Item($r, 1).Value2) -ne $new[$i].week_start) { throw "$($RAW[$k]) row $r date is $(Iso $ws.Cells.Item($r,1).Value2), expected $($new[$i].week_start)" }
    }
  }
  foreach ($s in $ANALYSIS) {
    $ws = $wb.Worksheets.Item($s); $L = $oldLast[$s] + $count
    if ((Iso $ws.Cells.Item($L, 1).Value2) -ne $newLastWeek) { throw "$s new last row $L shows $(Iso $ws.Cells.Item($L,1).Value2), expected $newLastWeek" }
  }
  $chk = $wb.Worksheets.Item('Analysis_TOT').Cells.Item($oldLast['Analysis_TOT'] + $count, 3).Value2
  if ([int]$chk -ne [int]$new[-1].sweden_tot) { throw "Analysis_TOT Sweden for $newLastWeek is $chk, CSV says $($new[-1].sweden_tot)" }
  $errorsAfter = Error-Count $wb
  if ($errorsAfter -gt $errorsBefore) { throw "formula errors went from $errorsBefore to $errorsAfter" }
  $wb.Save(); $wb.Close($false); $wb = $null

  $dst = Join-Path $Folder ("MASTER_updated_{0}.xlsx" -f ([DateTime]::Parse($newLastWeek).ToString('ddMMyy')))
  if (Test-Path -LiteralPath $dst) { throw "$dst already exists - not overwriting" }
  Copy-Item -LiteralPath $work -Destination $dst
  Log "saved $dst (errors before $errorsBefore, after $errorsAfter)"
} catch {
  Log "FAILED: $($_.Exception.Message)"
  $flag = Join-Path $Folder ("MASTER_update_FAILED_{0}.txt" -f (Get-Date -Format 'yyyyMMdd'))
  Set-Content -LiteralPath $flag -Value "The automatic MASTER update failed on $(Get-Date): $($_.Exception.Message)`r`nNothing was changed. Log: $LogFile" -Encoding UTF8
  exit 1
} finally {
  if ($wb) { try { $wb.Close($false) } catch {} }
  if ($xl) { $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
  if ($work -and (Test-Path -LiteralPath $work)) { Remove-Item -LiteralPath $work -ErrorAction SilentlyContinue }
}
