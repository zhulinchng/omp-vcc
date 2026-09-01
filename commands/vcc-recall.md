---
description: Recall earlier parts of this session via ranked search (V_adapt)
---

# /vcc-recall

Search compacted history — implements VCC `V_adapt` with rho predicate (regex or BM25-like ranked OR).

Registered by `@zhulinchng/omp-vcc` extension.

Usage:

- `/vcc-recall` — show 25 most recent entries
- `/vcc-recall auth token` — keyword search (OR-ranked, TF-IDF)
- `/vcc-recall "hook|inject" scope:all` — regex search across all branches
- `/vcc-recall cache page:2` — paginated results (5 per page)
- `vcc_recall` tool: `{"query":"redis cache","scope":"all","page":1}` — same engine, also supports `mode:'touched'` for file index and `expand:[12,34]` or `#12:path` drill-down

The tool preserves VCC invariants: role tags, line range pointers `(#N)`, and progressive disclosure `V_ui → V_adapt → V_full[s:e]`.

Arguments: `$ARGUMENTS`
