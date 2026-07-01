# auto-grow.ps1 - watchdog runner for the growth agent (run-grow.js).
# Registered in Task Scheduler: fires at logon and hourly; this script then
# decides whether a run is due. Two slots per day: AM (>= 11:00) and PM
# (>= 19:00, and >= 3h after the AM run). No runs at night (22:30-11:00) -
# night activity is itself a bot signal. If the PC was off during a slot,
# the run happens at the first hourly check after power-on.
# State:   logs\auto\state.json   { date, amDoneAt, pmDoneAt }
# Reports: logs\auto\reports.txt  (shown in the Claude Code terminal by the
#          SessionStart hook, scripts\show-new-reports.ps1)
# -DryRun: print the run/skip decision and exit without doing anything.
# ASCII-only on purpose: PS 5.1 misreads BOM-less UTF-8 Cyrillic.

param([switch]$DryRun)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDir = Join-Path $root 'logs\auto'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stateFile = Join-Path $logDir 'state.json'

function Skip($reason) {
    if ($DryRun) { Write-Output "DECISION: skip ($reason)" }
    exit 0
}

$now = Get-Date
$today = $now.ToString('yyyy-MM-dd')

# ---- Load / reset daily state ----
$state = $null
if (Test-Path $stateFile) {
    try { $state = Get-Content $stateFile -Raw | ConvertFrom-Json } catch {}
}
if (-not $state -or $state.date -ne $today) {
    $state = [pscustomobject]@{ date = $today; amDoneAt = $null; pmDoneAt = $null }
}

# ---- Night window: runs allowed 11:00-22:30 only ----
$minutes = $now.Hour * 60 + $now.Minute
if ($minutes -lt (11 * 60) -or $minutes -gt (22 * 60 + 30)) {
    Skip 'night window (runs allowed 11:00-22:30)'
}

# ---- Pick the slot ----
$slot = $null
if (-not $state.amDoneAt) {
    $slot = 'am'
} elseif (-not $state.pmDoneAt) {
    if ($minutes -lt (19 * 60)) { Skip 'pm slot opens at 19:00' }
    $gapH = ($now - [datetime]$state.amDoneAt).TotalHours
    if ($gapH -lt 3) { Skip ("only {0:N1}h since am run, need 3h" -f $gapH) }
    $slot = 'pm'
} else {
    Skip 'both slots done today'
}

# ---- Daily action cap (shared with manual runs) ----
$counterFile = Join-Path $root 'build\data\igActionData.json'
if (Test-Path $counterFile) {
    try {
        $c = Get-Content $counterFile -Raw | ConvertFrom-Json
        if ($c.date -eq $today -and [int]$c.count -ge 25) {
            Skip "daily cap reached ($($c.count)/25)"
        }
    } catch {}
}

# ---- Lock: skip if another run (manual or scheduled) is active ----
$lock = Join-Path $logDir 'grow.lock'
if (Test-Path $lock) {
    $age = ($now - (Get-Item $lock).LastWriteTime).TotalHours
    if ($age -lt 2) { Skip 'another run is active (fresh lock)' }
}

if ($DryRun) { Write-Output "DECISION: run slot '$slot'"; exit 0 }

New-Item -ItemType File -Force -Path $lock | Out-Null
try {
    # Mark the slot taken BEFORE the run: a mid-run crash must not cause
    # hourly retries (real actions are capped by the daily counter anyway).
    if ($slot -eq 'am') { $state.amDoneAt = $now.ToString('o') }
    else { $state.pmDoneAt = $now.ToString('o') }
    $state | ConvertTo-Json | Set-Content -Path $stateFile -Encoding ASCII

    # Human-like jitter (0-20 min) so start times never repeat day to day.
    Start-Sleep -Seconds (Get-Random -Minimum 0 -Maximum 1200)

    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
    $log = Join-Path $logDir "grow-$stamp.log"
    & "C:\Program Files\nodejs\node.exe" run-grow.js *> $log
    $exit = $LASTEXITCODE

    # ---- Append the report ----
    $doneLine = (Select-String -Path $log -Pattern '\[GROW\] Done:' | Select-Object -Last 1).Line
    if (-not $doneLine) { $doneLine = 'no Done summary (crash or stopped early?)' }
    $blocked = [bool](Select-String -Path $log -Pattern 'Action Block' -Quiet)
    $limitHit = [bool](Select-String -Path $log -Pattern 'Daily action limit reached' -Quiet)
    $likes = (Select-String -Path $log -Pattern '\[info\]: Liked ').Count
    $counter = 'n/a'
    if (Test-Path $counterFile) { $counter = (Get-Content $counterFile -Raw) -replace '\s+', ' ' }

    $report = @(
        "=== InstaAgent grow run $stamp (slot: $slot) ===",
        "exit=$exit  likes=$likes  actionBlocked=$blocked  dailyLimitHit=$limitHit",
        "daily counter: $counter",
        $doneLine,
        "log: $log",
        ''
    ) -join "`r`n"
    Add-Content -Path (Join-Path $logDir 'reports.txt') -Value $report -Encoding ASCII
} finally {
    Remove-Item -Force $lock -ErrorAction SilentlyContinue
}
