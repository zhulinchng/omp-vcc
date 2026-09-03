# Repository Guidelines

## Project Overview

Provides: auto `threshold`/`overflow` via `session_before_compact` (when `overrideDefaultCompaction:true`, default), manual `/omp-vcc [keep:N] [focus]` (compacts and shows savings), tools `vcc_recall` + `vcc_stats`, commands `/vcc-recall` + `/vcc-stats` + `/vcc-config` (effective config with per-key source). Native `/settings` dropdown needs optional one-file core patch (`docs/configuration.md#native-strategy`).

## Architecture & Data Flow

```
Calibrate → SmartKeep → BuildOwnCut → Normalize → FilterNoise → BuildSections → Brief (V_ui) → Merge
                                          └─→ Recall (V_adapt)
```

Monotonic line assignment before lowering guarantees `V_ui → V_full[s:e]` via `(#N)` refs / `firstKeptEntryId`. Cleaning preserves `turn/header/block` delimiters.

| Stage | Module | Key symbol |
|---|---|---|
| Calibrate | `core/token-estimate.ts` | `calibrateCharsPerToken` clamp 2–6, fallback 4 |
| SmartKeep | `hook.ts` | `resolveSmartKeepUserTurns` 5k→25k, explicit `keep:N` not boosted |
| Build cut | `hook.ts` | `buildOwnCut` via `firstKeptEntryId` + orphan `""`, `compactAll` |
| Budget rescue | `hook.ts` | `applyTailBudget`, `findBudgetCutIndex` ×2.5, snap off `toolResult` |
| Normalize | `core/normalize.ts`, `sanitize.ts`, `content.ts` | ANSI strip, `queue-operation` discard, `Escape JSON` → marker |
| Filter | `core/filter-noise.ts` | harness `<system-reminder>` removed |
| Sections | `core/build-sections.ts` + `extract/*` | 5 sections: Goal, Files, Commits, Preferences, Outstanding |
| Brief `V_ui` | `core/brief.ts`, `rank.ts`, `summarize.ts` | `RANKED_BRIEF_BUDGET_TOKENS 1100` ceil 2000, `BRIEF_MAX_LINES 120` |
| Recall `V_adapt` | `core/search-entries.ts`, `format-recall.ts`, `drill-down.ts` | `searchEntriesDetailed` regex→OR TF-IDF, `#N:path` |

Lifecycle (`extensions/main.ts` factory `(pi: ExtensionAPI) => void`, hooks in `hook.ts`):

1. `scaffoldSettings()` → `~/.omp/omp-vcc/config.json`
2. `pi.on("context")` — strip invisible-continue (`omp-vcc-auto-continue`)
3. `pi.on("before_agent_start")` — clear pending auto-continue timer
4. `pi.on("session_before_compact")` — explicit-mode bypass (`snapcompact|shake|soft|remote|handoff` void even if `override:true` unless `__omp_vcc__` sentinel) → `buildOwnCut` → `calibrate` → `compileRanked` → `{compaction:{summary, details}}` or `{cancel}`
5. `pi.on("session_compact")` — toast + invisible-continue (`setTimeout 0`) + eager `chainShakeHint` (`ctx.compact({mode:"shake"})` guarded by `WeakSet`, only when `fromExtension && !willRetry && !isPiVccLast`)
6. Registrations: `vcc_recall` (`pi.zod`), `/omp-vcc`+`/pi-vcc` (compact + inline stats), `/vcc-recall`+`/pi-vcc-recall` (main.ts); `vcc_stats` + `/vcc-stats` (single, no alias) + `/vcc-config` (single, no alias) (hook.ts)

See `docs/harness.md §5` (bypass), `§8` (methodOrder coexistence), `docs/setup.md` (combining VCC+shake/snapcompact).

## Key Directories

```
extensions/
  main.ts               — factory: scaffold, tools, commands, test re-exports
  vcc-core/
    hook.ts             — hooks + compaction + stats + per-pi state
    core/               — vendored: brief, rank, format, token-estimate, normalize, filter-noise, sanitize, content, lineage, search-entries, etc.
    extract/            — commits, files, goals, preferences
    types.ts, details.ts, sections.ts
    commands/vcc-recall.ts — shim
commands/               — omp-vcc.md, vcc-recall.md (discovery fallback)
skills/omp-vcc/SKILL.md — VCC workflow
tests/                  — *.test.ts + support/ + fixtures.ts, helpers.ts
scripts/                — smoke.ts, uninstall-reset.js
docs/                   — architecture, configuration, harness, omp-compaction, omp-snapcompact, setup, verification, testing
```

## Development Commands

```bash
bunx tsc --noEmit                    # zero-build, vendored // @ts-nocheck, skipLibCheck
bun test                             # 619 tests, 55 files, 1876 expects
bun test tests/brief.test.ts         # single suite
bun run smoke                        # 13 checks: 3 hooks + 6 cmds + 2 tools + dedup (+ pipeline)

omp plugin link /Users/zhu/code/projects/omp-vcc
omp plugin doctor                    # 0 warnings 0 errors
omp -e @zhulinchng/omp-vcc
/omp-vcc keep:2 Test prompt          # expect [Session Goal] + toast omp-vcc: kept 2/5
/vcc-stats
/vcc-config       # effective config card with per-key source
cat /tmp/omp-vcc-debug.json          # when debug:true
```

No `lint`/`format`. `prepublishOnly` runs `tsc && test && smoke`. Keep vendored `// @ts-nocheck` untouched.

## Code Conventions

- **Modules**: `type:module` ESM, `allowImportingTsExtensions` — import with `.ts` suffix. `kebab-case` files, `PascalCase` types, `camelCase` fns, `SCREAMING_SNAKE` consts.
- **Vendored**: `extensions/vcc-core/**` verbatim `pi-vcc` — never reformat.
- **Host interop**: never `await import()`. `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"`, shims in `types.d.ts` alias `@earendil-works/*` etc. `convertToLlm` tries `session/messages` → export → identity.
- **Sentinels**: `__omp_vcc__`/`__pi_vcc__` (`isVccSentinel`, `core/compact-args.ts`).
- **Error handling**: `buildOwnCut` never throws — `{ok:true,...}` or `{ok:false,reason}`. Handler cancels on `no_live_messages`/`too_few_live_messages` except `overflow+willRetry` falls through. `keep:0` → `firstKeptEntryId=""` orphan recovery.
- **Async**: `session_before_compact` is `async (event, ctx) => SessionBeforeCompactResult | void`. Invisible-continue via `setTimeout 0`; `before_agent_start` clears timer.
- **State**: single `pi` factory, no globals. Tests use `mockPi`/`mockCtx`. Per-pi state via `WeakMap` (`perPi`) + `perPiKeys` + `pendingChainShake WeakSet` in `hook.ts`; accessors `getLastCompactionStats()` / `getCompactionHistory(pi)` / `clearCompactionHistoryForTests()` / `clearPendingAutoContinueForPi`.
- **Settings**: file over manifest with `ctx` overlay. XDG: `$OMP_VCC_CONFIG_PATH` > `$PI_VCC_CONFIG_PATH` > `$OMP_DIR`/`$PI_CODING_AGENT_DIR` > `~/.omp/omp-vcc/config.json`; migrates `~/.pi/agent/pi-vcc-config.json` once. `scaffoldSettings()` fills missing without clobber. Manifest `omp.settings`/`pi.settings` (6 booleans) are UI; `loadSettings(ctx)` overlays `ctx.settings.get`.

## Important Files

| Path | Purpose |
|---|---|
| `package.json` | Dual `omp`+`pi` manifests, `files`, `prepublishOnly` |
| `types.d.ts` | Ambient shims for `@oh-my-pi/*` |
| `tsconfig.json` | `ES2022`/`ESNext`/`bundler`, `skipLibCheck:true`, `allowImportingTsExtensions:true` |
| `extensions/main.ts` | Factory |
| `extensions/vcc-core/hook.ts` | All hook/compaction/stats logic |
| `extensions/vcc-core/core/settings.ts` | `PiVccSettings` + `DEFAULT_SETTINGS` (6 keys) + `loadSettings`/`scaffoldSettings` + `loadSettingsWithSources`/`getSettingsPath` (per-key source for `/vcc-config`) |
| `extensions/vcc-core/details.ts` | `PiVccCompactionDetails` + `savings` |
| `docs/architecture.md` | Pipeline map |
| `docs/harness.md` | Host impact, lifecycle, verification map |
| `docs/omp-compaction.md` | Pipeline deep dive + guarantees |
| `docs/omp-snapcompact.md` | Snapshot compaction reference |
| `docs/setup.md` | Install + combining strategies |

## Runtime & Tooling

- **Bun** for `test`/`run`; `node` won't resolve `.ts` imports. `bun.lock` committed, `dependencies:{}`, dev dep only `@types/bun`.
- **TypeScript 5.x** via `tsc --noEmit` only, no `dist/`, `files` ships source.
- **OS** darwin arm64, XDG respects `~/.omp`.

## Testing & QA

- **Framework**: `bun:test` (+ `node:test` compat). Suites in `tests/*.test.ts`, ported from `pi-vcc@0.7.0`.
- **Fixtures**: `tests/fixtures.ts` (`userMsg`, `assistantText`, `toolResult`), `helpers.ts` (`makeMockApi`/`makeMockCtx`); `support/` loads real sessions with synthetic 100-turn fallback.
- **CI gate**: `bunx tsc --noEmit && bun test && bun run smoke && omp plugin doctor`
- **Coverage**: deterministic, no snapshots. New logic must add boundary cases: empty branch, orphan `""`, `keep:0`, `reset_boundary`, `toolResult` snap, explicit `keep:N` not boosted, `scope:all` vs lineage, regex→keyword fallback, ENOENT, `willRetry`/`overflow`, per-pi isolation, stats gaps, combined VCC+shake/snapcompact (explicit bypass, sequential, `chainShakeHint` guard), `/vcc-config` card (missing/invalid/fallback/overlay sources, args ignored, never throws).
