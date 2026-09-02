# Repository Guidelines

## Project Overview

`@zhulinchng/omp-vcc` — VCC-inspired algorithmic compaction plugin for `oh-my-pi` (`omp`). Zero-LLM, deterministic (30–470 ms), ports `sting8k/pi-vcc@0.7.0`. Implements VCC views from `arxiv:2603.29678`: `V_full` identity, `V_ui` one-line brief transcript, `V_adapt(b,ρ)` ranked recall.

Provides: automatic `threshold`/`overflow` compaction via `session_before_compact` (intercepts all compactions when `overrideDefaultCompaction:true`, default), manual `/omp-vcc [keep:N] [focus] [--stats]`, `vcc_recall` + `vcc_stats` tools, `/vcc-recall` + `/vcc-stats` commands. Native `/settings` dropdown requires an optional one-file core patch (`docs/configuration.md#native-strategy`).

## Architecture & Data Flow

### Compiler pipeline (VCC §2.2–2.3 → omp-vcc)

```
Calibrate (token-estimate) → SmartKeep → BuildOwnCut → Normalize (IR) → FilterNoise → BuildSections → Brief (V_ui) → Format → Merge
                                           └─→ Recall ranking (V_adapt)
```

Single line assignment before lowering guarantees pointer invariant `V_ui → V_full[s:e]` via stable `(#N)` refs / `firstKeptEntryId` lineage. All cleaning preserves `turn/header/block` delimiters and role tags.

| Stage | Module | Key symbol |
| --- | --- | --- |
| Calibrate `charsPerToken` | `core/token-estimate.ts` | `calibrateCharsPerToken(totalChars/tokensBefore)` clamp 2–6, fallback 4 |
| Smart keep | `hook.ts` | `resolveSmartKeepUserTurns`, `MIN_SMART_TAIL_TOKENS 5_000` → `MAX_SMART_TAIL_TOKENS 25_000`, explicit `keep:N` not boosted |
| Build cut | `hook.ts` | `buildOwnCut(branchEntries, keep:N)` — live via `firstKeptEntryId` + orphan `""` recovery, `compactAll` sentinel |
| Budget rescue | `hook.ts` | `applyTailBudget`, `findBudgetCutIndex` ×`OVERSIZED_TAIL_FACTOR 2.5`, snap off `toolResult` boundary |
| Normalize (lex→parse IR) | `core/normalize.ts`, `sanitize.ts`, `content.ts`, `load-messages.ts` | ANSI strip, `queue-operation` discard, `digits→` strip, `Escape JSON` → block marker |
| Filter noise | `core/filter-noise.ts` | harness `<system-reminder>` etc removed |
| Build sections | `core/build-sections.ts` + `extract/*` | 5 sections: Goal, Files, Commits, Preferences, Outstanding |
| Brief `V_ui` | `core/brief.ts`, `rank.ts`, `summarize.ts` | `RANKED_BRIEF_BUDGET_TOKENS 1100` (hook.ts) ceil 2000, `BRIEF_MAX_LINES 120` (format.ts), `compileRanked` |
| Recall `V_adapt` | `core/search-entries.ts`, `format-recall.ts`, `drill-down.ts`, `render-entries.ts` | `searchEntriesDetailed` regex→OR TF-IDF, `SEP`, `#N:path` |

### Extension lifecycle (`extensions/main.ts` factory `(pi: ExtensionAPI) => void`; hooks registered in `hook.ts`)

1. `scaffoldSettings()` → `~/.omp/omp-vcc/config.json`
2. `pi.on("context")` strips invisible-continue custom messages (`AUTO_CONTINUE_CUSTOM_TYPE` `omp-vcc-auto-continue` + legacy `pi-vcc-auto-continue`)
3. `pi.on("before_agent_start")` clears pending auto-continue timer
4. `pi.on("session_before_compact")` — `parseCompactionInstructions` (accepts `__omp_vcc__`/`__pi_vcc__`) → `buildOwnCut` → `calibrate` → `compileRanked`; returns `{compaction:{summary, details}}` (details = `PiVccCompactionDetails` incl. `savings`, persisted on the session compaction entry) or `{cancel}`
5. `pi.on("session_compact")` — savings toast (before→after) + `triggerInvisibleContinue` (`setTimeout 0`; `display:false, triggerTurn:true, deliverAs:'followUp'`)
6. Registrations: `vcc_recall` tool via `pi.zod`, `/omp-vcc`+`/pi-vcc`, `/vcc-recall`+`/pi-vcc-recall` (main.ts); `vcc_stats` tool (approval `read`, `{history?: boolean}`) and `/vcc-stats`+`/omp-vcc-stats` (`registerVccStatsTool`/`registerVccStatsCommand`, hook.ts)

> See `docs/harness.md §5` for host pipeline bypass (how `session_before_compact` replaces `SessionMaintenance` LLM path) and `§8` for `methodOrder` coexistence when `overrideDefaultCompaction:false`.

Recall modalities: document-oriented temporal (default) vs index-oriented flat list (`mode:'touched'`). Savings state is per-pi (`perPi.statsHistory` via `getCompactionHistory(pi)`); `/omp-vcc --stats` and `vcc_stats`/`/vcc-stats` print last + history.
## Key Directories

```
extensions/
  main.ts                  — factory entry: scaffold, tool + command registrations, re-exports for tests
  vcc-core/
    hook.ts                — hooks + compaction + stats logic, vcc_stats tool/commands, per-pi state
    core/                  — vendored modules: brief, rank, format, summarize, token-estimate, normalize,
                             filter-noise, sanitize, content, lineage, load-messages, search-entries,
                             format-recall, drill-down, recall-scope, render-entries, report, tool-args,
                             skill-collapse, compact-args, settings, build-sections
    extract/               — commits.ts, files.ts, goals.ts, preferences.ts
    types.ts, details.ts, sections.ts
    commands/vcc-recall.ts — shim re-export for test compat
commands/                  — omp-vcc.md, vcc-recall.md (slash-command shims, discovery fallback)
skills/omp-vcc/SKILL.md    — VCC philosophy + usage
tests/                     — *.test.ts suites + support/ (load-session, real-sessions) + fixtures.ts, helpers.ts
scripts/                   — smoke.ts (host-free registration + pipeline smoke), uninstall-reset.js
docs/                      — architecture, configuration, harness, omp-compaction, omp-snapcompact, paper-notes, PUBLISHING, setup, verification
```

## Development Commands

```bash
bunx tsc --noEmit                    # typecheck (zero-build, vendored // @ts-nocheck, skipLibCheck)
bun test                             # full suite (bun:test)
bun test tests/brief.test.ts         # single suite
bun run smoke                        # host-free: registrations (incl. vcc_stats) + buildOwnCut + calibrate

# plugin lifecycle (requires oh-my-pi install)
omp plugin link /Users/zhu/code/projects/omp-vcc
omp plugin doctor                    # expect 0 warnings 0 errors

# functional manual check
omp -e @zhulinchng/omp-vcc
/omp-vcc keep:2 Test prompt          # expect [Session Goal] summary + toast omp-vcc: kept 2/5
/vcc-stats                           # expect last-compaction savings + history table
cat /tmp/omp-vcc-debug.json          # when debug:true — usedOwnCut, tokensBefore, sections, savings
```

No `lint`/`format` script — keep vendored files `// @ts-nocheck` untouched. `prepublishOnly` runs typecheck + test + smoke.

## Code Conventions

- **Modules & naming**: `type: module` ESM with `allowImportingTsExtensions` — import with `.ts` suffix (`from "./core/hook.ts"`). `kebab-case` files, `PascalCase` types, `camelCase` functions, `SCREAMING_SNAKE` constants.
- **Vendored code**: `extensions/vcc-core/**` is verbatim `pi-vcc` — keep `// @ts-nocheck`, never reformat or fix types there.
- **Host interop — never `await import()`**: import host types statically (`import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"`); ambient shims in `types.d.ts` alias `@earendil-works/*`/`@mariozechner/*` + `node:module` `createRequire` fallback. `convertToLlm` shim tries `session/messages` → `pi-coding-agent` export → identity, preserving `AgentMessage` for `compileRanked`.
- **Sentinels**: `__omp_vcc__` / `__pi_vcc__` (`OMP_VCC_COMPACT_INSTRUCTION` / `PI_VCC_COMPACT_INSTRUCTION`, `isVccSentinel`; arg parsing in `core/compact-args.ts`) — both accepted for pi-vcc backward compat.
- **Error handling — `buildOwnCut` never throws**: returns `{ok:true, messages, keptUserTurns, ...}` or `{ok:false, reason, ...}`. Handler cancels (`{cancel:true}`) on `no_live_messages`/`too_few_live_messages`, except overflow `willRetry` falls through to core. `keep:0` sentinel `firstKeptEntryId=""` triggers orphan recovery on next compaction.
- **Async & scheduling**: `session_before_compact` is `async (event, ctx) => SessionBeforeCompactResult | void`; invisible-continue is deferred via `setTimeout 0` to keep queue/busy-state coherent; `before_agent_start` clears the pending timer.
- **DI & state**: single `pi: ExtensionAPI` factory, no globals. Tests/smoke use `mockPi` (`on`/`registerTool`/`registerCommand`/`zod` chain) and `mockCtx` (`compact`/`notify`). Mutable per-pi state in `hook.ts` (`lastStats`, `lastCompactWasPiVcc`, `pendingFollowUpPrompt`, `pendingAutoContinueTimer`, `statsHistory`) lives in a `WeakMap` (`perPi`) with module-global fallback for host-free tests — access via `getLastCompactionStats()` / `getCompactionHistory(pi)` / `scheduleCompactionStatsNotify(ctx, stats)`; `clearPendingAutoContinueForPi` / `scheduleAutoContinueForPi` / `clearCompactionHistoryForTests` avoid cross-session pollution.
- **Settings — file over manifest with ctx overlay**: XDG priority `$OMP_VCC_CONFIG_PATH` > `$PI_VCC_CONFIG_PATH` > `$OMP_DIR`/`$PI_CODING_AGENT_DIR` > `~/.omp/omp-vcc/config.json`; one-time migration from `~/.pi/agent/pi-vcc-config.json`. `scaffoldSettings()` fills missing keys without clobbering. Manifest `omp.settings`/`pi.settings` (all booleans) are UI surface; `loadSettings(ctx)` overlays `ctx.settings.get`/`ctx.config.get` so `/settings` toggles apply without restart (file stays source of truth).

## Important Files

| Path | Purpose |
| --- | --- |
| `package.json` | Dual `omp`+`pi` manifests (`extensions: ["./extensions/main.ts"]`, command shims, settings), `files` list, `prepublishOnly` |
| `types.d.ts` | Ambient shims for `@oh-my-pi/*`, legacy aliases, `node:` modules — enables `tsc --noEmit` with no install |
| `tsconfig.json` | `ES2022`/`ESNext`/`bundler`, `skipLibCheck:true`, `strict:false`, `allowImportingTsExtensions:true` |
| `extensions/main.ts` | Factory — scaffold, tools, commands, test re-exports |
| `extensions/vcc-core/hook.ts` | All hook/compaction/stats logic |
| `extensions/vcc-core/core/settings.ts` | `PiVccSettings` + `DEFAULT_SETTINGS` + `loadSettings()`/`scaffoldSettings()` + XDG path |
| `extensions/vcc-core/details.ts` | `PiVccCompactionDetails` incl. `savings` persisted on the compaction entry |
| `docs/architecture.md` | Pipeline map + per-file paper anchors |
| `docs/harness.md` | Host impact: what plugin adds vs intercepts, lifecycle, token math, verification map |
| `docs/omp-compaction.md` | Compaction pipeline deep dive (calibrate → merge) + budget/preservation guarantees |
| `docs/omp-snapcompact.md` | Snapshot compaction reference (branchEntries, firstKeptEntryId, lineage) |
| `docs/setup.md` | Install, linking, and working with existing strategies |

## Runtime & Tooling

- **Bun** for test/runner (`bun test`, `bun run`); `node` will not resolve `.ts` imports. `bun.lock` committed, no npm/yarn lock; `dependencies:{}`, only dev dep `@types/bun` — host provides `@oh-my-pi/pi-coding-agent` at runtime.
- **TypeScript 5.x** via `tsc --noEmit` only — no `tsc -b`/bundler, zero build artifacts, no `dist/` (`files` ships source).
- **OS darwin arm64**; XDG respects `~/.omp` default.

## Testing & QA

- **Framework**: `bun:test` (+ `node:test` compat via `types.d.ts` shims); no vitest/jest; vendored tests keep `// @ts-nocheck`. Suites live in `tests/*.test.ts`, ported from `pi-vcc@0.7.0`.
- **Fixtures**: `tests/fixtures.ts` (`userMsg`, `assistantText`, `toolResult`), `tests/helpers.ts` (`makeMockApi`/`makeMockCtx`); `tests/support/` loads real sessions with synthetic 100-turn fallback (`prepareSessionSamples` remains a CI stub).
- **CI gate**: `bunx tsc --noEmit && bun test && bun run smoke && omp plugin doctor`
- **Coverage expectation**: deterministic assertions per fixture; no snapshot tests. New compaction logic must add boundary cases: empty branch, orphan `firstKeptEntryId`, `keep:0` sentinel, `reset_boundary` /clear supersession, `toolResult` snap, explicit `keep:N` not boosted, `scope:all` vs lineage, regex-no-hit → keyword fallback, ENOENT graceful, `willRetry`/`overflow` fallback, cross-session per-pi isolation, stats-history gaps (`compaction-stats-gaps`, `review-gaps`).
