// omp-vcc extension entry — VCC-inspired algorithmic compaction for oh-my-pi
// Factory contract: (pi: ExtensionAPI) => void | Promise<void>
// Implements: session_before_compact hook via ./vcc-core/hook, vcc_recall tool, /omp-vcc and /vcc-recall commands
// Paper: arxiv 2603.29678 §2.2-2.4 — lex→parse IR→line assignment→view lowering (V_full identity, V_ui one-liners, V_adapt rho projection)
// pi-vcc port: sting8k/pi-vcc @0.7.0 — algorithmic, zero-LLM, brief transcript + 5 sections, token-budgeted

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { scaffoldSettings } from "./vcc-core/core/settings";
import {
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
  OMP_VCC_COMPACT_INSTRUCTION,
  getLastCompactionStats,
  scheduleCompactionStatsNotify,
} from "./vcc-core/hook";
import { loadAllMessages } from "./vcc-core/core/load-messages";
import { searchEntriesDetailed, getTouchedFiles } from "./vcc-core/core/search-entries";
import { formatRecallOutput, formatTouchedOutput } from "./vcc-core/core/format-recall";
import { getActiveLineageEntryIds } from "./vcc-core/core/lineage";
import { normalizeRecallScope, normalizeRecallMode, parseRecallScope } from "./vcc-core/core/recall-scope";
import { parseDrillDown, expandEntryFile } from "./vcc-core/core/drill-down";
import { buildPiVccCustomInstructions, parseKeepAndPrompt } from "./vcc-core/core/compact-args";

// Build omp sentinel instructions; keep pi sentinel for backward compat in hook
const buildOmpCustomInstructions = (keepUserTurns: number | null): string => {
  if (keepUserTurns == null) return OMP_VCC_COMPACT_INSTRUCTION;
  return `${OMP_VCC_COMPACT_INSTRUCTION} keep:${keepUserTurns}`;
};

// Helper to parse recall command text: supports `query ... scope:all page:N`
const parseRecallCommandArgs = (
  raw: string,
): { query: string; scope: "lineage" | "all"; page: number } => {
  const parsed = parseRecallScope(raw);
  const pageMatch = parsed.text.match(/\bpage:(\d+)\b/i);
  const page = pageMatch ? Math.max(1, Number.parseInt(pageMatch[1] ?? "1", 10)) : 1;
  const query = parsed.text.replace(/\bpage:\d+\b/i, "").trim();
  return { query, scope: parsed.scope, page };
};

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

export default function (pi: ExtensionAPI): void {
  scaffoldSettings();
  registerBeforeCompactHook(pi);

  // ── vcc_recall tool — implements VCC V_adapt via rho predicate (paper §2.1 eq.2) ──
  // rho = regex if query parses and hits>0 else BM25-like TF-IDF OR (rank.ts). Preserves skeleton + role tags + (f:s-e) pointers.
  // Two modalities: document-oriented (default, temporal) vs index-oriented flat list (mode:touched)
  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Recall",
    description:
      "Recall earlier parts of the current session — decisions made, files touched, commands run, including anything dropped by compaction. Reach for this before telling the user you no longer have the context. Plain keywords work best; a regex pattern is also accepted. Results are paged (page); pass expand with entry indices to read full untruncated content. Use mode:'touched' to list files worked on in this session with their entry indices, and #N:path to drill into a file's content from an entry (#N:path:full for all lines). Note: apply_patch paths (inside the diff payload) and bash redirects do not appear in the touched index. Only the current session is searchable — earlier sessions are not.",
    approval: "read",
    parameters: pi.zod.object({
      query: pi.zod.string().optional().describe("What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works."),
      expand: pi.zod.array(pi.zod.number()).optional().describe("Entry indices to return full untruncated content for"),
      page: pi.zod.number().optional().describe("Page number (1-based) for paginated search results. Default: 1."),
      scope: pi.zod.enum(["lineage", "all", "active"]).optional().describe("Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried."),
      mode: pi.zod.enum(["hybrid", "touched"]).optional().describe("What to show. hybrid (default) = normal search; touched = aggregated files-by-path with entry indices."),
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

      if (q && parseDrillDown(q)) {
        const parsed = parseDrillDown(q);
        if (!parsed) {
          return { content: [{ type: "text", text: "Invalid drill-down query." }], details: undefined };
        }
        if (lineageEntryIds) {
          const { rendered } = loadAllMessages(sessionFile, false, lineageEntryIds);
          const exists = rendered.some((m) => m.index === parsed.index);
          if (!exists) {
            return {
              content: [{ type: "text", text: `Cannot expand indices outside active lineage: ${parsed.index}. Use scope:'all' to reach other branches.` }],
              details: undefined,
            };
          }
        }
        const text = expandEntryFile(sessionFile, parsed.index, parsed.pathPattern, parsed.full, parsed.offset, parsed.limit);
        return { content: [{ type: "text", text }], details: undefined };
      }

      if (normalizeRecallMode(p.mode) === "touched") {
        const { rendered, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
        const touched = getTouchedFiles(rawMessages as unknown[], rendered);
        const text = formatTouchedOutput(touched, p.page);
        return { content: [{ type: "text", text }], details: undefined };
      }

      const expandSet = new Set(p.expand ?? []);
      const hasExpand = expandSet.size > 0;
      if (hasExpand) {
        const { rendered: fullMsgs } = loadAllMessages(sessionFile, true, lineageEntryIds);
        const requested = [...expandSet];
        const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
        const invalid = requested.filter((i) => !Number.isInteger(i) || !byIndex.has(i));
        if (invalid.length > 0) {
          return {
            content: [{ type: "text", text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}` }],
            details: undefined,
          };
        }
        const expanded = requested.map((i) => byIndex.get(i)).filter((m): m is NonNullable<typeof m> => Boolean(m));
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(expanded);
        return { content: [{ type: "text", text: output }], details: undefined };
      }

      const { rendered: msgs, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
      if (q) {
        const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(msgs, rawMessages as unknown[], q);
        const page = Math.max(1, p.page ?? 1);
        const totalPages = Math.ceil(hits.length / PAGE_SIZE);
        const scopeSuffix = scope === "all" ? " (scope: all)" : "";
        const truncationNote = truncated ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results` : "";
        if (hits.length > 0 && page > totalPages) {
          const guidance = truncated ? `Use a page between 1 and ${totalPages}.` : `Use a page between 1 and ${totalPages}, or refine your query.`;
          const text = `Page ${page} is outside the available range 1-${totalPages} (${hits.length} matches${scopeSuffix}${truncationNote}). ${guidance}`;
          return { content: [{ type: "text", text }], details: undefined };
        }
        const start = (page - 1) * PAGE_SIZE;
        const pageResults = hits.slice(start, start + PAGE_SIZE);
        const header = totalPages > 1 ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})` : `${hits.length} matches${scopeSuffix}${truncationNote}`;
        const footer = page < totalPages ? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---` : "";
        const output = formatRecallOutput(pageResults, q, header) + footer;
        return { content: [{ type: "text", text: output }], details: undefined };
      }
      const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(msgs.slice(-DEFAULT_RECENT), q);
      return { content: [{ type: "text", text: output }], details: undefined };
    },
  } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);

  // ── /omp-vcc command — manual algorithmic compaction (V_ui) ──
  pi.registerCommand("omp-vcc", {
    description: "Compact conversation with omp-vcc structured summary (keep:N + optional focus)",
    handler: async (args: string, ctx: unknown) => {
      const c = ctx as {
        compact: (instructions?: string) => Promise<void>;
        ui: { notify: (msg: string, level?: string) => void };
      };
      const parsed = parseKeepAndPrompt(args);
      const keep = parsed.keepUserTurns;
      const followUpPrompt = parsed.followUpPrompt;
      const customInstructions = buildOmpCustomInstructions(keep);
      // Also accept pi sentinel for legacy: map keep via buildPiVcc if needed? Use omp.
      // Notify before compact for UX parity with pi-vcc
      try {
        c.ui.notify(`omp-vcc: compacting with keep:${keep ?? 1}${followUpPrompt ? ` + focus` : ""}...`, "info");
      } catch {}
      try {
        await c.compact(customInstructions);
        const stats = getLastCompactionStats();
        if (stats) {
          scheduleCompactionStatsNotify(c as unknown as { ui: { notify: (msg: string, level?: string) => void } }, stats);
        } else {
          try { c.ui.notify("Compacted with omp-vcc", "info"); } catch {}
        }
        if (followUpPrompt) {
          try {
            const piAny = pi as unknown as { sendUserMessage?: (content: string) => Promise<void> | void };
            if (piAny.sendUserMessage) await piAny.sendUserMessage(followUpPrompt);
          } catch {}
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Compaction cancelled" || msg === "Already compacted") {
          try { c.ui.notify("Nothing to compact", "warning"); } catch {}
        } else {
          try { c.ui.notify(`Compaction failed: ${msg}`, "error"); } catch {}
        }
      }
    },
  });

  // Legacy alias: /pi-vcc — keep for migration, same handler
  pi.registerCommand("pi-vcc", {
    description: "Alias for /omp-vcc (pi-vcc compat)",
    handler: async (args: string, ctx: unknown) => {
      const c = ctx as {
        compact: (instructions?: string) => Promise<void>;
        ui: { notify: (msg: string, level?: string) => void };
      };
      const parsed = parseKeepAndPrompt(args);
      const keep = parsed.keepUserTurns;
      const followUpPrompt = parsed.followUpPrompt;
      const customInstructions = buildPiVccCustomInstructions(keep);
      try {
        await c.compact(customInstructions);
        const stats = getLastCompactionStats();
        if (stats) scheduleCompactionStatsNotify(c as unknown as { ui: { notify: (msg: string, level?: string) => void } }, stats);
        else try { c.ui.notify("Compacted with pi-vcc (via omp-vcc)", "info"); } catch {}
        if (followUpPrompt) {
          try {
            const piAny = pi as unknown as { sendUserMessage?: (content: string) => Promise<void> | void };
            if (piAny.sendUserMessage) await piAny.sendUserMessage(followUpPrompt);
          } catch {}
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Compaction cancelled" || msg === "Already compacted") {
          try { c.ui.notify("Nothing to compact", "warning"); } catch {}
        } else {
          try { c.ui.notify(`Compaction failed: ${msg}`, "error"); } catch {}
        }
      }
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
      const { query, scope, page } = parseRecallCommandArgs(args);
      const lineageEntryIds = scope === "lineage" ? getActiveLineageEntryIds(c.sessionManager as unknown as { getBranch: () => { id?: string }[] }) : undefined;
      const piAny = pi as unknown as { sendMessage?: (msg: unknown, opts?: unknown) => void };
      if (!query) {
        const { rendered } = loadAllMessages(sessionFile, false, lineageEntryIds);
        const recent = rendered.slice(-DEFAULT_RECENT);
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
        try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
        try { c.ui.notify(`vcc_recall: ${recent.length} recent`, "info"); } catch {}
        return;
      }
      const { rendered, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
      const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(rendered, rawMessages as unknown[], query);
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
      const output = formatRecallOutput(pageResults, query, header) + footer;
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
      const { query, scope, page } = parseRecallCommandArgs(args);
      const lineageEntryIds = scope === "lineage" ? getActiveLineageEntryIds(c.sessionManager as unknown as { getBranch: () => { id?: string }[] }) : undefined;
      const piAny = pi as unknown as { sendMessage?: (msg: unknown, opts?: unknown) => void };
      const { rendered, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
      if (!query) {
        const { rendered: r } = loadAllMessages(sessionFile, false, lineageEntryIds);
        const recent = r.slice(-DEFAULT_RECENT);
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
        try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
        return;
      }
      const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(rendered, rawMessages as unknown[], query);
      const totalPages = Math.ceil(hits.length / PAGE_SIZE);
      const scopeSuffix = scope === "all" ? " (scope: all)" : "";
      const scopeArg = scope === "all" ? " scope:all" : "";
      const truncationNote = truncated ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results` : "";
      const start = (page - 1) * PAGE_SIZE;
      const pageResults = hits.slice(start, start + PAGE_SIZE);
      const header = totalPages > 1 ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})` : `${hits.length} matches${scopeSuffix}${truncationNote}`;
      const footer = page < totalPages ? `\n--- /pi-vcc-recall ${query}${scopeArg} page:${page + 1} ---` : "";
      const output = formatRecallOutput(pageResults, query, header) + footer;
      try { piAny.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
    },
  });
}
// ── Re-exports for pi-vcc test compatibility (not dead: tests import via hook directly,
// but external consumers and the `vcc-recall` shim may import via main) ──
export { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION, OMP_VCC_COMPACT_INSTRUCTION, getLastCompactionStats, scheduleCompactionStatsNotify, formatCompactionStats, AUTO_CONTINUE_CUSTOM_TYPE, LEGACY_AUTO_CONTINUE_CUSTOM_TYPE, invalidExpandIndices, registerRecallTool, registerVccRecallCommand, registerPiVccCommand } from "./vcc-core/hook";
export { buildPiVccCustomInstructions, parseKeepAndPrompt } from "./vcc-core/core/compact-args";
