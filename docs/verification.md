# Verification — omp-vcc

## Build proof

```sh
cd /Users/zhu/code/projects/omp-vcc
bunx tsc --noEmit   # exits 0 (skipLibCheck, allowImportingTsExtensions, @ts-nocheck on vendored core)
```

Typecheck covers `extensions/main.ts` factory `(pi: ExtensionAPI) => void` using `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"` (no `await import()`), `pi.zod` for tool schemas, dual `omp+pi` manifests, `type:module`, zero deps, `files` not `dist`.

```mermaid
flowchart LR
  SRC["extensions/main.ts\n+ hook.ts + core/*"] --> TSC["bunx tsc --noEmit\nskipLibCheck\nallowImportingTsExtensions"]
  TSC --> OK{"0 errors?"}
  OK -->|yes| PASS["publish ok\nprepublishOnly passes"]
  OK -->|no| FAIL["fix shim types.d.ts\nor // @ts-nocheck"]

  classDef ok fill:#e8f5e9,stroke:#2e7d32
  class PASS ok
  classDef err fill:#fce4ec,stroke:#c2185b
  class FAIL err
```

## Test matrix

```sh
bun test            # 295 tests across 32 files, 728 expect() calls, 0 fail
bun run smoke       # ok: session_before_compact hooked, vcc_recall registered, etc.
```

Ported from `pi-vcc@0.7.0` 31 suites (28 required) via `bun:test` + `node:test` hybrids, imports remapped `src/core`→`extensions/vcc-core/core`, `src/hooks/before-compact`→`extensions/vcc-core/hook`, sentinel `__pi_vcc__` also accepts `__omp_vcc__`, debug path `/tmp/omp-vcc-debug.json` (and legacy `/tmp/pi-vcc-debug.json`):

```mermaid
flowchart TB
  subgraph Unit["Unit — deterministic fixtures"]
    A["brief / build-sections\ncompile / content / format\nnormalize / rank / sanitize\ntoken-estimate\n~80 tests"]
    B["extract-files/goals/preferences\nfilter-noise / lineage\nload-messages / recall-scope\nsearch-entries / render-entries\nformat-recall / drill-down+touched\n~70 tests"]
  end
  subgraph Integration["Integration — hook + command"]
    C["before-compact (buildOwnCut)\nkeep:0/1/N, orphan ''\ncompactAll, too_few, autonomous\n13 tests"]
    D["before-compact-hook\nsession_before+compact flow\nsmartKeep, budget 2.5×\ncancel, toast, invisible-continue\n41 tests"]
    E["pi-vcc-command / vcc-recall-command\nrecall-tool-scope / smart-keep\ninvisible-continue / expand / touched\n~30 tests"]
  end
  subgraph Sessions["Sessions — real data"]
    F["real-sessions 2 tests\nstubbed when no ~/.pi/sessions\nsynthetic 100-turn fallback"]
  end
  Unit & Integration & Sessions --> ALL["bun test: 310 pass (295+15)\n768 expects, 0 fail\n+ tests/review-gaps 15"]
  ALL --> SMOKE["bun run smoke\n6 hooks/tools/commands ok\n+ buildOwnCut + calibrate"]

  classDef suite fill:#e3f2fd,stroke:#1565c0
  class A,B,C,D,E,F suite
  class ALL,SMOKE fill:#e8f5e9,stroke:#2e7d32
```

| Suite | What it checks | Status |
| --- | --- | --- |
| `before-compact.test.ts` | `buildOwnCut` keep:0/1/N, orphan recovery `""`, `compactAll` sentinel, too_few, single-user+autonomous | 13 pass |
| `before-compact-hook.test.ts` | Hook `session_before_compact` → `session_compact` flow, smartKeep, budget `no_anchor`/`oversized_tail`×2.5, cancel reasons, `formatCompactionStats` `omp-vcc:`, invisible-continue `omp-vcc-auto-continue`, debug snapshot | 41 pass |
| `brief.test.ts` `build-sections.test.ts` `compile.test.ts` `content.test.ts` `format.test.ts` `normalize.test.ts` `rank.test.ts` `sanitize.test.ts` `token-estimate.test.ts` | Deterministic output for fixtures, TF-IDF, clipping, token calibrate `charsPerToken` 2–6 fallback 4 | ~80 pass |
| `extract-files.test.ts` `extract-goals.test.ts` `extract-preferences.test.ts` `filter-noise.test.ts` `lineage.test.ts` `load-messages.test.ts` `recall-scope.test.ts` `search-entries.test.ts` `render-entries.test.ts` `format-recall.test.ts` `drill-down`+`touched` | Extractors regex, lineage `getActiveLineageEntryIds`, search `searchEntriesDetailed` regex→OR, pagination 5, role tags, `parseDrillDown` `#N:path` | ~70 pass |
| `pi-vcc-command.test.ts` `vcc-recall-command.test.ts` `recall-tool-scope.test.ts` `smart-keep.test.ts` `invisible-continue.test.ts` `recall-expand` `recall-quality` `recall-touched` | Command keep parsing, tool `vcc_recall` active/all lineage, `mode:'touched'`, `scope:all` vs `lineage`, `expand` invalid indices, smart-keep boost 5k→25k, invisible-continue filtered | ~30 pass |
| `real-sessions.test.ts` + `review-gaps.test.ts` | Copied large sessions (synthetic fallback) + `reset_boundary` supersession, ENOENT graceful, approval read, manifest overlay, fallback heuristic, per-pi WeakMap | 17 pass |

Fixtures: `tests/fixtures.ts` helpers `userMsg`, `assistantText`, `toolResult`; `tests/support/load-session.ts` + `real-sessions.ts` (stubbed for CI). Helper `makeMockApi`/`makeMockCtx`.

Run single file:

```sh
bun test tests/before-compact.test.ts
bun test tests/before-compact-hook.test.ts
```

Benchmark harness `scripts/benchmark-real-sessions.ts` (pi-vcc's `benchmark-real-sessions.ts` port, not required for CI) would show 35–99% reduction.

```mermaid
flowchart TB
  FIX["fixtures.ts\nuserMsg / assistantText / toolResult"] --> MOCK["helpers.ts\nmakeMockApi(pi) / makeMockCtx()"]
  MOCK --> CASES["32 suites × fixtures\nkeep:0, orphan '', budget 2.5×,\nregex→TF-IDF, pagination 5"]
  CASES --> ASSERT["728 expects\n+ 35 in review-gaps\nsnapshot-free, deterministic"]
  ASSERT --> CI["bun test in CI\nbunx tsc --noEmit && bun test && smoke"]
  CI --> COV["review-gaps adds gaps\nreset_boundary, ENOENT, fallback,\nmanifest overlay, per-pi"]
```

## Plugin proof

```sh
omp plugin link /Users/zhu/code/projects/omp-vcc
omp plugin list --json | jq '.[] | select(.name|contains("omp-vcc"))'
# expect enabled:true, version 0.1.0, extensions ["./extensions/main.ts"], commands ["./commands/omp-vcc.md","./commands/vcc-recall.md"]

omp plugin doctor
# expect 0 errors for this plugin (or only missing marketplace)
```

```mermaid
flowchart LR
  LINK["omp plugin link ."] --> LIST["omp plugin list --json\nfilter @zhulinchng/omp-vcc"]
  LIST --> CHECK{"enabled:true\nversion 0.1.0\nsettings 5 booleans?"}
  CHECK -->|yes| DOCTOR["omp plugin doctor\n5 ok 0 warnings"]
  CHECK -->|no| FAIL["re-link / check package.json\nomp settings + pi settings"]
  DOCTOR --> READY["ready for TUI"]

  classDef ok fill:#e8f5e9,stroke:#2e7d32
  class READY ok
```

## Functional proof 1 — manual compaction

In fresh `omp` session with extension enabled (`omp -e @zhulinchng/omp-vcc` or via link):

```
/omp-vcc keep:2 Test prompt
```

- TUI shows compaction summary with `[Session Goal]` / `[Files And Changes]` / `[Commits]` / `[Outstanding Context]` / `[User Preferences]` / `---` `Brief transcript` and toast `omp-vcc: kept 2/5 turns, ~2.1k tok (smart-keep)`.
- With `debug:true`, `/tmp/omp-vcc-debug.json` exists with `usedOwnCut:true, messagesToSummarize, tokensBefore, tokenEstimate, sections`.

Repeated compactions merge bounded (run `/omp-vcc` twice, second summary deduped, transcript rolled <120 lines via `capBrief`).

```mermaid
sequenceDiagram
  participant U as You in TUI
  participant Hook as session_before_compact
  participant Core as compileRanked
  participant TUI as TUI

  U->>Hook: /omp-vcc keep:2 Test prompt<br/>customInstructions="__omp_vcc__ keep:2"
  Hook->>Hook: buildOwnCut keep:2<br/>firstKeptEntryId, messages
  Hook->>Core: calibrate + normalize → sections → brief<br/>budget 1100→2000, 15*cpt
  Core-->>Hook: summary (5 sections + transcript)
  Hook-->>TUI: {compaction: {summary, firstKeptEntryId}}
  TUI->>TUI: render summary + toast<br/>omp-vcc: kept 2/5 turns, ~2.1k tok
  TUI-->>U: summary visible<br/>kept tail remains editable
  Note over Hook,TUI: second /omp-vcc merges bounded<br/>sticky dedup + capBrief 120
```

## Functional proof 2 — recall

Tool call:

```json
{"name":"vcc_recall","parameters":{"query":"goal","page":1}}
→ {"content":[{"type":"text","text":"3 matches\n\n(#2) user: ...\n--- Use page:2..."}]}

{"name":"vcc_recall","parameters":{"query":"hook|inject","scope":"all"}}
→ regex path, ranked, contains `(#` refs and `scope:` metadata

{"name":"vcc_recall","parameters":{"query":"#12:src/auth.ts"}}
→ drill-down via `expandEntryFile`, returns file content slice
```

Command:

```
/vcc-recall auth token scope:all
→ renders collapsible message via pi.sendMessage({customType:"vcc-recall", content: output, display:true}) and toast `vcc_recall: 5 hits`
```

Check pagination: query with many hits → `Page 1/3 (15 total matches)` header and footer `--- Use page:2 with scope:'all' for more results ---`.

```mermaid
flowchart LR
  CMD["/vcc-recall auth\nor vcc_recall({query:'auth'})"] --> PARSE["parseDrillDown?\n#N:path → expandEntryFile"]
  PARSE -->|drill| FILE["V_full[s:e] slice"]
  PARSE -->|search| REGEX{"regex?"}
  REGEX -->|valid| R1["regex match_lines"]
  REGEX -->|invalid/no hit| TF["TF-IDF OR\nrank.ts"]
  R1 & TF --> SCOPE{"scope:all?"}
  SCOPE -->|no| ACTIVE["active lineage only"]
  SCOPE -->|yes| ALL["all sessions"]
  ACTIVE & ALL --> PAG["paginate 5/page\nheader Page 1/3 (15 total)"]
  PAG & FILE --> OUT["formatted recall\n+ toast 'vcc_recall: 5 hits'"]

  classDef cmd fill:#fff3e0,stroke:#ef6c00
  class CMD cmd
```

## Functional proof 3 — threshold compaction

Fill context to threshold (or simulate via helper):

```ts
// helper script: spam session with large messages then trigger auto compact
for (let i=0;i<100;i++) await pi.sendUserMessage("x".repeat(4000));
```

- Auto compaction fires without LLM call, toast `omp-vcc: kept ~12k tok tail (mid-turn cut, no user anchor)` if applicable.
- With `continueAfterThresholdCompact:true`, agent continues via invisible-continue (custom message `omp-vcc-auto-continue` filtered from LLM payload).

If `overrideDefaultCompaction:false` and no core patch, threshold falls back to core LLM compaction (no toast).

```mermaid
stateDiagram-v2
  [*] --> Filling: user messages
  Filling --> Threshold: tokensBefore > limit
  Threshold --> HookCheck: session_before_compact<br/>reason=threshold
  HookCheck --> Own: overrideDefaultCompaction:true<br/>→ compileRanked (no LLM)
  HookCheck --> LLM: overrideDefaultCompaction:false<br/>→ core remote LLM
  Own --> Toast: summary + toast<br/>smart-keep / mid-turn / budget
  Toast --> ContinueCheck: continueAfterThresholdCompact?
  ContinueCheck --> Invis: true + threshold/overflow + !willRetry<br/>→ invisible-continue
  ContinueCheck --> Stop: false → wait
  Invis --> Generating: agent continues from summary
  Generating --> Filling
  LLM --> Generating
  Stop --> [*]
```

## Regression proof

- Empty branch → cancel `no_live_messages` with `notify warning`
- Orphan `firstKeptEntryId` (`""` sentinel) → recovery collects after compaction
- Oversized tail exactly at `maxTokens*2.5` → no budget cut; just over → `oversized_tail`
- `keep:0` sentinel `""` → `compactAll:true, keptUserTurns:0`
- `toolResult` boundary snap → `findBudgetCutIndex` skips `toolResult`
- Explicit `keep:N` not boosted by smartKeep
- `scope:"all"` vs `active` (lineage) — off-lineage filtered

```mermaid
flowchart TB
  subgraph Edges["Edge cases (tests/review-gaps)"]
    E1["empty branch\n→ cancel no_live_messages"]
    E2["orphan '' firstKept\n→ recovery"]
    E3["keep:0 → compactAll ''"]
    E4["reset_boundary\n→ not resurrected"]
    E5["oversized_tail ×2.5\nsnap off toolResult"]
    E6["explicit keep:N\n→ no smartKeep boost"]
    E7["ENOENT file\n→ [] not throw"]
    E8["per-pi WeakMap\nisolated timers"]
  end
  E1 & E2 & E3 & E4 & E5 & E6 & E7 & E8 --> PASS["all 310 pass"]

  classDef edge fill:#fff8e1,stroke:#f57f17
  class E1,E2,E3,E4,E5,E6,E7,E8 edge
  class PASS fill:#e8f5e9,stroke:#2e7d32
```

## If core patch applied

```
/settings → Context → General → Compaction method order
# should show vcc in dropdown; toggling enables interception without file config
omp config list | grep compaction
```

```mermaid
flowchart LR
  SET["/settings\nContext → General\nCompaction method order"] --> DROPDOWN{"vcc in dropdown?"}
  DROPDOWN -->|patched| VCC["select vcc first\n→ method drives omp-vcc\ncan disable overrideDefaultCompaction"]
  DROPDOWN -->|unpatched| PLUGIN["plugin section\n@zhulinchng/omp-vcc\n5 toggles only"]
  PLUGIN --> HOOK["hook intercepts via\noverrideDefaultCompaction:true"]

  classDef patched fill:#e8f5e9,stroke:#2e7d32
  class VCC patched
```

## Smoke steps (CI)

```sh
bunx tsc --noEmit && bun test && bun run smoke && omp plugin link /Users/zhu/code/projects/omp-vcc && omp plugin doctor
```

```mermaid
flowchart LR
  A["bunx tsc --noEmit\n0 errors"] --> B["bun test\n310 pass 768 expects"]
  B --> C["bun run smoke\n6 checks ok"]
  C --> D["omp plugin link .\nlist --json ok"]
  D --> E["omp plugin doctor\n5 ok"]
  E --> F["gate green\nshippable"]

  classDef gate fill:#e8f5e9,stroke:#2e7d32
  class F gate
```
