# omp-vcc Skill — VCC-Inspired Algorithmic Compaction

> Lossless, transcript-preserving structured summaries — no LLM calls. Based on `sting8k/pi-vcc` (TypeScript) and `lllyasviel/VCC` (View-oriented Conversation Compiler, arXiv 2603.29678). Port of `sting8k/pi-vcc@0.7.0` into `oh-my-pi` via `ExtensionAPI`. See `docs/harness.md` for adds vs intercepts and `docs/setup.md#working-with-existing-compaction-strategies` for coexistence.

## When to Use

- **Context growing** (50+ turns, tool output heavy, approaching threshold) — prefer `V_ui → V_adapt → V_full` over keeping a huge verbatim tail.
- **After auto compaction** — read the `V_ui` summary (5 sections + 120-line ranked brief) then `vcc_recall` for anything not in it, instead of asking the user to repeat.
- **Before risky edits / handoffs** — run `/omp-vcc keep:2 fix auth` to create a clean boundary; recall later with `#N:path`.

## Philosophy

- **Agent trace as structured document** (`user`, `assistant`, `thinking`, `tool_call/result`, `subagent`, compaction boundaries, harness directives). Like VCC's `V_full` identity view defines a line-number coordinate system; `V_ui` gives a one-line tool summary (`* Read "src/pets.py" (file.txt:18-20)`); `V_adapt(b, ρ)` projects via relevance predicate `ρ` (regex / BM25 / embedding / LLM) preserving turn headers, role tags, and `(f:s-e)` pointers.
- **Fast, deterministic, lossless** — pure extraction, not LLM summarization. 30–470 ms, 35–99% context reduction, pointer invariant `V_ui → V_full[s:e]` holds structurally (SSA-like) via stable `(#N)` refs and `firstKeptEntryId` lineage. Single line assignment before lowering (calibrated `charsPerToken` 2–6, fallback 4) guarantees pointers across views.
- **Progressive disclosure** `V_ui → V_adapt(query) → V_full[s:e]` — scan the cheap overview, query for structure-preserving hits, drill to verbatim lines only when needed. AppWorld `MEMORY.md` diff-merge uses the same pattern.

## What omp-vcc Does to the Harness

**Adds** (no core file edit — `extensions/main.ts` factory `(pi: ExtensionAPI) => void`):

- 2 tools: `vcc_recall` (`query`, `expand`, `page`, `scope`, `mode` via `pi.zod`, approval `read`) and `vcc_stats` (`{history?: boolean}`) — `extensions/main.ts:56-159` / `hook.ts:1233-1263`.
- 5 command registrations: `/omp-vcc` (primary) + `/pi-vcc` alias, `/vcc-recall` + `/pi-vcc-recall`, `/vcc-stats` + `/omp-vcc-stats` plus inline `/omp-vcc --stats` — `extensions/main.ts:164-344`.
- Skill `skills/omp-vcc/SKILL.md` (this file) and 5 boolean settings in `package.json:omp.settings` (`vccEnabled`, `overrideDefaultCompaction`, `smartKeepTail`, `continueAfterThresholdCompact`, `debug`) surfaced in `/settings` plugin section.

**Intercepts** via `ExtensionAPI.on(...)` — `hook.ts:708-723`:

- `session_before_compact` — preempts host `SessionMaintenance` walk. Gate: `vccEnabled && (isVccSentinel || overrideDefaultCompaction)` where sentinel is `__omp_vcc__` / `__pi_vcc__` (`core/compact-args.ts`). With default `overrideDefaultCompaction:true` it handles every auto trigger (`threshold` / `overflow` / `incomplete` / `midTurn` / `idle` / `/compact`) deterministically via `compileRanked`; with `false` it only handles explicit `/omp-vcc` and defers (`void`) to host `methodOrder` walk.
- `session_compact` (`fromExtension:true` only) — enriches last stats with authoritative `tokensAfter`/`saved`/`percent` before `isPiVccLast`/`willRetry` returns, toasts `90.0k→22.0k (76% saved) · kept 1/5 turns`, and schedules invisible-continue (`customType:"omp-vcc-auto-continue"` `display:false` `triggerTurn:true` `deliverAs:"followUp"`) when `(threshold|overflow) && continueAfterThresholdCompact && !willRetry`.
- `context` — strips the invisible-continue marker by `customType` only, so the LLM sees clean `summary + kept tail`.
- `before_agent_start` — clears pending auto-continue timer to avoid stale follow-ups.

**Does not edit**: `SessionMaintenance` / `CompactionPreparation` / `CompactionMethod` closed enum / `SessionEntry` schema / display transcript / native `crates/pi-natives/src/snapcompact.rs` rasterizer. Host `pruneToolOutputs` (protect 40k, require 20k, `MIN_PRUNE 50`) and `[Uneventful result elided]` still run before the hook and benefit `omp-vcc`. Savings persist as additive `details.savings` `version:2` in the `compaction` entry — `docs/harness.md §4`.

## Pipeline

```
Calibrate (cpt) → SmartKeep → BuildOwnCut → TailBudget → Normalize (IR) → FilterNoise → BuildSections → Brief V_ui → Format → Merge
                                     └→ Recall V_adapt
```

- **Calibrate** `calibrateCharsPerToken(totalChars/tokensBefore)` clamp 2–6, fallback 4 — `core/token-estimate.ts`.
- **SmartKeep** `resolveSmartKeepUserTurns` — boosts default `keep:1` while `tailTokens(1) ≤5k` to largest `k` with `tailTokens(k) ≤25k`. Explicit `keep:N` never boosted. — `hook.ts:618-701`.
- **BuildOwnCut** `buildOwnCut(branchEntries, keep:N)` — live via `firstKeptEntryId` + orphan `""` recovery, `/clear` `reset_boundary` precedence, `>2` live, `cutIdx=userIndices[target]`, `keep:0` → `compactAll` sentinel `""`.
- **TailBudget** `applyTailBudget` / `findBudgetCutIndex` — rescue only `compactAll→no_anchor` or `tail>max*2.5→oversized_tail`, snaps off `toolResult` boundary.
- **Normalize** `normalize.ts` / `sanitize.ts` / `content.ts` — ANSI strip, `digits→` strip, escaped JSON `→` `|` block, `<system-reminder>` filtered, `TodoWrite`/`queue-operation` discarded, same `message.id` merged.
- **BuildSections** 5 extractors: `[Session Goal]` `goals.ts`, `[Files And Changes]` `files.ts`, `[Commits]` `commits.ts`, `[Outstanding Context]` `report.ts`, `[User Preferences]` `preferences.ts` — `core/build-sections.ts`.
- **Brief V_ui** `brief.ts` + `rank.ts` TF-IDF + `format.ts` + `summarize.ts` `compileRanked` — budget `RANKED_BRIEF_BUDGET_TOKENS 1100` ceiling 2000, `RANKED_BRIEF_CHARS_PER_BLOCK 15*cpt`, `BRIEF_MAX_LINES 120` via `capBrief`. Sticky dedup, volatile replace, transcript roll.
- **Recall V_adapt** `search-entries.ts` `searchEntriesDetailed` regex → TF-IDF OR (`rank.ts` rare-term weighted), `format-recall.ts` `SEP`, `drill-down.ts` `#N:path`, `render-entries.ts` skeleton — default `scope:lineage` (active branch) vs `scope:all`, `mode:'touched'` flat list.

Module map `extensions/vcc-core/` — `hook.ts` orchestrator + `core/` vendored pipeline (`-- @ts-nocheck`) + `extract/*` + `types.ts`/`details.ts` `version:2` + `sections.ts`. Full map `docs/architecture.md`.

## Usage

**Auto** (default `overrideDefaultCompaction:true`): threshold/overflow auto compaction is deterministic `V_ui` in 30–470 ms, no LLM. No action needed — leave `compaction.methodOrder` at default `["remote","snapcompact","handoff","shake","soft"]`, it is dormant for auto while `omp-vcc` handles.

**Manual**:

```
/omp-vcc                 # keep last 1 (smart-keep may grow to 2-4 if tail tiny)
/omp-vcc keep:2 fix auth # explicit keep + focus text (injected as follow-up)
 /omp-vcc keep:0          # compact all — next turn from pure V_ui
/omp-vcc --stats          # no compact — show last savings + history
/pi-vcc                  # alias
```

Explicit `keep:N` always wins over smart-keep. Smart-keep only grows when default tail wastes budget.

**Recall** — prefer small keep + recall over huge tail:

```
# command
/vcc-recall redis cache              # plain keywords — OR + TF-IDF, 5/page
/vcc-recall hook|inject scope:all    # regex, lineage vs all
/vcc-recall auth scope:all page:2    # pagination
/vcc-recall #18:src/auth.ts          # drill — verbatim V_full[18:e]
/vcc-recall touched mode:touched     # flat file index

# tool (agent-callable)
vcc_recall({query:"redis cache", scope:"all", page:1})
vcc_recall({query:"hook|inject"})
vcc_recall({query:"#12:src/auth.ts"})
vcc_recall({query:"", mode:"touched"})
```

Regex tried first; invalid or no hits falls back to TF-IDF OR (rare terms weighted). Default `scope:lineage` (active branch); `scope:all` includes abandoned branches. Each hit preserves `turn/header/block`, role tags, and `(#N)` / `(f:s-e)` pointers. Use `expand:[indices]` for file slices.

**Savings** (per-pi `WeakMap` + `perPiKeys` Set, capped 50, copy-isolated; see `docs/harness.md §7`):

```
# commands / tools — same table
/vcc-stats                 # last + history header
/vcc-stats history         # full 50-row table | # | Before → After | Saved | Kept | Summarized | When |
/omp-vcc --stats history
vcc_stats({history:true})
```

Toast after every `omp-vcc` compaction: `omp-vcc: 90.0k→22.0k (76% saved, ~68.0k) · kept 1/5 turns, ~2.1k tok` (prefix only when `before>after>0 && percent>0`, else fallback `kept 1/5 turns`; `budgetCut` wording `no user anchor`/`oversized tail`; `after>before→0`). Divider `── 📷 compacted · 90K→22K · ctrl+o ──` is host-rendered; plugin causes it via `firstKeptEntryId`.

## Coexistence with Host Strategies

`oh-my-pi` walks `compaction.methodOrder` → `compaction-methods.ts:10-49` default `remote → snapcompact → handoff → shake → soft`. `omp-vcc` does not rewrite the order; its `session_before_compact` hook preempts the walk when it returns `{compaction}` (host commits with `fromExtension:true`). Speculation disabled when handler present (`session-maintenance.ts:1230`).

| `overrideDefaultCompaction` | `/omp-vcc` | `threshold`/`idle`/`midTurn` | `overflow` (`willRetry:true`, reuses input) | `handoff` eligibility |
|---|---|---|---|---|
| `true` (default) |  `V_ui` | `V_ui` — native order ignored, `pruneToolOutputs` still ran before | `V_ui` when it can cut; if `too_few`/`no_live` and `willRetry` it defers → host skips `handoff` per `docs/compaction.md:112` | dormant for auto (`override:true`) |
| `false` | `V_ui` (sentinel bypass) | host walks `methodOrder` | host walks, **skips `handoff`** for overflow | overflow skips `handoff`; incomplete allows it |

- **Keep `shake` always.** Shake elides `artifact://` refs behind `COMPACTION_RECOVERY_BAND 0.8` hysteresis (`session-maintenance.ts:190-201`); can reclaim headroom after `V_ui` without a second summary. Costs nothing when `V_ui` already recovered.
- **Keep `snapcompact` for vision models.** Snapcompact needs `model.input includes "image"` (`compaction-methods.ts:124`); archives full discarded history as bitmap frames + `preserveData.snapcompact` `Archive{frames,...}` via `crates/pi-natives` 18 variants. With `override:true` it stays dormant for auto but reachable via explicit `/compact snapcompact`; with `override:false` the walk picks it for vision models. Pinned reference `docs/omp-snapcompact.md` @ `18781d8295`.
- **Keep `handoff` for hand-off docs.** Writes markdown via `handoff-document.md`; note overflow never picks `handoff`.
- **Drop `remote`/`soft` for fully deterministic/offline.** Both call an LLM; with `override:true` they are never reached for auto.

Practical toggling → `docs/setup.md#working-with-existing-compaction-strategies`:

```sh
# let host own auto, keep /omp-vcc manual
omp config set plugins."@zhulinchng/omp-vcc".overrideDefaultCompaction false
omp config set compaction.methodOrder '["handoff","shake","soft"]'
# explicit still V_ui
/omp-vcc keep:1
/compact  # now host order
```

Host pipeline bypassed by `V_ui` is `pruneToolOutputs → drop useful → calculateContextTokens → threshold check → prepareCompaction (honor /clear, never cut at toolResult) → walk` → `docs/harness.md §5.2.1` + pinned `docs/omp-compaction.md`.

## Configuration

File `~/.omp/omp-vcc/config.json` (XDG priority `$OMP_VCC_CONFIG_PATH` > `$PI_VCC_CONFIG_PATH` > `$OMP_DIR`/`$PI_CODING_AGENT_DIR` > `~/.omp/omp-vcc/config.json`; migrates `~/.pi/agent/pi-vcc-config.json` once). `scaffoldSettings()` fills missing keys. Manifest `package.json:omp.settings` / `pi.settings` is `/settings` UI; `loadSettings(ctx)` overlays `ctx.settings.get("plugins.@zhulinchng/omp-vcc.*")` so toggles apply this compaction without restart — `core/settings.ts:26-67` `DEFAULT_SETTINGS`.

| Flag | Default | Effect |
|---|---|---|
| `vccEnabled` | `true` | Master switch. `false` still handles sentinel `/omp-vcc` when forced, else `void`. |
| `overrideDefaultCompaction` | `true` | `true` handles **all** compactions; `false` only sentinel — see coexistence table above. |
| `smartKeepTail` | `true` | Grow default `keep:1` while tail ≤5k to largest ≤25k. |
| `continueAfterThresholdCompact` | `true` | After `threshold`/`overflow` (not `willRetry`/`compactAll`) continue via invisible marker so agent doesn't stall mid-task; `idle` never continues per host. |
| `debug` | `false` | Write `/tmp/omp-vcc-debug.json` (and legacy `/tmp/pi-vcc-debug.json`) — `usedOwnCut`, `budgetCut`, `tokensBefore`, `tokenEstimate{cpt,mode}`, `sections`, `savings` + `authoritativeSavings` after `session_compact`. |

Optional native dropdown: add `vcc` to `COMPACTION_METHOD_CHOICES` + `STRATEGY_BY["vcc"]="context-full"` + `DEFAULT` put `vcc` first at `isCompactionMethod` (`Object.hasOwn`) → `compaction-methods.ts:11-60` — then `/settings → Context → General → Compaction method order` shows `VCC`. Not required when `override:true`. See `docs/configuration.md#optional-native-strategy-patch`.

## Verification

```sh
bunx tsc --noEmit        # 0 (vendored // @ts-nocheck, skipLibCheck)
bun test                 # 378 tests across 36 files, 1007 expects, 0 fail
bun run smoke            # 9 checks: 3 hooks + 4 commands + 2 tools
omp plugin link . && omp plugin doctor  # 5 ok 0 warnings
omp -e @zhulinchng/omp-vcc
/omp-vcc keep:1          # expect [Session Goal] + toast omp-vcc: kept 1/5 …
cat /tmp/omp-vcc-debug.json | jq '{usedOwnCut,tokensBefore,sections,savings}'
/vcc-stats               # last + history (50-capped)
```

`docs/verification.md` and `docs/harness.md §9` are the re-runnable truth (`grep -R "session_before_compact" extensions/vcc-core/hook.ts` etc).

## Related

- VCC paper `arxiv:2603.29678` — three views, AppWorld evaluation (+1.1–4.2 pts, ½–⅔ tokens)
- `sting8k/pi-vcc` `@0.7.0` — ported core `extensions/vcc-core/*` verbatim, imports adapted to `@oh-my-pi/*`
- `lllyasviel/VCC` `VCC.py` — adaptive `SEP`, `match_lines`, transposed modalities
- Host docs pinned @ `18781d8295`: `docs/omp-compaction.md` (method order & triggers) · `docs/omp-snapcompact.md` (bitmap frames, 18 variants, billing) · live impact `docs/harness.md` + practical `docs/setup.md`

