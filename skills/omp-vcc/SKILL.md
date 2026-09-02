---
name: omp-vcc
description: VCC-inspired algorithmic compaction for oh-my-pi — lossless V_ui summary + ranked brief + V_adapt recall via vcc_recall. Use after auto-compaction (toast 90k→22k), when context grows 50+ turns, or before /omp-vcc keep:N boundaries.
---

# omp-vcc Skill — VCC-Inspired Algorithmic Compaction

> Lossless, deterministic summarization — no LLM. `V_full` = full transcript, `V_ui` = structured summary + ranked brief, `V_adapt(b, ρ)` = structure-preserving recall. Use `V_ui → V_adapt(query) → V_full[s:e]`: scan summary, query, drill to verbatim lines.

## When to Use

- **After auto compaction** — read `V_ui` first, then `vcc_recall` for anything missing before asking the user to repeat. Toast `omp-vcc: 90.0k→22.0k (76% saved) · kept 1/5 turns` + divider `── 📷 compacted ──` means you just got a `V_ui`.
- **Context is growing** (50+ turns, heavy tool output) — prefer small keep + recall over a huge tail. Recall is cheap and preserves turn/header/block.
- **Before risky work** — create a clean boundary: `/omp-vcc keep:2 <focus>` (e.g. `/omp-vcc keep:2 fix auth`). The focus text is sent as the next user message after compaction.

## What You Get (V_ui)

Compacted summary replaces the old transcript; `V_ui` + kept tail is what you see next:

```sh
[Session Goal]
- …

[Files And Changes]
- …

[Commits]
- …

[Outstanding Context]
- …

[User Preferences]
- …

---
* Read "src/pets.py" (file.txt:18-20)          ← ranked brief, one line per block
* Edit src/auth.ts { old: "…" (#12:auth.ts:10-40) }

Use `vcc_recall` to search for prior work … Do not redo work already completed.
```

- **5 sections** are extraction-only (no hallucination): Session Goal, Files And Changes, Commits, Outstanding Context, User Preferences.
- **Ranked brief**: TF-IDF-ranked tool summaries, capped at **120 lines** (`BRIEF_MAX_LINES=120`), token-budgeted **1100 → 2000 tokens** (`RANKED_BRIEF_BUDGET_TOKENS` floor, `CEILING` 2000, ~15 tok/block). `---` separates sections from brief; earlier lines beyond 120 are dropped tail-first.
- **Every line keeps a pointer** `(#N)` or `(path:s-e)` so `V_ui → V_full[s:e]` is structural. Trust the summary's pointers; drill for verbatim.

## Commands & Tools

| Task | How | Notes |
|---|---|---|
| **Check savings** | `/vcc-stats` · `vcc_stats({history:true})` | Last + history table (50-capped, no `omp-vcc-stats` alias). `/omp-vcc` toast is single line only; detailed savings via `/vcc-stats`. Use to confirm headroom before long edits. |
| **Recall search** | `/vcc-recall <query> [scope:all] [page:2]` · alias `/pi-vcc-recall` · tool `vcc_recall({query, scope, mode, page, expand})` | 5 hits/page, up to 50 total. See cookbook below. |
| **Stats tool** | `vcc_stats({history?: boolean})` | Same as `/vcc-stats`. `history:true` = full 50-row table. |

`vcc_recall` params (all optional): `query?: string`, `page?: number` (1-indexed), `scope?: "lineage" | "all"` (default `lineage` = active branch), `mode?: "hybrid" | "touched"` (default `hybrid`), `expand?: number[]` (valid indices only).

No config needed for normal use. Auto `threshold`/`overflow` compaction is already `V_ui` (deterministic, no model call, ~30–470 ms benchmark) when `overrideDefaultCompaction:true` (default). Don't fight it — just use the summary.

## Recall Cookbook — V_adapt

**How search works**: regex first; if invalid or no hits → TF-IDF keyword OR (rare terms weighted, stopwords removed). Each hit preserves turn/header/block, role tags, and `(#N)`. ±2 lines around the match are shown.

```sh
# basic keyword (TF-IDF OR)
vcc_recall({query:"redis cache"})
/vcc-recall redis cache

# regex (contains | * + ? {} () [] \ ^ $ .)
vcc_recall({query:"hook|inject"})
/vcc-recall hook|inject

# scope: include abandoned branches (default is active branch only)
vcc_recall({query:"auth", scope:"all"})
/vcc-recall auth scope:all

# pagination (5/page, up to 50)
vcc_recall({query:"auth", page:2})
/vcc-recall auth page:2 scope:all

# file index — what was touched, not text search
vcc_recall({query:"", mode:"touched"})
/vcc-recall touched mode:touched

# drill to verbatim lines — resolves (#N) or (path:s-e)
vcc_recall({query:"#12:src/auth.ts"})
/vcc-recall #12:src/auth.ts
vcc_recall({query:"#18"})                 # whole turn 18
vcc_recall({query:"#18:src/auth.ts:40-80"}) # slice (offset/limit via drill-down)

# expand multiple turns by index (from a prior recall's #N)
vcc_recall({query:"", expand:[12,18,25]})
```

**Pick the right query:**

- Find an edit/file: `mode:touched` then drill, or `query:"src/auth.ts"` then `#N:path`.
- Find a decision: `query:"why did we choose|decision|ADR"` (regex).
- Find an error/tool output: keyword of the error message — full tool output is searchable.
- Nothing found in `lineage` but you know it existed: retry `scope:all` (abandoned `/clear` branches are excluded by default).

**If you get:**

- `0 matches` — try keywords (no regex chars) or `scope:all`; check spelling of path.
- `truncated — showing 50 of 120 matches, refine…` — narrow regex/keywords.
- `Page 3 is outside 1-2 (7 matches)…` — use `page` in range or refine.
- `Cannot expand indices outside active lineage: 42. Use scope:'all'` — add `scope:"all"` or pick index from the same lineage.
- `#N` outside active lineage → same: retry with `scope:"all"` or use a `lineage` hit.

## Agent Playbook

1. **After any compaction, re-orient from V_ui.** Read Session Goal → Files → Outstanding → brief. Don't re-ask the user for what's already in the summary.
2. **Small keep + recall beats large keep.** `/omp-vcc keep:1` + `vcc_recall({query:"auth"})` keeps the focused tail small and lets you pull exact history on demand. Only `keep:3+` when you need verbatim recent context immediately after compaction.
3. **Recall before synthesis.** For any question about prior work (file changed, test added, decision made), call `vcc_recall` proportionally to context size: small session → 1 recall with broad keywords; long/complex session → 2–3 targeted recalls (keywords then drill).
4. **Create boundaries intentionally.** Before a multi-file refactor or hand-off doc: `/omp-vcc keep:2 continue auth refactor` — next turn starts from a fresh, citable `V_ui`. Verify with `/vcc-stats` (`kept 2/18 turns, 76% saved`) before continuing.
5. **Don't stall after threshold.** Auto threshold/overflow compaction auto-continues via invisible follow-up (you'll just see the summary and your next turn proceeds). If you issued `/omp-vcc keep:2 <focus>`, that focus text arrives as the next user message — treat it as the goal.
6. **Use pointers, don't re-derive.** When you quote prior work, cite `(#N)` or `(file:s-e)` from the brief; drill `#N:path` for verbatim to paste, not guessed content.
