# Architecture — omp-vcc

## Paper foundation (arxiv 2603.29678 §2)

Agent trace = structured document (`user`, `assistant`, `thinking`, `tool_call`, `tool_result`, `subagent`, compaction boundary, harness `<system-reminder>`/`<ide_opened_file>` etc, >10 k JSONL lines). VCC requirement: lossless record + session overview + role-aware retrieval.

**Compiler pipeline** `lex → parse to typed IR → monotonic line assignment → view lowering` (paper §2.2, Fig.1 left). Single assignment before lowering guarantees pointer invariant `V_ui → V_full[s:e]` and `V_adapt → V_full[s:e]` structurally (SSA-like). All pointers are stable `(#N)` refs / `firstKeptEntryId` lineage, not per-view re-numbering.

```mermaid
flowchart LR
  RAW["raw JSONL\n~10k lines"] --> LEX["lex\nsanitize.ts\nANSI strip, digits→ strip"]
  LEX --> PARSE["parse → IR\nnormalize.ts / content.ts\ntyped nodes: user, assistant,\nthinking, tool_call, tool_result,\nsubagent, queue-op discarded"]
  PARSE --> LINE["monotonic line assignment\ntoken-estimate.ts\ncalibrateCharsPerToken\nonce before lowering"]
  LINE --> VFULL["V_full\nidentity\ndefines coordinates L"]
  LINE --> VUI["V_ui\none-line summaries\n+ pointers"]
  LINE --> VADAPT["V_adapt(b, ρ)\nfilter(b, ρ) projection"]
  VFULL -. "V_ui → V_full[s:e]\nV_adapt → V_full[s:e]\n(#N) / firstKeptEntryId" .-> VUI & VADAPT

  classDef view fill:#e3f2fd,stroke:#1565c0
  class VFULL,VUI,VADAPT view
```

**Three views** sharing `V_full` coordinate system (paper eq.1–2):

- `V_full` — identity, every IR node verbatim, defines coordinates.
- `V_ui` — one-line tool summaries `* Read "src/pets.py" (file.txt:18-20,23-25)`, elided internals, merged same `message.id` assistant turns (paper Fig.1 center).
- `V_adapt(b, ρ)` — structure-preserving projection `output = filter(b, ρ)` preserving `turn/header/block` delimiters, role tags `[tool_call]/[thinking]`, pointers `(f:s-e)` or `from` truncation; `ρ ∈ {regex, BM25, embedding, LLM}` via `match_lines(b,ρ)` (§2.1). Two transposed modalities: *document-oriented* temporal (row-major) vs *index-oriented* flat list (column-major), same data. Typesets: `V(txt)=L`, `V(min.txt)=I`, `V(view.txt)=I+M` (§3.1).

```mermaid
flowchart TB
  subgraph Coord["Single coordinate system L = V(txt)"]
    VFULL["V_full\nL — verbatim IR\ndefines coordinates"]
  end

  VFULL --> VUI["V_ui\nI — one-liners + pointers\n* Read 'src/pets.py' (18-20)"]
  VFULL --> VADAPT["V_adapt(b, ρ)\nI+M — filtered + skeleton\npreserves turn/header/block"]

  VUI --> DOC["document-oriented\nrow-major temporal\n(#N) refs, SEP boundaries"]
  VUI --> IDX["index-oriented\ncolumn-major flat list\nmode:'touched'"]

  VADAPT --> DOC
  VADAPT --> IDX

  DOC & IDX -. "pointer resolves\n(#12) → V_full[12:e]\n#N:path drill-down" .-> VFULL
  VUI -. "stable refs\n(#N), firstKeptEntryId" .-> VFULL
```

**Progressive disclosure workflow** §2.4: `V_ui → V_adapt(query) → resolve pointer V_full[s:e]`. AppWorld protocol: generator→reflector→`MEMORY.md` diff-merge.

```mermaid
sequenceDiagram
  participant Agent
  participant Vui as V_ui
  participant Vadapt as V_adapt
  participant Vfull as V_full
  Agent->>Vui: scan one-line brief transcript<br/>5 sections + 120 lines
  Vui-->>Agent: pointers (#N) + hints
  Agent->>Vadapt: query ρ = regex / TF-IDF<br/>vcc_recall {query:"hook|inject"}
  Vadapt-->>Agent: skeleton + hits + pointers<br/>SEP, role tags, (f:s-e)
  Agent->>Vfull: resolve pointer<br/>#12:src/auth.ts / firstKeptEntryId
  Vfull-->>Agent: verbatim lines V_full[s:e]
  Agent->>Agent: act / MEMORY.md diff-merge
```

**Related positioning** §4: vs multi-level memory (MemGPT/RAPTOR precomputed) and flat search — VCC is *projective*, not store. Context-length tradeoffs: Liu et al. lost-in-middle, Xiao et al. 40–60% redundant tokens.

## Implementation pipeline (omp-vcc)

```
Calibrate → Smart keep → Build cut → Normalize (IR) → Filter noise → Build sections → Brief transcript (V_ui) → Format → Merge
```

```mermaid
flowchart LR
  A["Calibrate\ncalibrateCharsPerToken\ncpt = clamp(totalChars/tokensBefore,2,6)"] --> B["Smart keep\nresolveSmartKeepUserTurns\nkeep:1→N while tail ≤25k\nrespect explicit keep:N"]
  B --> C["Build cut\nbuildOwnCut\nfirstKeptEntryId + orphan ''\n>2 live, cutIdx=userIndices[target]\ncompactAll sentinel"]
  C --> D["Tail budget rescue\napplyTailBudget ×2.5\nsnap off toolResult"]
  D --> E["Normalize (lex/parse IR)\nnormalize.ts / sanitize.ts / content.ts\n| block scalars, clip, PATH_KEYS"]
  E --> F["Filter noise\nfilter-noise.ts\n<harness> removed"]
  F --> G["Build sections\nbuild-sections.ts\nextract/* 5 sections"]
  G --> H["Brief V_ui\nbrief.ts + rank.ts TF-IDF\nperBlock 15*cpt"]
  H --> I["Format\nformat.ts\nbracketed + RECALL_NOTE"]
  I --> J["Merge\nsummarize.ts\nsticky dedup, volatile replace\nroll, capBrief 120 lines"]
  J --> K["Output\n{summary, details,\nfirstKeptEntryId, tokensBefore}"]
  K --> L["Savings\nkeptChars→keptTokensEst\nsummaryChars→summaryTokensEst\ntokensAfterEst→savedEst/percent\n+ authoritative enrich"]

  classDef stage fill:#fff3e0,stroke:#ef6c00
  class A,B,C,D,E,F,G,H,I,J stage
  class K,L fill:#e8f5e9,stroke:#2e7d32
```

Mapped from VCC compiler stages (§2.3) and pi-vcc 20-file core:

| Stage | pi-vcc module | VCC anchor | omp-vcc location |
|---|---|---|---|
| Calibrate `charsPerToken` | `token-estimate.ts` `calibrateCharsPerToken(totalChars / tokensBefore)` fallback 4, clamp 2–6, `IMAGE_CONTENT_CHARS 4800` | line assignment before lowering | `extensions/vcc-core/core/token-estimate.ts` |
| Smart keep | `resolveSmartKeepUserTurns` `MIN 5k → MAX 25k`, grows `keep:1` while tail ≤ max, respects explicit `keep:N`, stops at `compactAll` | size-relative budget | `extensions/vcc-core/hook.ts` |
| Build cut | `buildOwnCut(branchEntries, keep:N)` collects live messages via `firstKeptEntryId` + orphan recovery (`""` sentinel or missing id), enforces `>2` live, `cutIdx = userIndices[target]`, `compactAll` sentinel `firstKeptEntryId=""` | IR sequence `I=(n1..nN)` + lineage | `hook.ts` |
| Tail budget rescue | `applyTailBudget` `OVERSIZED_TAIL_FACTOR 2.5`, `findBudgetCutIndex` token-budget scan + snap off `toolResult` boundary | rescue autonomous/oversized | `hook.ts` |
| Normalize (lex/parse IR) | `normalize.ts` uniform blocks, `sanitize.ts` ANSI/control strip, `content.ts` `clip`/`isContentBearing`, `tool-args.ts` `PATH_KEYS` | `normalize.ts` + `load-messages.ts` = lex→parse IR: escaped JSON→`|` block scalars, `digits→` stripped, `<system-reminder>`/`<ide_opened_file>` filtered, `TodoWrite`/`ToolSearch` removed, same `message.id` merged, `queue-operation`/`file-history-snapshot`/`progress`/`api_error` discarded, base64 images extracted | `extensions/vcc-core/core/normalize.ts` etc |
| Filter noise | `filter-noise.ts` | harness filtering | `core/filter-noise.ts` |
| Build sections | `build-sections.ts` regex extractors `extractGoals`, `extractFiles`, `extractCommits`, `extractPreferences`, `collapseSkillText` `RANKED_BRIEF_BUDGET*` | 5 semantic sections | `core/build-sections.ts` + `extract/*` |
| Brief transcript (V_ui) | `brief.ts` chronological one-liners `(#N)` refs, `rank.ts` TF-IDF weighting, `format.ts` bracketed sections `RECALL_NOTE`, `summarize.ts` bounded merge (sticky dedup, volatile replace, transcript roll, `RANKED_BRIEF_BUDGET_TOKENS=1100` ceil 2000, `briefCharsPerBlock 15`, `BRIEF_MAX_LINES 120` cap via `capBrief`) | `V_ui` identity vs UI distinction eq.1, `V_adapt` eq.2 | `core/brief.ts`, `rank.ts`, `format.ts`, `summarize.ts` (`compileRanked`) |
| Recall ranking | `search-entries.ts` `searchEntriesDetailed` regex→OR (`rank.ts` rare-term weighted), `render-entries.ts`, `format-recall.ts`, `drill-down.ts` `#N:path` | `V_adapt` `match_lines(b,ρ)` preserving skeleton + `SEP` | `core/search-entries.ts`, `core/format-recall.ts`, `core/drill-down.ts` |
**Module map** `extensions/vcc-core/`:

```
vcc-core/
  hook.ts                — registerBeforeCompactHook (context filter, before_agent_start, session_before_compact with buildOwnCut/smartKeep/budget/compileRanked + savings, session_compact toast + invisible-continue + authoritative enrich, vcc_stats history/table)
  core/
    brief.ts, rank.ts, build-sections.ts, format.ts, summarize.ts, token-estimate.ts, normalize.ts, filter-noise.ts, content.ts, sanitize.ts, tool-args.ts, report.ts, line-age.ts, load-messages.ts, render-entries.ts, search-entries.ts, format-recall.ts, drill-down.ts, recall-scope.ts, settings.ts, skill-collapse.ts
  extract/
    commits.ts, files.ts, goals.ts, preferences.ts
  types.ts, details.ts (version 2 + savings), sections.ts
  commands/vcc-recall.ts — shim for pi-vcc test compatibility
```

Host pipeline that omp-vcc bypasses is detailed in [harness.md §5.2.1](harness.md) (prune → useless → threshold → prepareCompaction → walk methodOrder) and pinned host docs [omp-compaction.md](omp-compaction.md)/[omp-snapcompact.md](omp-snapcompact.md) @18781d8295.

```mermaid
flowchart TB
  HOOK["hook.ts\norchestrator\nsession_before_compact\n+ savings + history"]

  subgraph Core["core/ — vendored pipeline"]
    TOKEN["token-estimate.ts\ncalibrate"]
    NORM["normalize.ts\nsanitize.ts\ncontent.ts\ntool-args.ts"]
    FILT["filter-noise.ts"]
    SECT["build-sections.ts\n+ extract/*"]
    BRIEF["brief.ts\nrank.ts\nsummarize.ts\nformat.ts"]
    SEARCH["search-entries.ts\nformat-recall.ts\ndrill-down.ts\nrender-entries.ts"]
    LOAD["load-messages.ts\nline-age.ts\nrecall-scope.ts"]
    SETT["settings.ts\nskill-collapse.ts\nreport.ts"]
  end

  HOOK --> TOKEN & NORM & FILT & SECT & BRIEF & SEARCH & LOAD
  NORM --> FILT --> SECT --> BRIEF
  BRIEF --> SEARCH
  LOAD --> SEARCH
  TOKEN -. "cpt for budget\n& chars" .-> BRIEF & SEARCH

  MAIN["extensions/main.ts\nfactory (pi: ExtensionAPI)"] --> HOOK
  HOOK --> CMDS["extension commands\nomp-vcc / vcc-recall / vcc-stats\n(pi-vcc legacy aliases)"]

  classDef orchestrator fill:#f3e5f5,stroke:#7b1fa2
  class HOOK,MAIN orchestrator
```

**Extension lifecycle** `extensions/main.ts` factory `(pi: ExtensionAPI) => void`:

1. `scaffoldSettings()` → `~/.omp/omp-vcc/config.json` (XDG-aware, migrates `~/.pi/agent/pi-vcc-config.json`)
2. `pi.on("context", filter omp/pi auto-continue marker)` strips `customType === "omp-vcc-auto-continue" || "pi-vcc-auto-continue"` (matches pi-vcc's `on('context')` filter)
3. `pi.on("before_agent_start", clearPendingAutoContinue)`
4. `pi.on("session_before_compact", handler)` → `parseCompactionInstructions` (accepts both `__pi_vcc__` and `__omp_vcc__` sentinels), `buildOwnCut`, `resolveSmartKeepUserTurns`, `applyTailBudget`, `calibrateCharsPerToken`, `compileRanked` with size-relative budget, computes `summaryChars → summaryTokensEst`, `keptChars → keptTokensEst`, `tokensAfterEst/savedEst/percent`, writes `details.savings` (`version:2`) + `dbg.savings` + `setLastStats` (per-pi `WeakMap`+`perPiKeys` + global, 50-capped, `timestamp`), returns `{compaction: {summary, details, tokensBefore, firstKeptEntryId}}` or `{cancel:true}` (overflow/willRetry fallback vs cancel). Reuses `convertToLlm` shim (host `session/messages` or identity).
5. `pi.on("session_compact", ...)` enriches `lastStats` with authoritative `compactionEntry.tokensAfter/tokensBefore → saved/percent` *before* `isPiVccLast/willRetry` early returns, then schedules toast (`formatCompactionStats` with `90k→22k (76% saved)` prefix, budgetCut aware, `999→500` vs `1.0k`) and `triggerInvisibleContinue` (`customType:"omp-vcc-auto-continue"` display:false triggerTurn:followUp) filtered in (2); `dbg.authoritativeSavings` when `debug:true`.
6. `pi.registerTool("vcc_recall", ...)` via `pi.zod` (rho: regex→OR, lineage `active` vs `all`, pagination 5, `mode:'touched'`, `expand`, `parseDrillDown`).
7. `pi.registerTool("vcc_stats", {history?:boolean})` (approval read, `perPi`+global history table via `formatStatsTable`/`formatLastStatsDetail`) + `pi.registerCommand("vcc-stats")` single (no `omp-vcc-stats` duplicate).
8. `pi.registerCommand("omp-vcc")` / `"pi-vcc"` (compact only, toast single line; detailed savings via `/vcc-stats`) and `"vcc-recall"` / `"pi-vcc-recall"` — extension-only; no `commands/*.md` file slash commands (removed to avoid duplicate `/omp-vcc`).

```mermaid
sequenceDiagram
  participant Host as oh-my-pi Host
  participant Ext as extensions/main.ts
  participant Hook as hook.ts
  participant Store as ~/.omp/omp-vcc/config.json

  Host->>Ext: factory(pi: ExtensionAPI)
  Ext->>Store: scaffoldSettings()<br/>XDG + migrate legacy
  Ext->>Host: pi.on(context, filter auto-continue)
  Ext->>Host: pi.on(before_agent_start, clear timer)
  Ext->>Host: pi.on(session_before_compact, handler)
  Ext->>Host: pi.on(session_compact, toast+continue)
  Ext->>Host: pi.registerTool(vcc_recall)
  Ext->>Host: pi.registerCommand(omp-vcc / vcc-recall)

  Note over Host,Hook: --- runtime: user triggers /omp-vcc or auto threshold ---
  Host->>Hook: session_before_compact<br/>{branchEntries, customInstructions, preparation}
  Hook->>Hook: parseCompactionInstructions<br/>__omp_vcc__ || __pi_vcc__
  Hook->>Hook: buildOwnCut + resolveSmartKeep + applyTailBudget
  Hook->>Hook: calibrateCharsPerToken → compileRanked<br/>(normalize → filter → sections → brief → format → merge)
  alt can compact
    Hook-->>Host: {compaction: {summary, details, firstKeptEntryId}}
    Host->>Host: session_compact
    Host->>Ext: session_compact handler
    Ext->>Host: notify toast + triggerInvisibleContinue<br/>customType:"omp-vcc-auto-continue"
    Host->>Ext: context filter strips marker<br/>model continues from summary
  else cancel
    Hook-->>Host: {cancel:true} — no LLM
  end

  Host->>Hook: vcc_recall {query, scope, page}<br/>→ searchEntriesDetailed → formatRecall
```

**Recall ranking** — TF-IDF `rank.ts`, `normalize.ts` (paper §2.1 `ρ` fallback), regex first. Progressive disclosure pointers `(#N)` and drill-down `#N:path` resolve to `V_full[s:e]`.

```mermaid
flowchart LR
  Q["query ρ\n'redis cache'\n'hook|inject'\n'#12:src/auth.ts'"] --> REGEX{"regex valid?"}
  REGEX -->|yes| R1["regex match_lines"]
  REGEX -->|no / no hit| TFIDF["TF-IDF OR<br/>rank.ts rare-term weighted<br/>fallback"]
  R1 & TFIDF --> FILTER["filter + preserve skeleton<br/>turn/header/block<br/>role tags [tool_call]"]
  FILTER --> SCOPE{"scope?"}
  SCOPE -->|active| LIN["getActiveLineageEntryIds<br/>line-age.ts"]
  SCOPE -->|all| ALL["all entries<br/>recall-scope.ts"]
  LIN & ALL --> RANK["rank + paginate 5/page<br/>SEP boundaries"]
  RANK --> DOC["document-oriented<br/>temporal rows\n(#N) refs"]
  RANK --> TCH["index-oriented<br/>mode:'touched'\nflat list"]
  DOC & TCH --> DRILL{"#N:path?"}
  DRILL -->|yes| EXP["expandEntryFile<br/>drill-down.ts → V_full[s:e]"]
  DRILL -->|no| OUT["formatted recall + pointer"]
```

**Token estimation math** (paper §2.2 line assignment):

```
cpt = clamp(totalChars / tokensBefore, 2, 6) else 4
estimateTokensFromChars(chars, cpt) = ceil(chars / cpt)
tailTokensForKeep = tokens( keptEntries slice )
RANKED_BRIEF_BUDGET_TOKENS 1100 → maxBriefChars = 1100*cpt
CEILING 2000, perBlock 15*cpt  (size-relative, small/med at floor, large earns up to ceiling, audit 794 sessions: LARGE -5.0pp → -2.3pp, losers 100→67/369)
```

```mermaid
flowchart TB
  START["preparation.tokensBefore\n+ totalChars of live messages"] --> HAS{"tokensBefore\navailable?"}
  HAS -->|yes| CALC["cpt = totalChars / tokensBefore\nclamp 2–6"]
  HAS -->|no| FALLBACK["cpt = 4 fallback"]
  CALC & FALLBACK --> CPT["charsPerToken cpt"]

  CPT --> TAIL["tailTokensForKeep(k)\n= ceil(chars(keptEntries[k:]) / cpt)"]
  TAIL --> SMART{"smartKeepTail\n&& !explicit?"}
  SMART -->|no| KEEP["keep = requestedKeep (1)"]
  SMART -->|yes| CHECK{"tailTokens(1) ≤ 5k?"}
  CHECK -->|no| KEEP
  CHECK -->|yes| GROW["grow k=2..N\nwhile tailTokens(k) ≤25k\npick largest feasible"]
  GROW --> KEEP

  CPT --> BUDGET["budget = 1100*cpt chars\nceiling 2000*cpt\nperBlock 15*cpt"]
  KEEP & BUDGET --> RESCUE{"oversized tail\n> budget×2.5?"}
  RESCUE -->|yes| CUT["findBudgetCutIndex\ntoken scan + snap off toolResult"]
  RESCUE -->|no| OK["proceed"]
  CUT & OK --> OUT["compileRanked with budget"]

  classDef decision fill:#fff8e1,stroke:#f57f17
  class HAS,SMART,CHECK,RESCUE decision
```

**Layout** `SessionEntry` (`type:"message"` with `message:{role,content}`, `type:"compaction"` with `firstKeptEntryId`, `type:"custom_message"` etc) vs `AgentMessage`/`Message` (pi-ai). `toLiveMessage` converts `custom_message`/`branch_summary`/`message`.

```mermaid
classDiagram
  class SessionEntry {
    <<union>>
    +type: string
    +id: string
    +message: object
    +firstKeptEntryId: string
  }
  class AgentMessage {
    +role: string
    +content: Block[]
  }
  class Block {
    +type: string
    +text: string
  }
  SessionEntry --> AgentMessage : toLiveMessage
  AgentMessage o-- Block
  Block ..> SessionEntry : normalize sanitize clip
```

## Performance & invariants

- Latency 30–470 ms, 0 allocations beyond `convertToLlm` slice (reuses `branchEntries`).
- Deterministic, no LLM.
- Empty/missing handled: `normalize` tolerates undefined content, `loadAllMessages` returns `[]`, `estimate*` heuristic fallback.
- Repeated compactions merge bounded: `summarize.ts` sticky dedup, volatile replace, transcript roll.
- `firstKeptEntryId=""` sentinel ensures `buildSessionContext` matches 0 kept, next `buildOwnCut` triggers orphan recovery.

```mermaid
stateDiagram-v2
  [*] --> Ready
  Ready --> Compacting: session_before_compact
  Compacting --> Summarized: buildOwnCut ok\ncompileRanked
  Compacting --> Canceled: too_few / no_live_messages\n→ {cancel:true}
  Summarized --> Toasted: session_compact\nnotify + invisible-continue?
  Toasted --> Ready: context filter strips\nomp-vcc-auto-continue
  Canceled --> Ready

  note right of Compacting
    branchEntries → calibrate
    → normalize → filter → sections
    → brief → format → merge
    30–470ms, no LLM
  end note
  note right of Summarized
    pointers (#N) / firstKeptEntryId
    stable across Views
  end note
```

---

See also: [Harness Impact](harness.md) — what omp-vcc adds vs intercepts in oh-my-pi, with verified citations and mermaid. · [Setup — working with strategies](setup.md#working-with-existing-compaction-strategies) · Pinned copies: [omp-compaction.md](omp-compaction.md) / [omp-snapcompact.md](omp-snapcompact.md)
