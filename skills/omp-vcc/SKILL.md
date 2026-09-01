# omp-vcc Skill — VCC-Inspired Algorithmic Compaction

> Lossless, transcript-preserving structured summaries — no LLM calls. Based on `sting8k/pi-vcc` (TypeScript) and `lllyasviel/VCC` (View-oriented Conversation Compiler, arXiv 2603.29678).

## Philosophy

- **Agent trace as structured document** (`user`, `assistant`, `thinking`, `tool_call/result`, `subagent`, compaction boundaries, harness directives). Like VCC's `V_full` identity view defines a line-number coordinate system; `V_ui` gives a one-line tool summary (`* Read "src/pets.py" (file.txt:18-20)`); `V_adapt(b, ρ)` projects via relevance predicate `ρ` (regex / BM25 / embedding / LLM) preserving turn headers, role tags, and `(f:s-e)` pointers.
- **Fast, deterministic, lossless** — pure extraction, not LLM summarization. 30–470 ms, 35–99% context reduction, pointer invariant `V_ui → V_full[s:e]` holds structurally (SSA-like).
- **Progressive disclosure** — brief transcript → ranked recall via `vcc_recall` (`ρ = regex→OR`) → drill-down `#N:path` resolves `(session.jsonl:s-e)` into the full view.

## Pipeline

Calibrated `charsPerToken` from `preparation.tokensBefore` (heuristic fallback 4) → Smart keep-tail (5 k → 25 k) → Build own cut (`firstKeptEntryId`, orphan recovery) → Token-budget tail rescue (`no_anchor` / `oversized_tail` ×2.5) → Normalize (IR lex: escaped JSON→`|` block, `digits→` strip, `<system-reminder>` filter, `TodoWrite`/`ToolSearch`/ANSI strip, `same message.id` merge, `queue-operation` discard, base64 image extract) → Filter noise → Build 5 sections (Session Goal, Files And Changes, Commits, Outstanding Context, User Preferences) → Ranked brief transcript (TF-IDF, `RANKED_BRIEF_BUDGET_TOKENS=1100` ceiling 2000, ~15 tok/block) → Format bracketed sections + separator `---` → Bounded merge (sticky dedup, volatile replace, transcript roll, 120-line cap).

## Usage

- **Auto**: threshold/overflow compaction intercepts `session_before_compact` when `overrideDefaultCompaction=true` (default). No LLM summary; token-budgeted.
- **Manual**: `/omp-vcc [keep:N] [focus]` — e.g. `/omp-vcc keep:2 fix auth` keeps last 2 user turns. Also `/pi-vcc` alias.
- **Recall**: `vcc_recall({query:"redis cache", scope:"all", page:1})` or `/vcc-recall hook|inject scope:all page:2`. Regex first, then TF-IDF OR fallback. `mode:'touched'` lists files, `#12:src/auth.ts` drills. 5 per page.

## Configuration

File `~/.omp/omp-vcc/config.json` (XDG-aware via `$OMP_DIR`/`$PI_CODING_AGENT_DIR`/`$OMP_VCC_CONFIG_PATH`, migrates legacy `~/.pi/agent/pi-vcc-config.json`). Manifest `omp.settings` also exposed: `vccEnabled`, `overrideDefaultCompaction`, `smartKeepTail`, `continueAfterThresholdCompact`, `debug` (`/tmp/omp-vcc-debug.json`).

Optional native strategy: add `vcc` to `COMPACTION_METHOD_CHOICES` in `oh-my-pi` (see `docs/configuration.md#native-strategy`).

## Verification

`bunx tsc --noEmit` → `bun test` → `bun run smoke` → `omp plugin link` → `/omp-vcc keep:1` shows `[Session Goal]` toast `omp-vcc: kept 1/5 turns, ~2.1k tok`.

## Related

- VCC paper `arxiv:2603.29678` — three views, AppWorld evaluation (+1.1–4.2 pts, ½–⅔ tokens)
- `sting8k/pi-vcc` `@0.7.0` — ported core `extensions/vcc-core/*` verbatim, imports adapted to `@oh-my-pi/*`
- `lllyasviel/VCC` `VCC.py` — adaptive `SEP`, `match_lines`, transposed modalities
