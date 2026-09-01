# @zhu/omp-vcc — Algorithmic VCC Compaction for oh-my-pi

> Fast, deterministic, lossless compaction — no LLM calls. Port of [`sting8k/pi-vcc`](https://github.com/sting8k/pi-vcc) (`@0.7.0`) into [oh-my-pi](https://github.com/can1357/oh-my-pi), inspired by [`lllyasviel/VCC`](https://github.com/lllyasviel/VCC) and paper [`arxiv:2603.29678`](https://arxiv.org/pdf/2603.29678) *View-oriented Conversation Compiler for Agent Trace Analysis* (Zhang & Agrawala, 2026-03-31).

## Quick start

```sh
# from source (local)
omp plugin link /Users/zhu/code/projects/omp-vcc
omp plugin list --json | jq '.[] | select(.name|contains("omp-vcc"))'

# from npm (once published)
omp plugin install @zhu/omp-vcc

# from git
omp plugin install github:zhu/omp-vcc
```

## What you get

- **Auto** threshold/overflow compaction via `session_before_compact` hook — no LLM summary, 30–470 ms, 35–99% reduction.
- **Manual** `/omp-vcc [keep:N] [focus]` (and `/pi-vcc` alias) — e.g. `/omp-vcc keep:2 fix auth` keeps last 2 user turns.
- **Recall** `vcc_recall({query:"redis cache", scope:"all", page:1})` or `/vcc-recall hook|inject scope:all page:2` — ranked regex → TF-IDF OR, 5/page, `mode:'touched'` and `#N:path` drill-down.

## Commands

| Command | Description |
|---|---|
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

Manifest `omp.settings` also exposed (`vccEnabled`, `overrideDefaultCompaction`, `smartKeepTail`, `continueAfterThresholdCompact`, `debug`) — appears under plugin section in `/settings` and via `omp config`. See [`docs/configuration.md`](docs/configuration.md).

## How it works

VCC compiles the raw JSONL trace via **lex → parse IR → monotonic line assignment → view lowering** into three views sharing one coordinate system:

- `V_full` identity (defines coordinates)
- `V_ui` one-line tool summaries with pointers (`* Read "src/pets.py" (file.txt:18-20)`)
- `V_adapt(b, ρ)` projection via predicate `ρ` preserving headers/role tags and `(f:s-e)` pointers, two transposed modalities (document vs index oriented)

`omp-vcc` implements `V_ui` as the structured summary (5 sections + ranked brief transcript) and `V_adapt` as `vcc_recall`. Pointer invariant `V_ui → V_full[s:e]` holds structurally. See [`docs/architecture.md`](docs/architecture.md) and [`docs/paper-notes.md`](docs/paper-notes.md).

## Related work

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
bun test          # 295 tests across 32 files
bun run smoke     # ok: session_before_compact hooked, vcc_recall registered
omp plugin link /Users/zhu/code/projects/omp-vcc && omp plugin doctor
```

In a live `omp` session: `/omp-vcc keep:1` shows `[Session Goal]` toast `omp-vcc: kept 1/5 turns, ~2.1k tok`; with `debug:true` check `/tmp/omp-vcc-debug.json`. See [`docs/verification.md`](docs/verification.md).

## Publish

- npm: `npm publish` then `omp plugin install @zhu/omp-vcc`
- Marketplace: add an entry to `.omp-plugin/marketplace.json` (see `plugin-skill/assets/templates/marketplace-entry.json.template`).

## License

MIT — pi-vcc core files retain original MIT.
