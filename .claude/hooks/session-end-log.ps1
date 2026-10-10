# session-end-log.ps1 — SessionEnd hook
# Appends a bare date stub to docs/context/sesion-log.md when a session ends,
# so the log never has silent gaps even when the model forgot to write its
# line. Max one auto-stub per day — a substantive entry for today (written by
# the model per CLAUDE.md Task Management) suppresses the stub.
$ErrorActionPreference = 'SilentlyContinue'

$data = [Console]::In.ReadToEnd() | ConvertFrom-Json

$root = $env:CLAUDE_PROJECT_DIR
if (-not $root) { $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$file = Join-Path $root 'docs\context\sesion-log.md'
if (-not (Test-Path $file)) { exit 0 }

$date = Get-Date -Format 'yyyy-MM-dd'
# skip if today already has any entry (model-written or a previous stub)
if (Select-String -Path $file -Pattern ("\[" + $date) -Quiet) { exit 0 }

$reason = if ($data.reason) { $data.reason } else { 'unknown' }
[System.IO.File]::AppendAllText($file, "- [$date]: session end ($reason) (auto-stub - no model entry today)" + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
exit 0
