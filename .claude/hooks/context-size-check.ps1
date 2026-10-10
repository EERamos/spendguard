# context-size-check.ps1 — UserPromptSubmit hook
# Stats docs/context/*.md against per-file caps. Emits ONE warning line into
# context when any file is over cap; silent (no output) when all are under.
# Always exits 0 — never blocks the turn.
# SINGLE SOURCE OF TRUTH for cap values: CLAUDE.md and /compact-context read
# the caps from this table — edit them here only.
$ErrorActionPreference = 'SilentlyContinue'

$root = $env:CLAUDE_PROJECT_DIR
if (-not $root) { $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }
$dir = Join-Path $root 'docs\context'

# Per-file caps in APPROX TOKENS (bytes/4 = what the context window actually pays).
$caps = [ordered]@{
  'memory.md'     = 11000
  'lessons.md'    = 7000
  'todo.md'       = 2500
  'results.md'    = 6000
  'sesion-log.md' = 4000
}

$over = foreach ($name in $caps.Keys) {
  $f = Join-Path $dir $name
  if (Test-Path $f) {
    $tok = [math]::Round((Get-Item $f).Length / 4)
    if ($tok -gt $caps[$name]) { "$name ~${tok}tok>$($caps[$name])" }
  }
}

if ($over) {
  "[context-size] OVER CAP: $($over -join ', '). Run /compact-context to snapshot+hard-compact before these files bloat the per-task token floor."
}
exit 0
