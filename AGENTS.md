# Repository Guidelines

## Project Overview

`@zhu/omp-vcc` — VCC-inspired algorithmic compaction plugin for `oh-my-pi` (`omp`). Zero-LLM, deterministic (30–470 ms), ports `sting8k/pi-vcc@0.7.0` into `oh-my-pi` extensions. Implements VCC views from `arxiv:2603.29678`: `V_full` identity, `V_ui` one-line brief transcript, `V_adapt(b,ρ)` ranked recall.

Provides: automatic `threshold`/`overflow` compaction via `session_before_compact` hook, manual `/omp-vcc [keep:N] [focus]` command, `vcc_recall` tool + `/vcc-recall` command. Intercepts all compactions when `overrideDefaultCompaction:true` (default); native `/settings` dropdown requires optional one-file core patch (see `docs/configuration.md#native-strategy`).

## Architecture & Data Flow

### Compiler pipeline (VCC §2.2–2.3 → omp-vcc)

```
Calibrate (token-estimate) → SmartKeep → BuildOwnCut → Normalize (IR) → FilterNoise → BuildSections → Brief (V_ui) → Format → Merge
                                           └─→ Recall ranking (V_adapt)
```

Single line assignment before lowering guarantees pointer invariant `V_ui → V_full[s:e]` via stable `(#N)` refs / `firstKeptEntryId` lineage. All cleaning preserves `turn/header/block` delimiters and role tags.

| Stage | Module | Key symbol |
|---|---|---|
| Calibrate `charsPerToken` | `extensions/vcc-core/core/token-estimate.ts` | `calibrateCharsPerToken(totalChars/tokensBefore)` clamp 2–6, fallback 4 |
| Smart keep | `hook.ts` | `resolveSmartKeepUserTurns` MIN 5k → MAX 25k, respects explicit `keep:N` |
| Build cut | `hook.ts` | `buildOwnCut(branchEntries, keep:N)` — live via `firstKeptEntryId` + orphan `""` recovery, `compactAll` sentinel |
| Budget rescue | `hook.ts` | `applyTailBudget`, `findBudgetCutIndex` ×2.5, snap off `toolResult` boundary |
| Normalize (lex→parse IR) | `core/normalize.ts`, `sanitize.ts`, `content.ts`, `load-messages.ts` | ANSI strip, `queue-operation` discard, `digits→` strip, `Escape JSON→| block` |
| Filter noise | `core/filter-noise.ts` | harness `<system-reminder>` etc removed |
| Build sections | `core/build-sections.ts` + `extract/*` | 5 sections: Goal, Files, Commits, Preferences, Outstanding |
| Brief `V_ui` | `core/brief.ts`, `rank.ts`, `summarize.ts` | `RANKED_BRIEF_BUDGET_TOKENS=1100` ceil 2000, `BRIEF_MAX_LINES 120`, `compileRanked` |
| Recall `V_adapt` | `core/search-entries.ts`, `format-recall.ts`, `drill-down.ts` | `searchEntriesDetailed` regex→OR TF-IDF, `SEP`, `#N:path` |

### Extension lifecycle (`extensions/main.ts` factory `(pi: ExtensionAPI) => void`)

1. `scaffoldSettings()` → `~/.omp/omp-vcc/config.json`
2. `pi.on("context")` strips invisible-continue marker (`omp-vcc-auto-continue` + legacy `pi-vcc-auto-continue`)
3. `pi.on("before_agent_start")` clears pending auto-continue
4. `pi.on("session_before_compact")` — `parseCompactionInstructions` (accepts `__omp_vcc__` + `__pi_vcc__`), `buildOwnCut` → `calibrate` → `compileRanked` → returns `{compaction: {summary, details}}` or `{cancel}`
5. `pi.on("session_compact")` — `formatCompactionStats` toast + `triggerInvisibleContinue` (`display:false, triggerTurn:true, deliverAs:'followUp'`)
6. `pi.registerTool("vcc_recall")` via `pi.zod`, `pi.registerCommand("omp-vcc"/"pi-vcc")`, `pi.registerCommand("vcc-recall"/"pi-vcc-recall")`

Recall modalities: document-oriented (temporal, default) vs index-oriented flat list (`mode:'touched'`).

## Key Directories

```
extensions/
  main.ts                  — factory entry, tool + command registration, re-exports for tests
  vcc-core/
    hook.ts                — session_before_compact handler (936 lines), stats, invisible-continue
    core/                  — 21 vendored modules (brief, rank, format, summarize, token-estimate, normalize, filter-noise, sanitize, content, lineage, load-messages, search-entries, format-recall, drill-down, recall-scope, settings, etc)
    extract/               — commits.ts, files.ts, goals.ts, preferences.ts
    types.ts, details.ts, sections.ts
    commands/vcc-recall.ts — shim re-export for test compat
commands/
  omp-vcc.md, vcc-recall.md — slash-command shims (discovery fallback)
skills/omp-vcc/
  SKILL.md                 — VCC philosophy + usage
tests/
  *.test.ts (32 files) + support/ (load-session, real-sessions stubs) + fixtures.ts, helpers.ts
scripts/
  smoke.ts                 — host-free hook+tool+command smoke
  uninstall-reset.js       — cleanup
docs/
  README.md, architecture.md, configuration.md, verification.md, paper-notes.md
```

## Development Commands

```bash
# typecheck (zero-build, vendored // @ts-nocheck, skipLibCheck)
bunx tsc --noEmit

# tests — 295 tests across 32 files (bun:test, no vitest/jest)
bun test
bun test tests/brief.test.ts          # single suite
bun test tests/before-compact-hook.test.ts

# smoke — verifies hook/tool/command registration + buildOwnCut + calibrate
bun run smoke        # alias: bun run scripts/smoke.ts

# plugin lifecycle (requires oh-my-pi install)
omp plugin link /Users/zhu/code/projects/omp-vcc
omp plugin list --json | jq '.[] | select(.name | contains("omp-vcc"))'
omp plugin doctor    # expect 5 ok 0 warnings 0 errors

# functional manual check
omp -e @zhu/omp-vcc
/omp-vcc keep:2 Test prompt    # expect [Session Goal] summary + toast omp-vcc: kept 2/5

# debug snapshot
cat /tmp/omp-vcc-debug.json   # when debug:true — usedOwnCut, tokensBefore, sections
```

No `lint`/`format` script — keep vendored files `// @ts-nocheck` untouched. `prepublishOnly` runs `typecheck`.

## Code Conventions & Common Patterns

**Formatting & naming**
- `type: module` ESM, `allowImportingTsExtensions: true` — import with `.ts` suffix (`from "./core/hook.ts"`).
- Vendored `extensions/vcc-core/**` is verbatim `pi-vcc` — keep `// @ts-nocheck`, do not reformat or fix types there.
- Plugin code: `kebab-case` files, `PascalCase` types, `camelCase` functions, `SCREAMING_SNAKE` constants (`OMP_VCC_COMPACT_INSTRUCTION`, `RANKED_BRIEF_BUDGET_TOKENS`, `OVERSIZED_TAIL_FACTOR`).

**Host interop — never `await import()`**
- Import host types statically: `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"`; runtime shims in `types.d.ts` alias `@earendil-works/*` and `@mariozechner/*` plus `node:module` `createRequire` fallback.
- `convertToLlm` shim tries `session/messages` then `pi-coding-agent` export, falls back to identity — preserves `AgentMessage` for `compileRanked`.

**Compaction sentinels (backward compat)**
```ts
const PI_VCC_COMPACT_INSTRUCTION  = "__pi_vcc__";
const OMP_VCC_COMPACT_INSTRUCTION = "__omp_vcc__";
const isVccSentinel = (s) => s === PI_VCC_COMPACT_INSTRUCTION || s === OMP_VCC_COMPACT_INSTRUCTION;
```

**Error handling — `buildOwnCut` never throws**
- Returns `{ok:true, messages, keptUserTurns, ...}` or `{ok:false, reason, ...}`. Handler cancels (`{cancel:true}`) on `no_live_messages`/`too_few_live_messages`, except overflow `willRetry` falls through to core. Keep `keep:0` sentinel `firstKeptEntryId=""` triggers orphan recovery on next compaction.

**Async & scheduling**
- `session_before_compact` is `async (event, ctx) => SessionBeforeCompactResult | void`; `session_compact` uses `setTimeout 0` for invisible-continue to keep queue/busy-state coherent. `before_agent_start` clears pending timer.

**Dependency injection & state**
- Extension receives single `pi: ExtensionAPI` (factory pattern, no global). Tests/smoke use `mockPi` with `on`/`registerTool`/`registerCommand`/`zod` chain mock and `mockCtx` with `compact`/`notify`. Shared mutable state in `hook.ts`: `lastStats`, `lastCompactWasPiVcc`, `pendingFollowUpPrompt`, `pendingAutoContinueTimer` — access via `getLastCompactionStats()` / `scheduleCompactionStatsNotify()`.

**Settings — file over manifest**
- XDG priority: `$OMP_VCC_CONFIG_PATH` > `$PI_VCC_CONFIG_PATH` > `$OMP_DIR`/`$PI_CODING_AGENT_DIR` > `~/.omp/omp-vcc/config.json`; migrates `~/.pi/agent/pi-vcc-config.json` once. `scaffoldSettings()` fills missing keys without clobbering. Manifest `omp.settings`/`pi.settings` (dual, 5 booleans) is UI surface only.

## Important Files

| Path | Purpose |
|---|---|
| `package.json` | Dual `omp`+`pi` manifests (`extensions: ["./extensions/main.ts"]`, `commands`, 5 `settings`), `type:module`, `files` list, `prepublishOnly` |
| `types.d.ts` | Ambient shims for `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-ai`, legacy aliases, `node:` modules — enables `tsc --noEmit` with no install |
| `tsconfig.json` | `ES2022`/`ESNext`/`bundler`, `skipLibCheck:true`, `strict:false`, `allowImportingTsExtensions:true` |
| `extensions/main.ts` | Factory — scaffold, hook, tool, 4 commands, re-exports (`PI_VCC_COMPACT_INSTRUCTION`, `formatCompactionStats`, etc) |
| `extensions/vcc-core/hook.ts` | All compaction logic — 936 lines, `registerBeforeCompactHook`, `buildOwnCut`, `resolveSmartKeepUserTurns`, `applyTailBudget`, `compileRanked`, `triggerInvisibleContinue` |
| `extensions/vcc-core/core/settings.ts` | `PiVccSettings` interface + `DEFAULT_SETTINGS` + `loadSettings()`/`scaffoldSettings()` + XDG path |
| `extensions/vcc-core/core/token-estimate.ts` | `calibrateCharsPerToken`, `estimateMessageContentTokens` |
| `commands/omp-vcc.md`, `commands/vcc-recall.md` | Slash-command markdown shims (`$ARGUMENTS`) |
| `skills/omp-vcc/SKILL.md` | Skill definition |
| `docs/architecture.md` | Pipeline map + per-file paper anchors |
| `docs/configuration.md` | File vs manifest settings + native patch diff |
| `docs/paper-notes.md` | `arxiv:2603.29678` distillation |

## Runtime/Tooling Preferences

- **Runtime: Bun** — `bun test` and `bun run` required; `node` will not resolve `.ts` imports with `allowImportingTsExtensions`. Node shims only for `createRequire` fallback.
- **Package manager: bun** (`bun.lock` committed). Install: `bun install`. No `npm`/`yarn` lock.
- **TypeScript** `5.x` via `tsc --noEmit` only — no `tsc -b` or bundler. Zero build artifacts; `dist/` not used (`files` not `dist`).
- **No deps** — `dependencies:{}`; only `dev: @types/bun`. Host provides `@oh-my-pi/pi-coding-agent` at runtime.
- **OS: darwin arm64**, shell `ghostty` — paths are POSIX; XDG respects `~/.omp` default.

## Testing & QA

- **Framework:** `bun:test` primary + `node:test` compat via `types.d.ts` shims. No `vitest`/`jest` config. Vendored tests use `// @ts-nocheck` to silence cross-host type mismatches.
- **Suites:** 32 files, 295 tests, 728 `expect()` — ported from `pi-vcc@0.7.0` (28 required). Covers `buildOwnCut` (keep:0/1/N, orphan `""`, `too_few`), budget `no_anchor`/`oversized_tail`×2.5, `smartKeep` boost 5k→25k, `sanitize`/`normalize`/`rank` TF-IDF, `search-entries` regex→OR, `lineage`, `load-messages`, `recall` `expand`/`touched`/`scope:all`.
- **Fixtures:** `tests/fixtures.ts` (`userMsg`, `assistantText`, `toolResult`), `tests/helpers.ts` (`makeMockApi`/`makeMockCtx`), `tests/support/real-sessions.ts` + `load-session.ts` stubs (empty when no `~/.pi/sessions`).
- **Run:**
  ```bash
  bun test                              # all
  bun test tests/before-compact.test.ts  # one file
  bun run smoke                         # host-free: extension registers, buildOwnCut ok, calibrate
  bunx tsc --noEmit && bun test && bun run smoke && omp plugin doctor  # CI gate
  ```
- **Benchmark harness:** `scripts/benchmark-real-sessions.ts` (port of pi-vcc bench, not CI) — measures 35–99% token reduction. Real sessions in `tests/support/real-sessions.ts` are opt-in (stubbed in CI).
- **Coverage expectation:** deterministic output assertions per fixture; no snapshot tests. New compaction logic must add boundary cases: empty branch, orphan `firstKeptEntryId`, `keep:0` sentinel, `toolResult` snap, explicit `keep:N` not boosted, `scope:all` vs lineage, regex-no-hit → keyword fallback.
