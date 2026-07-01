# show-new-reports.ps1 - SessionStart hook for Claude Code.
# Prints grow-run reports appended to logs\auto\reports.txt since the last
# session (byte cursor in logs\auto\reports.seen). Silent when nothing new.

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$rep = Join-Path $root 'logs\auto\reports.txt'
$cur = Join-Path $root 'logs\auto\reports.seen'
if (-not (Test-Path $rep)) { exit 0 }

$len = (Get-Item $rep).Length
$seen = 0
if (Test-Path $cur) {
    $raw = (Get-Content $cur -TotalCount 1)
    if ($raw -match '^\d+$') { $seen = [int64]$raw }
}
if ($seen -gt $len) { $seen = 0 }   # reports.txt was truncated/rotated

if ($len -gt $seen) {
    $fs = [System.IO.File]::OpenRead($rep)
    try {
        $fs.Seek($seen, 'Begin') | Out-Null
        $sr = New-Object System.IO.StreamReader($fs)
        $new = $sr.ReadToEnd()
    } finally { $fs.Dispose() }
    if ($new.Trim()) {
        Write-Output '[InstaAgent] New grow-run reports since your last session:'
        Write-Output $new
    }
}
Set-Content -Path $cur -Value $len -Encoding ASCII
