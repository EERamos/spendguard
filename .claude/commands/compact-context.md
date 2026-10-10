---
description: Snapshot + hard-compact over-cap docs/context working-memory files into archive
---

Compact the project working-memory files in `docs/context/` that have grown past their size cap. Optional `$ARGUMENTS` = a single filename to force-compact even if under cap.

## Caps — single source of truth
Cap values live in the `$caps` table of `.claude/hooks/context-size-check.ps1` (approx tokens = bytes/4). Read them from there; they are not restated here.

## Procedure

1. **Measure.** Read the `$caps` table from `.claude/hooks/context-size-check.ps1`. List `docs/context/*.md` with sizes via PowerShell. Get today's date: `(Get-Date -Format 'yyyy-MM-dd')`. Determine which files are over cap (or just the `$ARGUMENTS` file if given).

2. **For each target file, snapshot first.** Create `docs/context/archive/<name-without-ext>/` if missing, then COPY the current full file to `docs/context/archive/<name-without-ext>/<date>.md`. Copy — never move the active file out of `docs/context/` (CLAUDE.md and reads point at the canonical path).

3. **Hard-compact via subagent (one per file, parallel).** Dispatch a subagent per target so the main context stays clean. Compaction rules the subagent must follow:
   - One line per entry. No prose paragraphs.
   - Dedupe aggressively — merge every entry stating the same fact / rule / decision into one sharp line.
   - Drop stale, superseded, or completed items. Done todos move to `results.md` (then age into archive), not back into `todo.md`.
   - For `results.md` / `sesion-log.md`: keep recent entries detailed, collapse older ones into grouped **monthly** one-liners. Collapse runs of auto-captured `subagent` lines into one summary line per work block; drop `(auto-stub)` and `compaction` marker lines older than the most recent real entry.
   - PRESERVE EXACTLY: file paths, commit hashes, migration/table names, code identifiers, dates, command strings, error strings, magic constants, URLs.
   - Target: under the cap, ideally ~60% of it. Lose no load-bearing fact.
   - Return ONLY the rewritten markdown.

4. **Write back.** Write the subagent output to a fresh `docs/context/<name>.new.md`, then `Move-Item -Force` it over the original. (The Write tool refuses to overwrite a path it hasn't Read this session; the `.new.md` → move dance sidesteps that without re-reading the bloated original.)

5. **Report** before/after token counts (`bytes / 4`) per file.

Never run this inline during unrelated feature work — hard-compaction reads the whole file (tokens) and derails the task. This command is the only sanctioned time to compact.
