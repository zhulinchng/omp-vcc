# Paper notes — arxiv 2603.29678

## Citation

Lvmin Zhang, Maneesh Agrawala — *View-oriented Conversation Compiler for Agent Trace Analysis* — arXiv:2603.29678, 2026-03-31, cs.AI.  `https://arxiv.org/pdf/2603.29678`

## One-line

Agent trace = structured document (like source code) → compile raw JSONL via lex→parse→line-assignment→view-lowering into `V_full` (identity), `V_ui` (one-line summaries + pointers), `V_adapt(b,ρ)` (structure-preserving projection via `ρ`) with shared coordinate system and transposed modalities; improves AppWorld task_goal +1.1–4.2 pts while halving token cost.

```mermaid
flowchart LR
  TRACE["agent trace\nstructured doc\nJSONL ~10k"] --> COMP["VCC compiler\nlex → parse IR\n→ line assignment\n→ view lowering"]
  COMP --> VFULL["V_full\nidentity"]
  COMP --> VUI["V_ui\nsummaries"]
  COMP --> VADAPT["V_adapt(b, ρ)\nprojection"]
  VUI & VADAPT -. "pointer → V_full[s:e]" .-> VFULL
  VFULL & VUI & VADAPT --> APP["AppWorld task\n+1.1–4.2 pts\n½–⅔ tokens"]
  classDef view fill:#e3f2fd,stroke:#1565c0
  class VFULL,VUI,VADAPT view
  class APP fill:#e8f5e9,stroke:#2e7d32
```

## Three views definition (paper §2.1)

All views share a single line-number coordinate system; views are *transformations*, not copies.

```
V_full(b) = identity(b)          // every IR node verbatim, defines coordinates L = V(txt)
V_ui(b)   = project to 1-line per tool call, elide internals, merge same message.id, L = I
V_adapt(b,ρ) = filter(b, ρ) where ρ ∈ {regex, BM25, embedding, LLM} via match_lines(b,ρ)
             // preserves turn/header/block delimiters, role tags, pointers (f:s-e)
V(txt) = L, V(min.txt)=I, V(view.txt)=I+M  (typesets §3.1)
```

Pointer invariant (SSA-like): any pointer in `V_ui` or `V_adapt` resolves structurally to `V_full[s:e]`.

```mermaid
flowchart TB
  L["L = V(txt)\nfull coordinates\n10k lines"] --> I["I = V(min.txt)\nUI skeleton\n120 lines"]
  L --> M["M = indexed hits\nfiltered view"]
  I --> IM["I+M = V(view.txt)\ncombined view\ntemporal or flat"]

  subgraph Invariant["Stable pointers"]
    P1["(#N) refs\nbrief.ts\none-line → V_full[N]"]
    P2["(f:s-e) pointers\nformat-recall.ts\nfile:lines → V_full[s:e]"]
    P3["firstKeptEntryId\nlineage.ts\nkept tail → V_full"]
  end
  I -.-> P1 & P3
  M -.-> P2
```

Two **transposed modalities** same data (Fig.1 right):

- *Document-oriented* (temporal, row-major) — preserves turn order, `(#N)` refs, `SEP` boundaries
- *Index-oriented* (flat list, column-major) — hits as flat list with file index

```mermaid
flowchart LR
  subgraph Data["Same underlying data\nrendered + rawMessages"]
    RAW["rawMessages[]\nAgentMessage[]\nwith pointers"]
  end
  RAW --> DOC["document-oriented\nV_adapt temporal\ndefault formatRecallOutput\n(#2) user: 'fix auth'\n--- SEP ---\n(#5) assistant: 'Read src/auth.ts'\nturn/header/block preserved"]
  RAW --> IDX["index-oriented\nmode:'touched'\nformatTouchedOutput\n['src/auth.ts:12-18', 'src/app.ts:4']\nflat list, column-major"]
  DOC -. "transpose" .-> IDX
  IDX -. "transpose" .-> DOC

  classDef temporal fill:#fff3e0,stroke:#ef6c00
  class DOC temporal
  classDef flat fill:#f3e5f5,stroke:#7b1fa2
  class IDX flat
```

Workflow progressive disclosure §2.4: `V_ui → V_adapt(query) → resolve pointer → V_full[s:e]`.

```mermaid
flowchart LR
  VUI["V_ui\nscan 5 sections\n+ 120-line transcript\ncheap, overview"] --> Q["form query ρ\nregex or keywords\n'auth token'"]
  Q --> VADAPT["V_adapt(b, ρ)\nmatch_lines(b,ρ)\nstructure-preserving\nfilter(b, ρ)\npreserves role tags"]
  VADAPT --> SEL{"hit relevant?"}
  SEL -->|no| Q
  SEL -->|yes| PTR["pointer (f:s-e)\n(#N) or #12:src/auth.ts"]
  PTR --> VFULL["V_full[s:e]\nverbatim lines\nlossless detail"]
  VFULL --> ACT["act / write MEMORY.md"]

  classDef step fill:#e3f2fd,stroke:#1565c0
  class VUI,VADAPT,VFULL step
```

## Pipeline (§2.2–2.3)

```
raw JSONL → lex → parse to typed IR (user, assistant, thinking, tool_call, tool_result, subagent) → monotonic line assignment → view lowering
```

Assignment happens **once before lowering** — not per-view.

```mermaid
flowchart TB
  RAW["raw JSONL\n~10k session entries"] --> LEX["lex\nsanitize: ANSI, control chars\nstrip, digits→ removed"]
  LEX --> PARSE["parse → typed IR\nnormalize.ts\nuser | assistant | thinking\ntool_call | tool_result | subagent\nmerged same message.id"]
  PARSE --> FILTER["filter\n<system-reminder>\n<ide_opened_file>\nTodoWrite, ToolSearch\nqueue-operation discarded"]
  FILTER --> ASSIGN["monotonic line assignment\nONCE before lowering\ncalibrateCharsPerToken\n→ (#N) coordinates"]
  ASSIGN --> LOWER{"view lowering"}

  LOWER --> VFULL["V_full = identity(b)\nverbatim, L"]
  LOWER --> VUI["V_ui = 1-line/tool call\nelide internals\nbrief.ts + rank.ts"]
  LOWER --> VADAPT["V_adapt = filter(b, ρ)\npreserves turn/header/block\n+ role tags + pointers"]

  classDef once fill:#e8f5e9,stroke:#2e7d32
  class ASSIGN once
```

Transformations (§2.3, Fig.2):

- Escaped JSON tool params → block-indented text with `|` YAML scalar
- Read result `123→  content` → strip `digits→  `
- Harness XML `<system-reminder>`, `<ide_opened_file>` etc filtered
- Internal tool calls `TodoWrite`, `ToolSearch`, ANSI, control chars removed
- Assistant messages split by same `message.id` merged
- Zero-content records (`queue-operation`, `file-history-snapshot`, `progress`, `api_error`) discarded
- Base64 images extracted

```mermaid
flowchart LR
  subgraph Before["Before normalize"]
    B1["cat file.txt / file src/x.ts / escaped JSON"]
    B2["123 arrow content of file / prefixed digits"]
    B3["system-reminder hint / harness XML"]
    B4["TodoWrite / internal tool"]
  end
  subgraph After["After normalize + filter-noise"]
    A1["block scalar indented / file src/x.ts"]
    A2["content of file / stripped digits"]
    A3["removed / filtered"]
    A4["removed / allowlisted only"]
  end
  B1 --> A1
  B2 --> A2
  B3 --> A3
  B4 --> A4
```

## Implementation mapping (omp-vcc)

| Paper concept | omp-vcc module |
|---|---|
| `lex` + `parse` IR | `normalize.ts` + `load-messages.ts` (`isContentBearing`, `extractPath`, `sanitize`) |
| Line assignment before lowering | `token-estimate.ts` `calibrateCharsPerToken` + stable `(#N)` refs / `firstKeptEntryId` lineage |
| `V_ui` one-line summaries | `brief.ts` + `format.ts` bracketed sections + `rank.ts` TF-IDF |
| `V_adapt` `match_lines(b,ρ)` | `search-entries.ts` `searchEntriesDetailed` (ρ regex → OR-ranked TF-IDF) + `format-recall.ts` `SEP` |
| Document vs index modalities | default `formatRecallOutput` (temporal) vs `mode:'touched'` `formatTouchedOutput` (flat list) + `drill-down.ts` `#N:path` |
| `V_full` pointers | `lineage.ts` active-leaf ancestry, `render-entries.ts` |

```mermaid
flowchart TB
  subgraph Paper["Paper §2.1–2.3"]
    P1["lex/parse IR"]
    P2["line assignment"]
    P3["V_ui"]
    P4["V_adapt(b,ρ)"]
    P5["modalities"]
    P6["V_full"]
  end
  subgraph Omvcc["omp-vcc"]
    O1["normalize.ts\nsanitize.ts\ncontent.ts\nload-messages.ts"]
    O2["token-estimate.ts\n(#N) + firstKeptEntryId"]
    O3["brief.ts\nformat.ts\nrank.ts\nsummarize.ts"]
    O4["search-entries.ts\nformat-recall.ts"]
    O5["formatRecallOutput vs\nformatTouchedOutput\ndrill-down.ts"]
    O6["line-age.ts\nrender-entries.ts"]
  end
  P1 --> O1
  P2 --> O2
  P3 --> O3
  P4 --> O4
  P5 --> O5
  P6 --> O6
```

Comment headers in each ported file cite `arxiv:2603.29678 §2.x` and `lllyasviel/VCC#How It Works`.

## Experiment (§3)

**AppWorld** epoch protocol — 168 tasks dev + 416 test.

Per epoch `t`:

- `generator(t)` → trajectory (raw JSONL)
- `reflector(t)` input `V` (raw vs VCC) → `MEMORY.md` (procedural memory)
- `diff-merge` into global memory

90×2=180 analyses, 32 parallel. Three model configurations:

- Opus 4.6 (`claude-opus-4.6`) + Sonnet 4.5
- Sonnet 4.5 alone
- Haiku 4.5 + Sonnet 4.5

```mermaid
flowchart TB
  subgraph Epoch["Per epoch t (32 parallel)"]
    G["generator(t)\nproduces trajectory\nraw JSONL trace"]
    G --> V{"view V?"}
    V -->|raw| RAW["NO_VCC\nraw trace\n22 M tokens"]
    V -->|VCC| VCC["VCC\nV_ui + V_adapt\n7.6 M tokens (−66%)"]
    RAW & VCC --> R["reflector(t, V)\nwrites MEMORY.md"]
    R --> DIFF["diff-merge → global memory"]
  end
  DIFF --> NEXT["t+1"]
  NEXT --> G

  classDef vcc fill:#e8f5e9,stroke:#2e7d32
  class VCC vcc
  classDef raw fill:#fce4ec,stroke:#c2185b
  class RAW raw
```

**Table 1** (test suites, mean ± std):

|  | `task_goal` NO_VCC → VCC | `test_case` | reflector tokens NO_VCC → VCC | memory size |
|---|---|---|---|---|
| Opus | 62.8±1.4 → **64.6±1.4** (+1.8, p=0.04) | 68.4 → 70.1 | 22.1 M → **7.6 M** (−66%) | larger → **smaller** |
| Sonnet | 58.2 → 62.4 (+4.2) | 64.1 → 67.9 | 20.5 M → 8.8 M (−57%) | — |
| Haiku | 47.3 → 48.4 (+1.1) | 53.0 → 54.2 | 23.3 M → 12.6 M (−46%) | — |

```mermaid
flowchart LR
  subgraph Tokens["Reflector tokens (Opus)"]
    direction TB
    T1["NO_VCC\n22.1 M"]
    T2["VCC\n7.6 M"]
    T1 -->|"−66%"| T2
  end
  subgraph Quality["task_goal (Opus)"]
    direction TB
    Q1["NO_VCC\n62.8"]
    Q2["VCC\n64.6"]
    Q1 -->|"+1.8 (p=0.04)"| Q2
  end
  Tokens -.-> Quality
  Q1 & Q2 --> NOTE["Effect correlates\nwith trace length\n& generator capability"]

  classDef vcc fill:#e8f5e9,stroke:#2e7d32
  class T2,Q2 vcc
```

Raw JSONL loses to VCC on both quality and cost. Effect size correlates with generator capability (longer traces → more to compress, higher-quality patterns).

## Related work (§4)

- Multi-level memory (MemGPT, RAPTOR) — precomputed store vs VCC projective.
- Flat search — loses role/structure, VCC preserves.
- Context-length tradeoffs: Liu et al. 2024 *Lost in the Middle*, Xiao et al. 2025 redundant tokens 40–60% — motivates VCC's structure-preserving projection.

```mermaid
flowchart TB
  subgraph VCC["VCC — projective"]
    V1["no precompute store\nviews are transforms\nof V_full"]
    V2["preserves headers\nrole tags, pointers"]
    V3["shared coordinates\npointer → V_full[s:e]"]
  end
  subgraph Mem["MemGPT / RAPTOR"]
    M1["precomputed hierarchy\nsummaries stored"]
    M2["separate index\nnot structure-preserving"]
  end
  subgraph Flat["Flat search"]
    F1["grep-like\nloses turn/block"]
    F2["no skeleton\nno role tags"]
  end
  VCC -. "vs" .-> Mem & Flat
  classDef vcc fill:#e3f2fd,stroke:#1565c0
  class V1,V2,V3 vcc
```

**Caveat**: AppWorld gains (+1.1–4.2) are not automatically transfer to code-edit tasks; VCC is context-engineering, not magically stronger reasoning. Paper notes same caution for long-context vs curated memory (Trivedi et al.).

## Takeaways for omp-vcc

- Keep single line assignment before lowering — don't re-number per view.
- Preserve skeleton + role tags in `V_adapt` — not just hit text.
- Use `ρ` predicate hierarchy: try regex, fallback to BM25 OR, then embedding/LLM if available (omp-vcc does regex→TF-IDF).
- Transposed views are same data, not separate stores — implement both from same `rendered` + `rawMessages`.
- Evaluation harness `scripts/benchmark-real-sessions.ts` mirrors paper's generator→reflector loop; for omp-vcc, compare `MEMORY.md` size and token cost.

```mermaid
mindmap
  root((omp-vcc takeaways))
    line assignment once
      calibrateCharsPerToken
      firstKeptEntryId lineage
      stable (#N)
    V_ui brief
      5 sections
      120 lines capBrief
      TF-IDF rank
    V_adapt projection
      regex first
      TF-IDF OR fallback
      preserve skeleton
    modalities same data
      document-oriented default
      index-oriented touched
      drill-down #N:path
    evaluation
      generator→reflector
      MEMORY.md diff-merge
      token halving
```
