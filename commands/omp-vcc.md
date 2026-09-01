---
description: Compact conversation with omp-vcc structured summary (keep:N + optional focus)
---

# /omp-vcc

Algorithmic VCC compaction — fast lossless no-LLM. Registered by `@zhulinchng/omp-vcc` extension.

Usage:

- `/omp-vcc` — compact with default keep:1 (smart-keep may boost to keep:N up to 25k tokens)
- `/omp-vcc keep:2` — keep last 2 user turns, summarize the rest
- `/omp-vcc keep:0` — compact all (no tail, sentinel firstKeptEntryId="")
- `/omp-vcc focus text` — compact with additional focus instructions for the summary
- `/omp-vcc keep:2 focus text` — both

This command is handled by the `omp-vcc` extension (`extensions/main.ts`). It delegates to the VCC pipeline (calibrate → smart-keep → budget-cut → normalize → filter-noise → build-sections → brief transcript → format → merge) and writes a structured summary with `[Session Goal]` / `[Files And Changes]` / `[Brief transcript]` sections.

Arguments: `$ARGUMENTS`
