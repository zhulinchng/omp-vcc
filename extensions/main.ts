// omp-vcc extension entry — VCC-inspired algorithmic compaction for oh-my-pi
// Factory contract: (pi: ExtensionAPI) => void | Promise<void>
// Implements: session_before_compact hook via ./vcc-core/hook, vcc_recall tool, /omp-vcc and /vcc-recall commands
// Paper: arxiv 2603.29678 §2.2-2.4 — lex→parse IR→line assignment→view lowering (V_full identity, V_ui one-liners, V_adapt rho projection)
// pi-vcc port: sting8k/pi-vcc @0.7.0 — algorithmic, zero-LLM, brief transcript + 5 sections, token-budgeted

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { scaffoldSettings, loadSettings, loadSettingsWithPluginOverlay } from "./vcc-core/core/settings";
import { migrateStalePluginEntries } from "./vcc-core/core/migrate-stale";
import { loadAllMessages } from "./vcc-core/core/load-messages";
import {
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
  OMP_VCC_COMPACT_INSTRUCTION,
  getLastCompactionStats,
  getCompactionHistory,
  formatLastStatsDetail,
  formatStatsTable,
  scheduleCompactionStatsNotify,
  registerVccStatsTool as registerVccStatsToolHook,
  registerVccStatsCommand as registerVccStatsCommandHook,
  registerVccConfigCommand as registerVccConfigCommandHook,
  invalidExpandIndices,
  getCompactForm,
} from "./vcc-core/hook";
import { searchEntriesDetailed, getTouchedFiles } from "./vcc-core/core/search-entries";
import { formatRecallOutput, formatTouchedOutput } from "./vcc-core/core/format-recall";
import { getActiveLineageEntryIds } from "./vcc-core/core/lineage";
import { normalizeRecallScope, normalizeRecallMode, parseRecallScope, parseRecallMode } from "./vcc-core/core/recall-scope";
import { parseDrillDown, expandEntryFile, parseEntryRef, expandEntry } from "./vcc-core/core/drill-down";
import { capRecallBlocks, type RecallBudgetBlock } from "./vcc-core/core/recall-budget";
import { buildPiVccCustomInstructions, parseKeepAndPrompt } from "./vcc-core/core/compact-args";

// Build omp sentinel instructions; keep pi sentinel for backward compat in hook
const buildOmpCustomInstructions = (keepUserTurns: number | null): string => {
  if (keepUserTurns == null) return OMP_VCC_COMPACT_INSTRUCTION;
  return `${OMP_VCC_COMPACT_INSTRUCTION} keep:${keepUserTurns}`;
};

// Helper to parse recall command text: supports `query ... scope:all page:N`
const parseRecallCommandArgs = (
  raw: string,
): { query: string; scope: "lineage" | "all"; mode: "hybrid" | "touched" | "file"; page: number } => {
  const scoped = parseRecallScope(raw);
  const parsed = parseRecallMode(scoped.text);
  const pageMatch = parsed.text.match(/\bpage:(\d+)\b/i);
  const page = pageMatch ? Math.max(1, Number.parseInt(pageMatch[1] ?? "1", 10)) : 1;
  const query = parsed.text.replace(/\bpage:\d+\b/i, "").trim();
  return { query, scope: scoped.scope, mode: normalizeRecallMode(parsed.mode), page };
};

const capModelRecall = (settings: { recallResponseMaxChars: number }, blocks: Array<RecallBudgetBlock | string>, blockKind = "entry"): string =>
  capRecallBlocks(blocks, settings.recallResponseMaxChars, { blockKind });
const loadRecallMessages = (ctx: unknown, sessionFile: string, full: boolean, lineageEntryIds?: Set<string>) =>
  loadAllMessages(sessionFile, full, lineageEntryIds, (event) => {
    if (!loadSettings(ctx).debug) return;
    try {
      (ctx as any)?.ui?.notify?.(`omp-vcc: ${event.kind} (${event.parseErrors} malformed lines)`, "warning");
    } catch {}
  });

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;
export default function (pi: ExtensionAPI): void {
  scaffoldSettings();
  try {
    migrateStalePluginEntries();
  } catch {}
  registerBeforeCompactHook(pi);

  // ── vcc_recall tool — implements VCC V_adapt via rho predicate (paper §2.1 eq.2) ──
  // rho = regex if query parses and hits>0 else BM25-like TF-IDF OR (rank.ts). Preserves skeleton + role tags + (f:s-e) pointers.
  // Two modalities: document-oriented (default, temporal) vs index-oriented flat list (mode:touched)
  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Recall",
    description:
      "Recall earlier parts of the current session — decisions made, files touched, commands run, including anything dropped by compaction. Reach for this before telling the user you no longer have the context. Plain keywords work best; a regex pattern is also accepted. Results are paged (page); pass expand with entry indices to read full untruncated content. Use mode:'touched' to list files worked on in this session with their entry indices, mode:'file' to search only file tool arguments, and #N:path to drill into a file's content from an entry (#N:path:full for all lines). Note: apply_patch paths (inside the diff payload) and bash redirects do not appear in the touched index. Only the current session is searchable — earlier sessions are not.",
    approval: "read",
    parameters: pi.zod.object({
      query: pi.zod.string().optional().describe("What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works."),
      expand: pi.zod.array(pi.zod.number()).optional().describe("Entry indices to return full untruncated content for"),
      page: pi.zod.number().optional().describe("Page number (1-based) for paginated search results. Default: 1."),
      scope: pi.zod.enum(["lineage", "all", "active"]).optional().describe("Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried."),
      mode: pi.zod.enum(["hybrid", "touched", "file"]).optional().describe("What to show. hybrid (default) = normal search; touched = aggregated files-by-path; file = only file tool arguments."),
    }),
    async execute(_toolCallId: string, params: unknown, _signal: unknown, _onUpdate: unknown, ctx: unknown) {
      const p = params as {
        query?: string;
        expand?: number[];
        page?: number;
        scope?: string;
        mode?: string;
      };
      const c = ctx as {
        sessionManager?: { getSessionFile?: () => string | undefined; getBranch?: () => unknown[]; getEntries?: () => unknown[] };
      };
      const settings = await loadSettingsWithPluginOverlay(ctx);
      const sessionFile = c.sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "No session file available." }],
          details: undefined,
        };
      }
      const rawScope = p.scope === "active" ? "lineage" : p.scope;
      const scope = normalizeRecallScope(rawScope);
      const lineageEntryIds = scope === "lineage" ? getActiveLineageEntryIds(c.sessionManager as unknown as { getBranch: () => { id?: string }[] }) : undefined;

      const q = p.query?.trim();
      const mode = normalizeRecallMode(p.mode);
      const bounded = (text: string, id: string | number, kind = "entry"): string => capModelRecall(settings, [{ id, text }], kind);

      const entryRef = q ? parseEntryRef(q) : null;
      if (entryRef) {
        const ref = entryRef;
        if (lineageEntryIds) {
          const { rendered } = loadRecallMessages(ctx, sessionFile, false, lineageEntryIds);
          const exists = rendered.some((m) => m.index === ref.index);
          if (!exists) {
            return {
              content: [{ type: "text", text: `Cannot expand indices outside active lineage: ${ref.index}. Use scope:'all' to reach other branches.` }],
              details: undefined,
            };
          }
        }
        const text = expandEntry(sessionFile, ref.index, ref.full, ref.offset, ref.limit);
        return { content: [{ type: "text", text: bounded(text, `#${ref.index}`) }], details: undefined };
      }
      const textMatch = q?.match(/^#(\d+):text(?::(full|\d+(?::\d+)?))?$/);
      if (textMatch) {
        const index = Number.parseInt(textMatch[1] ?? "0", 10);
        const suffix = textMatch[2];
        const full = suffix === "full";
        const parts = suffix && !full ? suffix.split(":") : [];
        const offset = parts[0] !== undefined ? Number.parseInt(parts[0], 10) : undefined;
        const limit = parts[1] !== undefined ? Number.parseInt(parts[1], 10) : undefined;
        if (lineageEntryIds) {
          const { rendered } = loadRecallMessages(ctx, sessionFile, false, lineageEntryIds);
          if (!rendered.some((m) => m.index === index)) {
            return { content: [{ type: "text", text: `Cannot expand indices outside active lineage: ${index}. Use scope:'all' to reach other branches.` }], details: undefined };
          }
        }
        const text = expandEntry(sessionFile, index, full, offset, limit);
        return { content: [{ type: "text", text: bounded(text, `#${index}:text`) }], details: undefined };
      }

      const drill = q ? parseDrillDown(q) : null;
      if (drill) {
        const parsed = drill;
        if (lineageEntryIds) {
          const { rendered } = loadRecallMessages(ctx, sessionFile, false, lineageEntryIds);
          const exists = rendered.some((m) => m.index === parsed.index);
          if (!exists) {
            return {
              content: [{ type: "text", text: `Cannot expand indices outside active lineage: ${parsed.index}. Use scope:'all' to reach other branches.` }],
              details: undefined,
            };
          }
        }
        const text = expandEntryFile(sessionFile, parsed.index, parsed.pathPattern, parsed.full, parsed.offset, parsed.limit);
        return { content: [{ type: "text", text: bounded(text, `#${parsed.index}:path`) }], details: undefined };
      }

      if (mode === "touched") {
        const { rendered, rawMessages } = loadRecallMessages(ctx, sessionFile, false, lineageEntryIds);
        const touched = getTouchedFiles(rawMessages as unknown[], rendered);
        const text = formatTouchedOutput(touched, p.page);
        return { content: [{ type: "text", text: bounded(text, `page:${p.page ?? 1}`, "page") }], details: undefined };
      }
      if (mode === "file" && !q) {
        const { rendered, rawMessages } = loadRecallMessages(ctx, sessionFile, false, lineageEntryIds);
        const { hits } = searchEntriesDetailed(rendered, rawMessages as unknown[], undefined, { mode });
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(hits);
        return { content: [{ type: "text", text: capModelRecall(settings, [{ id: "file", text: output }], "file") }], details: undefined };
      }

      const expandSet = new Set(p.expand ?? []);
      const hasExpand = expandSet.size > 0;
      if (hasExpand) {
        const { rendered: fullMsgs } = loadRecallMessages(ctx, sessionFile, true, lineageEntryIds);
        const requested = [...expandSet];
        const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
        const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
        if (invalid.length > 0) {
          return {
            content: [{ type: "text", text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}` }],
            details: undefined,
          };
        }
        const expanded = requested.map((i) => byIndex.get(i)).filter((m): m is NonNullable<typeof m> => Boolean(m));
        const blocks = expanded.map((entry) => ({ id: `#${entry.index}`, text: formatRecallOutput([entry]) }));
        const output = (scope === "all" ? "Scope: all\n\n" : "") + capModelRecall(settings, blocks, "entry");
        return { content: [{ type: "text", text: output }], details: undefined };
      }

      const { rendered: msgs, rawMessages } = loadRecallMessages(ctx, sessionFile, false, lineageEntryIds);
      if (q) {
        const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(msgs, rawMessages as unknown[], q, { mode });
        const page = Math.max(1, p.page ?? 1);
        const totalPages = Math.ceil(hits.length / PAGE_SIZE);
        const scopeSuffix = scope === "all" ? " (scope: all)" : "";
        const truncationNote = truncated ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results` : "";
        if (hits.length > 0 && page > totalPages) {
          const guidance = truncated ? `Use a page between 1 and ${totalPages}.` : `Use a page between 1 and ${totalPages}, or refine your query.`;
          const text = `Page ${page} is outside the available range 1-${totalPages} (${hits.length} matches${scopeSuffix}${truncationNote}). ${guidance}`;
          return { content: [{ type: "text", text: bounded(text, `page:${page}`, "page") }], details: undefined };
        }
        const start = (page - 1) * PAGE_SIZE;
        const pageResults = hits.slice(start, start + PAGE_SIZE);
        const header = totalPages > 1 ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})` : `${hits.length} matches${scopeSuffix}${truncationNote}`;
        const footer = page < totalPages ? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---` : "";
        const output = formatRecallOutput(pageResults, q, header, { truncated, totalBeforeCap }) + footer;
        return { content: [{ type: "text", text: bounded(output, `page:${page}`, "page") }], details: undefined };
      }
      const recent = msgs.slice(-DEFAULT_RECENT);
      const blocks = recent.map((entry) => ({ id: `#${entry.index}`, text: formatRecallOutput([entry]) }));
      const output = (scope === "all" ? "Scope: all\n\n" : "") + capModelRecall(settings, blocks, "entry");
      return { content: [{ type: "text", text: output }], details: undefined };
    },
  } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
  // ── vcc_stats tool — stats surface for savings (paper § verification) ──
  registerVccStatsToolHook(pi);

  // Shared /omp-vcc + /pi-vcc runner. The two hosts expose incompatible
  // ctx.compact shapes, so the call form branches per live ctx:
  // - omp: compact(string | CompactOptions) => Promise<void>; instructions
  //   ride the string (the host splits string|object and drops instructions
  //   from the object form), completion = awaited resolution, errors throw
  //   ("Compaction cancelled" / "Already compacted" / "Nothing to compact…").
  // - pi: compact(CompactOptions) => void; instructions ONLY via
  //   options.customInstructions (a bare string reads as undefined), outcome
  //   arrives via onComplete/onError. `settled` keeps one outcome.
  // Form detection is layered (explicit test override → getSystemPrompt
  // shape → module scope → legacy omp default) so bundled runtimes without
  // module scope still decide correctly off the live ctx.
  const runCompactCommand = async (
    args: string,
    c: {
      compact: (arg?: unknown) => Promise<void> | void;
      ui: { notify: (msg: string, level?: string) => void };
    },
    buildInstructions: (keep: number | null) => string,
    fallbackToast: string,
    preNotify: boolean,
    compactForm: "object" | "string",
  ): Promise<void> => {
    const parsed = parseKeepAndPrompt(args);
    const keep = parsed.keepUserTurns;
    const followUpPrompt = parsed.followUpPrompt;
    const customInstructions = buildInstructions(keep);
    if (preNotify) {
      try {
        c.ui.notify(`omp-vcc: compacting with keep:${keep ?? 1}${followUpPrompt ? ` + focus` : ""}...`, "info");
      } catch {}
    }
    let settled = false;
    const finishOk = (): void => {
      if (settled) return;
      settled = true;
      const stats = getLastCompactionStats(pi);
      if (stats) {
        scheduleCompactionStatsNotify(pi, c as unknown as { ui: { notify: (msg: string, level?: string) => void } }, stats);
      } else {
        try { c.ui.notify(fallbackToast, "info"); } catch {}
      }
      if (followUpPrompt) {
        try {
          const piAny = pi as unknown as { sendUserMessage?: (content: string) => unknown };
          const sent = piAny.sendUserMessage?.(followUpPrompt) as Promise<void> | undefined;
          if (sent && typeof sent.catch === "function") sent.catch(() => {});
        } catch {}
      }
    };
    const finishErr = (err: unknown): void => {
      if (settled) return;
      settled = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "Compaction cancelled" || msg === "Already compacted" || msg.startsWith("Nothing to compact")) {
        try { c.ui.notify("Nothing to compact", "warning"); } catch {}
      } else {
        try { c.ui.notify(`Compaction failed: ${msg}`, "error"); } catch {}
      }
    };
    if (compactForm === "object") {
      try {
        c.compact({ customInstructions, onComplete: finishOk, onError: finishErr });
      } catch (err: unknown) {
        finishErr(err);
      }
      return;
    }
    try {
      await c.compact(customInstructions);
      finishOk();
    } catch (err: unknown) {
      finishErr(err);
    }
  };

  pi.registerCommand("omp-vcc", {
    description: "Compact conversation with omp-vcc structured summary (keep:N + optional focus)",
    handler: async (args: string, ctx: unknown) => {
      const c = ctx as {
        compact: (options?: unknown) => Promise<void> | void;
        ui: { notify: (msg: string, level?: string) => void };
        getSystemPrompt?: () => unknown;
      };
      await runCompactCommand(args, c, buildOmpCustomInstructions, "Compacted with omp-vcc", true, getCompactForm(() => c.getSystemPrompt?.()));
    },
  });

  // Legacy alias: /pi-vcc — keep for migration, same handler
  pi.registerCommand("pi-vcc", {
    description: "Alias for /omp-vcc (pi-vcc compat)",
    handler: async (args: string, ctx: unknown) => {
      const c = ctx as {
        compact: (options?: unknown) => Promise<void> | void;
        ui: { notify: (msg: string, level?: string) => void };
        getSystemPrompt?: () => unknown;
      };
      await runCompactCommand(args, c, buildPiVccCustomInstructions, "Compacted with pi-vcc (via omp-vcc)", false, getCompactForm(() => c.getSystemPrompt?.()));
    },
  });

  // ── /vcc-recall command — search compacted history (V_adapt) ──
  pi.registerCommand("vcc-recall", {
    description: "Recall earlier parts of this session. Plain keywords work best; add scope:all to reach edited or retried turns.",
    handler: async (args: string, ctx: unknown) => {
      const c = ctx as {
        sessionManager?: { getSessionFile?: () => string | undefined; getBranch?: () => { id?: string }[] };
        ui: { notify: (msg: string, level?: string) => void };
      };
      const sessionFile = c.sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        try { c.ui.notify("No session file available.", "error"); } catch {}
        return;
      }
      const { query, scope, mode, page } = parseRecallCommandArgs(args);
      const lineageEntryIds = scope === "lineage" ? getActiveLineageEntryIds(c.sessionManager as unknown as { getBranch: () => { id?: string }[] }) : undefined;
      const piAny = pi as unknown as { sendMessage?: (msg: unknown, opts?: unknown) => void };
      if (!query) {
        const { rendered, rawMessages } = loadRecallMessages(ctx, sessionFile, false, lineageEntryIds);
        if (mode === "file") {
          const { hits } = searchEntriesDetailed(rendered, rawMessages as unknown[], undefined, { mode });
          const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(hits);
          try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
          return;
        }
        if (mode === "touched") {
          const output = formatTouchedOutput(getTouchedFiles(rawMessages as unknown[], rendered), page);
          try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
          return;
        }
        const recent = rendered.slice(-DEFAULT_RECENT);
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
        try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
        try { c.ui.notify(`vcc_recall: ${recent.length} recent`, "info"); } catch {}
        return;
      }
      const { rendered, rawMessages } = loadRecallMessages(ctx, sessionFile, false, lineageEntryIds);
      const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(rendered, rawMessages as unknown[], query, { mode });
      const totalPages = Math.ceil(hits.length / PAGE_SIZE);
      const scopeSuffix = scope === "all" ? " (scope: all)" : "";
      const scopeArg = scope === "all" ? " scope:all" : "";
      const truncationNote = truncated ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results` : "";
      if (hits.length > 0 && page > totalPages) {
        const guidance = truncated ? `Use /vcc-recall ${query}${scopeArg} page:N with N between 1 and ${totalPages}.` : `Use /vcc-recall ${query}${scopeArg} page:N with N between 1 and ${totalPages}, or refine your query.`;
        const text = `Page ${page} is outside the available range 1-${totalPages} (${hits.length} matches${scopeSuffix}${truncationNote}). ${guidance}`;
        try { piAny.sendMessage?.({ customType: "vcc-recall", content: text, display: true }, { triggerTurn: false }); } catch {}
        return;
      }
      const start = (page - 1) * PAGE_SIZE;
      const pageResults = hits.slice(start, start + PAGE_SIZE);
      const header = totalPages > 1 ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})` : `${hits.length} matches${scopeSuffix}${truncationNote}`;
      const footer = page < totalPages ? `\n--- /vcc-recall ${query}${scopeArg} page:${page + 1} ---` : "";
      const output = formatRecallOutput(pageResults, query, header, { truncated, totalBeforeCap }) + footer;
      try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
      try { c.ui.notify(`vcc_recall: ${hits.length} hits`, "info"); } catch {}
    },
  });

  // Alias: /pi-vcc-recall
  pi.registerCommand("pi-vcc-recall", {
    description: "Alias for /vcc-recall",
    handler: async (args: string, ctx: unknown) => {
      const c = ctx as {
        sessionManager?: { getSessionFile?: () => string | undefined; getBranch?: () => { id?: string }[] };
        ui: { notify: (msg: string, level?: string) => void };
      };
      const sessionFile = c.sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        try { c.ui.notify("No session file available.", "error"); } catch {}
        return;
      }
      const { query, scope, mode, page } = parseRecallCommandArgs(args);
      const lineageEntryIds = scope === "lineage" ? getActiveLineageEntryIds(c.sessionManager as unknown as { getBranch: () => { id?: string }[] }) : undefined;
      const piAny = pi as unknown as { sendMessage?: (msg: unknown, opts?: unknown) => void };
      const { rendered, rawMessages } = loadRecallMessages(ctx, sessionFile, false, lineageEntryIds);
      if (!query) {
        if (mode === "file") {
          const { hits } = searchEntriesDetailed(rendered, rawMessages as unknown[], undefined, { mode });
          const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(hits);
          try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
          return;
        }
        if (mode === "touched") {
          const output = formatTouchedOutput(getTouchedFiles(rawMessages as unknown[], rendered), page);
          try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
          return;
        }
        const recent = rendered.slice(-DEFAULT_RECENT);
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
        try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
        return;
      }
      const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(rendered, rawMessages as unknown[], query, { mode });
      const totalPages = Math.ceil(hits.length / PAGE_SIZE);
      const scopeSuffix = scope === "all" ? " (scope: all)" : "";
      const scopeArg = scope === "all" ? " scope:all" : "";
      const truncationNote = truncated ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results` : "";
      if (hits.length > 0 && page > totalPages) {
        const guidance = truncated ? `Use /pi-vcc-recall ${query}${scopeArg} page:N with N between 1 and ${totalPages}.` : `Use /pi-vcc-recall ${query}${scopeArg} page:N with N between 1 and ${totalPages}, or refine your query.`;
        const text = `Page ${page} is outside the available range 1-${totalPages} (${hits.length} matches${scopeSuffix}${truncationNote}). ${guidance}`;
        try { piAny.sendMessage?.({ customType: "vcc-recall", content: text, display: true }, { triggerTurn: false }); } catch {}
        return;
      }
      const start = (page - 1) * PAGE_SIZE;
      const pageResults = hits.slice(start, start + PAGE_SIZE);
      const header = totalPages > 1 ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})` : `${hits.length} matches${scopeSuffix}${truncationNote}`;
      const footer = page < totalPages ? `\n--- /pi-vcc-recall ${query}${scopeArg} page:${page + 1} ---` : "";
      const output = formatRecallOutput(pageResults, query, header, { truncated, totalBeforeCap }) + footer;

      try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
    },
  });
  // ── /vcc-stats commands — show savings table (PR3) ──
  registerVccStatsCommandHook(pi);
  registerVccConfigCommandHook(pi);

}
// ── Re-exports for test compatibility (hook-owned API only; the duplicate
// recall/pi-vcc registrars were deleted — the factory is the single source) ──
export { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION, OMP_VCC_COMPACT_INSTRUCTION, getLastCompactionStats, getCompactionHistory, formatCompactionStats, formatStatsTable, formatLastStatsDetail, scheduleCompactionStatsNotify, AUTO_CONTINUE_CUSTOM_TYPE, LEGACY_AUTO_CONTINUE_CUSTOM_TYPE, invalidExpandIndices, registerVccStatsTool, registerVccStatsCommand, registerVccConfigCommand, clearCompactionHistoryForTests } from "./vcc-core/hook";
export { buildPiVccCustomInstructions, parseKeepAndPrompt } from "./vcc-core/core/compact-args";
