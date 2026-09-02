# @zhulinchng/omp-vcc — Algorithmic VCC Compaction for oh-my-pi

> Fast, deterministic, lossless compaction — no LLM calls. Port of [`sting8k/pi-vcc`](https://github.com/sting8k/pi-vcc) (`@0.7.0`) into [oh-my-pi](https://github.com/can1357/oh-my-pi), inspired by [`lllyasviel/VCC`](https://github.com/lllyasviel/VCC) and paper [`arxiv:2603.29678`](https://arxiv.org/pdf/2603.29678) *View-oriented Conversation Compiler for Agent Trace Analysis* (Zhang & Agrawala, 2026-03-31).

## Quick start

> **New here?** → [`docs/setup.md`](docs/setup.md) — 5-minute install with prerequisites, 4 install options (link / npm / git), verify, first `/omp-vcc`, recall, config, and troubleshooting. The commands below are the tldr.

```sh
# from source (local)
omp plugin link /Users/zhu/code/projects/omp-vcc
omp plugin list --json | jq '.[] | select(.name|contains("omp-vcc"))'

# from npm (unscoped)
omp plugin install omp-vcc

# from GitHub Packages (scoped, requires auth — see below)
omp plugin install @zhulinchng/omp-vcc

# from git
omp plugin install github:zhulinchng/omp-vcc
```

## What you get

- **Auto** threshold/overflow compaction via `session_before_compact` hook — no LLM summary, 30–470 ms, 35–99% reduction.
- **Manual** `/omp-vcc [keep:N] [focus]` (and `/pi-vcc` alias) — e.g. `/omp-vcc keep:2 fix auth` keeps last 2 user turns.
- **Recall** `vcc_recall({query:"redis cache", scope:"all", page:1})` or `/vcc-recall hook|inject scope:all page:2` — ranked regex → TF-IDF OR, 5/page, `mode:'touched'` and `#N:path` drill-down.

## Commands

| Command | Description |
| --- | --- |
| `/omp-vcc [keep:N] [focus]` | Algorithmic compaction, smart-keep may boost `keep:1` to keep more when tail small (5 k → 25 k). `keep:0` compacts all. |
| `/pi-vcc` | Alias for migration |
| `/vcc-recall [query] [scope:all] [page:N]` | Search compacted history (V_adapt). Plain keywords best. |
| `/pi-vcc-recall` | Alias |

Tool `vcc_recall` mirrors the command, plus `expand:[indices]` and `mode:'touched'` for file index.

## Configuration

File `~/.omp/omp-vcc/config.json` (XDG-aware: `$OMP_VCC_CONFIG_PATH` > `$PI_VCC_CONFIG_PATH` (legacy) > `$OMP_DIR`/`$PI_CODING_AGENT_DIR` > `~/.omp/omp-vcc/config.json`, migrates legacy `~/.pi/agent/pi-vcc-config.json`):

```json
{
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "continueAfterThresholdCompact": true,
  "debug": false
}
```

## How it works

VCC compiles the raw JSONL trace via **lex → parse IR → monotonic line assignment → view lowering** into three views sharing one coordinate system:

- `V_full` identity — every message verbatim, defines coordinates `L`
- `V_ui` one-line tool summaries with stable pointers (`* Read "src/pets.py" (file.txt:18-20)`)
- `V_adapt(b, ρ)` projection via predicate `ρ` preserving headers/role tags and `(f:s-e)` pointers, two transposed modalities (document vs index oriented)

`omp-vcc` implements `V_ui` as the structured summary (5 sections + ranked brief transcript) and `V_adapt` as `vcc_recall`. Pointer invariant `V_ui → V_full[s:e]` holds structurally.

### No LLM — just local algorithm (30–470 ms)

Traditional compaction ships the whole history to a remote LLM and waits seconds. `omp-vcc` never calls a model: it reuses `branchEntries` already in memory, calibrates token size, cuts, normalizes, and ranks locally.

```mermaid
flowchart TB
  subgraph VCC["omp-vcc — local, deterministic"]
    A["branchEntries\nin memory"] --> B["calibrate\ncpt = chars / tokensBefore"]
    B --> C["buildOwnCut + smartKeep\nkeep tailored to tail size"]
    C --> D["normalize + filter\nstrip ANSI, 123 arrow, harness XML"]
    D --> E["rank TF-IDF\n5 sections + brief transcript"]
    E --> F["summary 1.1k tok\n+ kept tail\n30-470 ms, zero cost"]
  end
  subgraph LLM["native remote LLM compaction"]
    L1["branchEntries"] --> L2["serialize history\nHTTP to LLM"]
    L2 --> L3["wait seconds\n+ token cost\n+ nondeterministic"]
  end
  F -. "next turn sees only F" .-> A
  classDef vcc fill:#e8f5e9,stroke:#2e7d32
  class F vcc
  classDef llm fill:#fce4ec,stroke:#c2185b
  class L3 llm
```

**Example** — a 80-turn session at 90k tokens, `keep:1` tail is only 3k (wastes budget):

- raw tail `3k` → `smartKeepTail` grows to `keep:4` with tail `21k` (still ≤ 25k cap)
- older 76 turns are compiled into `V_ui`:

```txt
[Session Goal] Fix auth token refresh
[Files And Changes] src/auth.ts, src/app.ts
[Brief transcript] (ranked, TF-IDF, 78 lines)
  (#12) Read src/auth.ts — missing refresh on expiry
  (#18) Edit src/auth.ts:12-34 — add refreshToken()
  (#33) Test auth flow — 2 failed, 1 passed
---
Kept tail (#77-#80) stays verbatim for immediate continuity.
```

Recall is the same idea: `vcc_recall` runs local regex → TF-IDF `rank.ts` and preserves skeleton. `query: "hook|inject"` returns 5 hits with `(#N)` pointers like `(#33) hook registration`; `query: "#18:src/auth.ts"` drills to `V_full[18:e]` verbatim.

Full diagrams and pipeline in [`docs/architecture.md`](docs/architecture.md); paper mapping in [`docs/paper-notes.md`](docs/paper-notes.md); setup in [`docs/setup.md`](docs/setup.md).

- **pi-vcc** — TypeScript algorithmic compactor, zero LLM, `RANKED_BRIEF_BUDGET_TOKENS=1100` ceil 2000, `charsPerBlock 15`
- **VCC** — Python `VCC.py` adaptive/transposed views, `SEP`, `match_lines`, `_tokenize`, `_trunc`, projection model
- **Paper** — AppWorld evaluation: +1.1–4.2 task_goal points, ½–⅔ token halving, smaller memory

## Develop

```bash
omp plugin link .
omp plugin doctor
bunx tsc --noEmit
bun run smoke       # or bun run scripts/smoke.ts
bun test
```

Capabilities: `extension`, `skill`, `command` — entry `extensions/main.ts`.

## Verification

```sh
bunx tsc --noEmit
bun test          # 310 tests across 33 files, 768 expects
bun run smoke     # ok: session_before_compact hooked, vcc_recall registered
omp plugin link /Users/zhu/code/projects/omp-vcc && omp plugin doctor
```

In a live `omp` session: `/omp-vcc keep:1` shows `[Session Goal]` toast `omp-vcc: kept 1/5 turns, ~2.1k tok`; with `debug:true` check `/tmp/omp-vcc-debug.json`. Full proof matrix and mermaid flows in [`docs/verification.md`](docs/verification.md).
## Publish

See [`docs/PUBLISHING.md`](docs/PUBLISHING.md) for the full checklist (package shape, gates, dual `omp-vcc` / `@zhulinchng/omp-vcc` flow, verification, deployment matrix, and troubleshooting). TL;DR:

- npmjs (unscoped): `npm publish --access public` (package `omp-vcc`, 2FA `auth-and-writes` → browser or `--otp`)
- GitHub Packages (scoped): `gh release create vX.Y.Z` triggers `.github/workflows/publish-gpr.yml` → `@zhulinchng/omp-vcc` via `GITHUB_TOKEN` (`read:packages, write:packages`); manual fallback `npm pkg set name=@zhulinchng/omp-vcc && GITHUB_TOKEN=$(gh auth token) npm publish --userconfig /tmp/gpr-npmrc --access public` (see guide for the scoped-registry `/tmp/gpr-npmrc` pitfall)
- Consumer GPR auth: add to `~/.npmrc`:
  ```
  @zhulinchng:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
  ```
- Marketplace: add an entry to `.omp-plugin/marketplace.json` (see `plugin-skill/assets/templates/marketplace-entry.json.template`).

## License

MIT — pi-vcc core files retain original MIT.
