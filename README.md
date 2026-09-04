# Algorithmic VCC Compaction for oh-my-pi

> Fast, deterministic, lossless compaction. No LLM calls. Port of [`sting8k/pi-vcc@0.7.0`](https://github.com/sting8k/pi-vcc) into [oh-my-pi](https://github.com/can1357/oh-my-pi). Paper [`arxiv:2603.29678`](https://arxiv.org/pdf/2603.29678) (Zhang & Agrawala).

## Quick start

```sh
omp plugin link /Users/zhu/code/projects/omp-vcc        # local
omp plugin install omp-vcc                               # npmjs, no auth
omp plugin install @zhulinchng/omp-vcc                   # GitHub Packages, needs PAT
omp plugin install github:zhulinchng/omp-vcc             # git, latest main
omp plugin list --json | jq '.[] | select(.name|contains("omp-vcc"))'
```

New here → [`docs/setup.md`](docs/setup.md).

## What you get

- **Manual** `/omp-vcc [keep:N] [focus]` (`/pi-vcc` alias) — compact only, single-line toast `90k→22k` — e.g. `/omp-vcc keep:2 fix auth` (detailed savings via `/vcc-stats`).
- **Recall** `vcc_recall({query, scope, page, mode, expand})` + `/vcc-recall` — regex → TF-IDF OR, 5/page, `mode:'touched'`, `#N:path` drill-down.
- **Savings** toast `90k→22k (76% saved)` single line (inline `Last compaction` detail removed; use `/vcc-stats`), divider, `/vcc-stats` + `vcc_stats` tool (50-capped history, per-pi), `details.savings` persisted, `/tmp/omp-vcc-debug.json`.

## Commands

| Command | What it does | Defaults (bare invocation) |
| --- | --- | --- |
| `/omp-vcc [keep:N] [focus]` | Compact only. Toast single line; detail via `/vcc-stats`. | `keep:1` — smart-keep grows it while the tail stays ≤5k (cap 25k). `keep:0` summarizes everything. No focus = no follow-up prompt. Explicit `keep:N` is never boosted. |
| `/pi-vcc` | Legacy alias for `/omp-vcc` | Same as above. |
| `/vcc-recall [query] [scope:all] [page:N]` | Search compacted history, 5 results per page. | No query = last 25 entries of the active branch. Scope defaults to the active lineage; `scope:all` searches the whole session. `page:1`. |
| `/pi-vcc-recall` | Legacy alias for `/vcc-recall` | Same as above. |
| `/vcc-stats [history\|all]` | Last-compaction savings + history table (single, no alias). | Bare = last-compaction detail (history table appended once >1 compaction exists). `history`/`all` = full table first, then the last detail. |
| `/vcc-config` | Effective config with per-key source (`file` / `host overlay` / `default`) plus resolved file path. | Args ignored — always the merged result. |

+

+Search mode (`hybrid` regex→TF-IDF search default, `touched` = touched-files list) is a `vcc_recall` tool parameter only — the slash command always searches hybrid.
+
+Tools: `vcc_recall`, `vcc_stats` (approval `read`). Extension-only — no `commands/*.md` file slash commands (avoids duplicate `/omp-vcc`).

## Configuration

File `~/.omp/omp-vcc/config.json` — XDG: `$OMP_VCC_CONFIG_PATH` > `$PI_VCC_CONFIG_PATH` > `$OMP_DIR`/`$PI_CODING_AGENT_DIR` > `~/.omp/omp-vcc/config.json` (migrates `~/.pi/agent/pi-vcc-config.json` once).

```json
{
  "vccEnabled": true,
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "continueAfterThresholdCompact": true,
  "debug": false,
  "chainShakeHint": false
}
```

| Flag | Default | Effect |
| --- | --- | --- |
| `vccEnabled` | `true` | Master switch. `false` = no interception. |
| `overrideDefaultCompaction` | `true` | `true` = VCC handles threshold/overflow. `false` = host `methodOrder` handles them; `/omp-vcc` still works. |
| `smartKeepTail` | `true` | Grow `keep:1` when tail <5k (cap 25k). Explicit `keep:N` never boosted. |
| `continueAfterThresholdCompact` | `true` | Invisible-continue (`omp-vcc-auto-continue`) after threshold compact. |
| `debug` | `false` | Write `/tmp/omp-vcc-debug.json` per compaction. |
| `chainShakeHint` | `false` | Eager post-VCC `shake` chain. Host rescue already auto-shakes on dead-end; this forces it. |

Toggle live: `omp config set plugins."@zhulinchng/omp-vcc".debug true` or `/settings` → `@zhulinchng/omp-vcc`. File is source of truth; `ctx.settings` overlays at runtime. `/vcc-config` shows the merged result — use it to confirm a toggle took effect.

## How it works

VCC compiles JSONL trace via **lex → parse IR → monotonic line assignment → view lowering** into `V_full` (identity), `V_ui` (5 sections + ranked brief), `V_adapt(b,ρ)` (recall). Pointer invariant `V_ui → V_full[s:e]` via `(#N)` refs.

```
Calibrate cpt → SmartKeep → BuildOwnCut → Normalize → FilterNoise → BuildSections → Brief (1100→2000 tok, 120 lines) → Merge
```

See [`docs/harness.md`](docs/harness.md) for host impact and [`docs/architecture.md`](docs/architecture.md) for pipeline.

## Combining with shake and snapcompact

VCC summarizes **history**; `shake` elides `artifact://` blocks in **kept tail** (disjoint); `snapcompact` is an alternative history archiver (vision bitmaps, needs `model.input includes "image"`). One `CompactionEntry` per trigger — combos are additive or sequential, never double-summarization.

| Trigger | `override` | Result |
| --- | --- | --- |
| threshold, `override:true` (default) | VCC handles; host auto-shakes if still over band (`#rescueCompactionDeadEnd`) | VCC + shake if dead-end |
| threshold, `override:false` | Host walks `methodOrder` (`remote→snapcompact→handoff→shake→soft`) | VCC → snapcompact/shake fallback |
| `/omp-vcc keep:2` | Always VCC (sentinel `__omp_vcc__`) | VCC |
| `/omp-vcc` then `/compact snapcompact` | Sequential | VCC entry, then snapcompact entry |

Additive VCC+shake is automatic. Eager chain: `chainShakeHint:true`. Explicit mode (`snapcompact`/`shake`/`soft`/…) bypasses VCC even when `override:true` (`hook.ts:733`). Full table: [`docs/setup.md`](docs/setup.md) + [`docs/harness.md §8`](docs/harness.md#8-working-with-existing-compaction-strategies).

## Development

```sh
bunx tsc --noEmit
bun test                  # 788 tests, 60 files, 2363 expects, 0 fail
bun test tests/e2e --timeout 120000  # 124 E2E
bun run smoke             # 13 checks: 3 hooks + 6 cmds + 2 tools + dedup (+ pipeline)
omp plugin link . && omp plugin doctor
```

`type:module`, `allowImportingTsExtensions`, `// @ts-nocheck` on vendored `extensions/vcc-core/**`, zero `dist/`. `prepublishOnly` runs `tsc && test && smoke`.

## Verification

```sh
bunx tsc --noEmit && bun test && bun run smoke
omp -e @zhulinchng/omp-vcc
/omp-vcc keep:1   # expect [Session Goal] + toast omp-vcc: kept 1/2 turns
/vcc-stats        # table + history
/vcc-config      # effective config card with per-key source
cat /tmp/omp-vcc-debug.json  # when debug:true
```

Full matrix: [`docs/verification.md`](docs/verification.md). Harness map: [`docs/harness.md §9`](docs/harness.md#9-verification-map-claim--evidence).

## Docs

[`setup`](docs/setup.md) · [`configuration`](docs/configuration.md) · [`architecture`](docs/architecture.md) · [`harness`](docs/harness.md) · [`verification`](docs/verification.md) · [`omp-compaction`](docs/omp-compaction.md) · [`omp-snapcompact`](docs/omp-snapcompact.md) · [`paper-notes`](docs/paper-notes.md) · [`PUBLISHING`](docs/PUBLISHING.md)

Publishing: `npm publish --access public` (unscoped `omp-vcc`), `gh release create vX.Y.Z` → GPR (`@zhulinchng/omp-vcc`). Consumer GPR auth: `@zhulinchng:registry=https://npm.pkg.github.com`.

## License

MIT
