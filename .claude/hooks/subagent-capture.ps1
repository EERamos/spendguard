# subagent-capture.ps1 — SubagentStop hook
# Appends each finished subagent's final message (truncated) to
# docs/context/results.md, so subagent outcomes survive compaction and session
# end without spending any context tokens. The over-cap cycle in
# context-size-check.ps1 + /compact-context keeps growth bounded.
#
# Guard rails, learned the hard way: the previous version defaulted the agent
# name to 'subagent' whenever the payload lacked one, so ANY invocation of this
# hook wrote a line — including turns where no subagent ever ran. It also
# replaced every non-ASCII char with '?' and appended in ANSI, which mangled
# accented Spanish. Both are fixed below.
$ErrorActionPreference = 'SilentlyContinue'

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }

$data = $raw | ConvertFrom-Json
if (-not $data) { exit 0 }

$root = $env:CLAUDE_PROJECT_DIR
if (-not $root) { $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent }

# Keep the last raw payload for diagnosis when the schema shifts.
[System.IO.File]::WriteAllText(
  (Join-Path $PSScriptRoot '.last-payload.json'),
  $raw,
  [System.Text.UTF8Encoding]::new($false)
)

# Only `agent_type` proves a real subagent ran. Observed payload from a plain
# main-agent turn (2026-07-31):
#   {"agent_id":"a347c5176b08fade6","agent_type":"","hook_event_name":"SubagentStop",
#    "last_assistant_message":"<the user's own prompt>"}
# This runtime emits SubagentStop on every turn with an agent_id but an EMPTY
# agent_type, so accepting agent_id as identity logs ordinary turns. Require a
# non-empty agent_type and nothing else.
$agent = ([string]$data.agent_type).Trim()
if (-not $agent) { $agent = ([string]$data.subagent_type).Trim() }
if (-not $agent) { exit 0 }

$msg = $null
foreach ($key in 'last_assistant_message', 'response', 'result', 'message') {
  $value = [string]$data.$key
  if ($value) { $msg = $value; break }
}
if (-not $msg) { exit 0 }

$file = Join-Path $root 'docs\context\results.md'
if (-not (Test-Path $file)) { exit 0 }

# One line, accents preserved, capped at 200 chars.
$snippet = ($msg -replace '\s+', ' ').Trim()
if ($snippet.Length -gt 200) { $snippet = $snippet.Substring(0, 200) + '...' }

$line = "- [{0}] subagent {1}: {2}" -f (Get-Date -Format 'yyyy-MM-dd'), $agent, $snippet

# Don't repeat the previous entry verbatim.
$existing = [System.IO.File]::ReadAllLines($file)
if ($existing.Length -gt 0 -and $existing[-1].Trim() -eq $line) { exit 0 }

[System.IO.File]::AppendAllText($file, $line + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
exit 0
