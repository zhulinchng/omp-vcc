// @ts-nocheck
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createRequire } from "node:module";
import { writeFileSync } from "fs";
import { compileRanked } from "./core/summarize";
import { buildPiVccCustomInstructions, parseKeepAndPrompt, PI_VCC_COMPACT_INSTRUCTION } from "./core/compact-args";
import { loadSettings, type PiVccSettings } from "./core/settings";
import { calibrateCharsPerToken, estimateMessageContentChars, estimateMessageContentTokens, estimateTokensFromChars, collectUsageStats } from "./core/token-estimate";
import type { PiVccCompactionDetails } from "./details";
import type { CompactionReason } from "./types";
import { loadAllMessages as _loadAllMessages } from "./core/load-messages";
import { searchEntriesDetailed as _searchEntriesDetailed, getTouchedFiles as _getTouchedFiles } from "./core/search-entries";
import { formatRecallOutput as _formatRecallOutput, formatTouchedOutput as _formatTouchedOutput } from "./core/format-recall";
import { getActiveLineageEntryIds as _getActiveLineageEntryIds } from "./core/lineage";
import { normalizeRecallScope as _normalizeRecallScope, normalizeRecallMode as _normalizeRecallMode, parseRecallScope as _parseRecallScope } from "./core/recall-scope";
import { parseDrillDown as _parseDrillDown, expandEntryFile as _expandEntryFile, parseEntryRef as _parseEntryRef, expandEntry as _expandEntry } from "./core/drill-down";

// convertToLlm shim: try host export, fallback to identity (preserves AgentMessage for omp compileRanked)
let convertToLlm: (messages: any[]) => any[] = (m) => m;
try {
  const req = createRequire(import.meta.url);
  const mod = req("@oh-my-pi/pi-coding-agent/session/messages") as any;
  if (mod?.convertToLlm) convertToLlm = mod.convertToLlm;
} catch {}
try {
  if (convertToLlm.length === 0 || (convertToLlm as any).toString().includes("=> m")) {
    const req2 = createRequire(import.meta.url);
    const mod2 = req2("@oh-my-pi/pi-coding-agent") as any;
    if (mod2?.convertToLlm) convertToLlm = mod2.convertToLlm;
  }
} catch {}

export { PI_VCC_COMPACT_INSTRUCTION } from "./core/compact-args";
export const OMP_VCC_COMPACT_INSTRUCTION = "__omp_vcc__";
// Accept both pi and omp sentinels for backwards compat
const isVccSentinel = (s: string | undefined) => s === PI_VCC_COMPACT_INSTRUCTION || s === OMP_VCC_COMPACT_INSTRUCTION;

export interface CompactionStats {
  summarized: number;
  kept: number;
  keptUserTurns: number;
  totalUserTurns: number;
  requestedKeepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  keepFallbackToCompactAll: boolean;
  /** Set when the tail came from a token-budget cut instead of a user-turn cut. */
  budgetCut?: BudgetCutKind;
  keptTokensEst: number;
  /** True when smart-keep boosted the default keep beyond 1. */
  smartKeepAdjusted?: boolean;
  /** Base keep before smart adjustment (for toast like "1→3"). */
  smartFromKeep?: number;
  reason?: CompactionReason;
  willRetry?: boolean;
  /** Tokens before compaction (from preparation). */
  tokensBefore?: number;
  /** Summary char length */
  summaryChars?: number;
  /** Summary tokens estimate via calibrated cpt */
  summaryTokensEst?: number;
  /** Estimated tokens after = summaryTokensEst + keptTokensEst */
  tokensAfterEst?: number;
  /** Authoritative tokensAfter from host (compactionEntry) */
  tokensAfter?: number;
  /** Estimated saved = tokensBefore - tokensAfterEst */
  tokensSavedEst?: number;
  /** Authoritative saved */
  tokensSaved?: number;
  /** Estimated percent 0-100 */
  savedPercentEst?: number;
  /** Authoritative percent */
  savedPercent?: number;
  /** When compaction occurred */
  timestamp?: number;
}

export type BudgetCutKind = "no_anchor" | "oversized_tail";
export const OVERSIZED_TAIL_FACTOR = 2.5;

let lastStats: CompactionStats | null = null;
let lastCompactWasPiVcc = false;
let pendingFollowUpPrompt: string | null = null;
let pendingAutoContinueTimer: any = null;
let globalHistory: CompactionStats[] = [];
// Per-pi state to avoid cross-session pollution when multiple sessions share the
// same ESM module singleton (e.g. main + subagents). Module globals remain as
// fallback for host-free tests that call getLastCompactionStats() without a pi.
const perPi = new WeakMap<any, { lastStats: CompactionStats | null; lastCompactWasPiVcc: boolean; pendingFollowUpPrompt: string | null; pendingAutoContinueTimer: any; statsHistory: CompactionStats[] }>();
// Track strong refs for test helper clearCompactionHistoryForTests: WeakMap keys
// cannot be enumerated, so keep a Set for test-only cleanup.
const perPiKeys = new Set<any>();
// Guard eager chainShakeHint to avoid recursion: tracks pis currently chaining.
const pendingChainShake = new WeakSet<object>();
const getPerPi = (pi: any) => {
  if (!pi || typeof pi !== "object") return null;
  let s = perPi.get(pi);
  if (!s) { s = { lastStats: null, lastCompactWasPiVcc: false, pendingFollowUpPrompt: null, pendingAutoContinueTimer: null, statsHistory: [] }; perPi.set(pi, s); perPiKeys.add(pi); }
  if (!s.statsHistory) s.statsHistory = [];
  return s;
};
const setLastStats = (pi: any, v: CompactionStats | null) => {
  if (v && v.timestamp == null) v.timestamp = Date.now();
  lastStats = v;
  const s = getPerPi(pi);
  if (s) {
    s.lastStats = v;
    if (v) {
      s.statsHistory.push(v);
      if (s.statsHistory.length > 50) s.statsHistory.shift();
    }
  }
  if (v) {
    globalHistory.push(v);
    if (globalHistory.length > 50) globalHistory.shift();
  }
};
const setLastCompactWasPiVcc = (pi: any, v: boolean) => { lastCompactWasPiVcc = v; const s = getPerPi(pi); if (s) s.lastCompactWasPiVcc = v; };
const setPendingFollowUpPrompt = (pi: any, v: string | null) => { pendingFollowUpPrompt = v; const s = getPerPi(pi); if (s) s.pendingFollowUpPrompt = v; };
const getPendingFollowUpPrompt = (pi: any) => { const s = getPerPi(pi); return s ? s.pendingFollowUpPrompt : pendingFollowUpPrompt; };
const clearPendingAutoContinueForPi = (pi: any) => {
  const s = getPerPi(pi);
  clearTimeout(s ? s.pendingAutoContinueTimer as any : pendingAutoContinueTimer as any);
  clearTimeout(pendingAutoContinueTimer as any);
  pendingAutoContinueTimer = null;
  if (s) s.pendingAutoContinueTimer = null;
};
const scheduleAutoContinueForPi = (pi: any) => {
  clearPendingAutoContinueForPi(pi);
  const s = getPerPi(pi);
  const timer: any = setTimeout(() => {
    pendingAutoContinueTimer = null;
    if (s) s.pendingAutoContinueTimer = null;
    try { triggerInvisibleContinue(pi); } catch {}
  }, 0);
  pendingAutoContinueTimer = timer;
  if (s) s.pendingAutoContinueTimer = timer;
};
// the LLM context with a user-visible continue prompt. triggerInvisibleContinue
// sends a custom message marked with a dedicated customType (content:[],
// display:false, triggerTurn:true, deliverAs:'followUp') so Pi's queue/busy-state
// stays coherent; the on('context') filter registered in registerBeforeCompactHook
// removes that message (by customType ONLY) from the LLM payload — the model
// simply continues from the compaction summary.
//
// Ported from monotykamary/pi-vcc branch 'tom'
// (https://github.com/monotykamary/pi-vcc, MIT) — a pi-vcc derivative.
export const AUTO_CONTINUE_CUSTOM_TYPE = "omp-vcc-auto-continue";
export const LEGACY_AUTO_CONTINUE_CUSTOM_TYPE = "pi-vcc-auto-continue";

export const triggerInvisibleContinue = (pi: ExtensionAPI): void => {
  pi.sendMessage(
    {
      customType: AUTO_CONTINUE_CUSTOM_TYPE,
      content: [],
      display: false,
      details: undefined,
    },
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );
};

const clearPendingAutoContinue = () => {
  clearTimeout(pendingAutoContinueTimer as any);
  pendingAutoContinueTimer = null;
};

const scheduleAutoContinue = (pi: any) => {
  clearPendingAutoContinue();
  pendingAutoContinueTimer = setTimeout(() => {
    pendingAutoContinueTimer = null;
    try {
      triggerInvisibleContinue(pi);
    } catch {}
  }, 0);
};

export const getLastCompactionStats = (pi?: any) => {
  if (pi) {
    const s = getPerPi(pi);
    return s?.lastStats ?? null;
  }
  return lastStats;
};
const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

export const formatCompactionStats = (stats: CompactionStats): string => {
  const before = stats.tokensBefore ?? 0;
  const after = stats.tokensAfter ?? stats.tokensAfterEst ?? 0;
  const savedRaw = stats.tokensSaved ?? stats.tokensSavedEst;
  const saved = typeof savedRaw === "number" ? savedRaw : (before > 0 && after > 0 ? Math.max(0, before - after) : 0);
  const percentRaw = stats.savedPercent ?? stats.savedPercentEst;
  const percent = typeof percentRaw === "number" ? percentRaw : (before > 0 && saved > 0 ? Math.round((saved / before) * 100) : 0);
  const hasSavings = before > 0 && after > 0 && before > after && saved > 0 && percent > 0;
  const savingsPrefix = hasSavings ? `${formatTokens(before)}→${formatTokens(after)} (${percent}% saved, ~${formatTokens(saved)}) · ` : "";
  const keptTokens = stats.keptTokensEst ?? 0;
  const summarized = stats.summarized ?? 0;
  const keptTurns = stats.keptUserTurns ?? 0;
  const totalTurns = stats.totalUserTurns ?? 0;
  if (stats.budgetCut) {
    const reason = stats.budgetCut === "no_anchor" ? "no user anchor" : "oversized tail";
    if (savingsPrefix) {
      return `omp-vcc: ${savingsPrefix}kept ~${formatTokens(keptTokens)} tok tail (mid-turn cut, ${reason}), summarized ${summarized}.`;
    }
    return `omp-vcc: kept ~${formatTokens(keptTokens)} tok tail (mid-turn cut, ${reason}), summarized ${summarized}.`;
  }
  const notes: string[] = [`summarized ${summarized}`];
  if (stats.smartKeepAdjusted) {
    notes.push("smart-keep");
  }
  if (savingsPrefix) {
    return `omp-vcc: ${savingsPrefix}kept ${keptTurns}/${totalTurns} turns, ~${formatTokens(keptTokens)} tok (${notes.join(", ")}).`;
  }
  return `omp-vcc: kept ${keptTurns}/${totalTurns} turns, ~${formatTokens(keptTokens)} tok (${notes.join(", ")}).`;
};

export const getCompactionHistory = (pi?: any): CompactionStats[] => {
  if (pi) {
    const s = getPerPi(pi);
    if (s?.statsHistory) return [...s.statsHistory];
  }
  return [...globalHistory];
};

export const clearCompactionHistoryForTests = () => {
  globalHistory = [];
  lastStats = null;
  lastCompactWasPiVcc = false;
  pendingFollowUpPrompt = null;
  clearTimeout(pendingAutoContinueTimer as any);
  pendingAutoContinueTimer = null;
  for (const pi of perPiKeys) {
    const s = perPi.get(pi);
    if (s) {
      s.statsHistory = [];
      s.lastStats = null;
      s.lastCompactWasPiVcc = false;
      s.pendingFollowUpPrompt = null;
      clearTimeout(s.pendingAutoContinueTimer as any);
      s.pendingAutoContinueTimer = null;
    }
    // Remove strong ref so pi can be GC'd and WeakMap entry cleared; fresh
    // getPerPi(pi) will recreate if this pi is reused, but tests create fresh
    // pi objects each time, so clearing prevents unbounded Set growth across
    // the 377-test suite.
    perPi.delete(pi);
  }
  perPiKeys.clear();
};

export const formatStatsTable = (history: CompactionStats[]): string => {
  if (!history || history.length === 0) return "No compactions yet.";
  const header = "| # | Before → After | Saved | Kept | Summarized | When |";
  const sep = "|---|---|---|---|---|---|---|";
  const rows = history.map((s, idx) => {
    const before = s.tokensBefore ?? 0;
    const after = s.tokensAfter ?? s.tokensAfterEst ?? 0;
    const saved = s.tokensSaved ?? s.tokensSavedEst ?? (before > 0 && after > 0 ? Math.max(0, before - after) : 0);
    const percent = s.savedPercent ?? s.savedPercentEst ?? (before > 0 && saved > 0 ? Math.round((saved / before) * 100) : 0);
    const beforeAfter = before > 0 && after > 0 ? `${formatTokens(before)}→${formatTokens(after)}` : `${formatTokens(before)}→${formatTokens(after)}`;
    const savedStr = saved > 0 ? `${formatTokens(saved)} (${percent}%)` : "—";
    const keptTurns = s.keptUserTurns ?? 0;
    const totalTurns = s.totalUserTurns ?? 0;
    const keptTok = s.keptTokensEst ?? 0;
    const summarized = s.summarized ?? 0;
    const keptStr = `${keptTurns}/${totalTurns} turns, ~${formatTokens(keptTok)} tok${s.budgetCut ? ` (${s.budgetCut})` : ""}`;
    const when = s.timestamp ? new Date(s.timestamp).toISOString().slice(0, 19).replace("T", " ") : "—";
    return `| ${idx + 1} | ${beforeAfter} | ${savedStr} | ${keptStr} | ${summarized} | ${when} |`;
  });
  return [header, sep, ...rows].join("\n");
};

export const formatLastStatsDetail = (stats: CompactionStats | null): string => {
  if (!stats) return "No compaction has run yet.";
  const before = stats.tokensBefore ?? 0;
  const after = stats.tokensAfter ?? stats.tokensAfterEst ?? 0;
  const saved = stats.tokensSaved ?? stats.tokensSavedEst ?? (before > 0 && after > 0 ? Math.max(0, before - after) : 0);
  const percent = stats.savedPercent ?? stats.savedPercentEst ?? (before > 0 && saved > 0 ? Math.round((saved / before) * 100) : 0);
  const kept = stats.kept ?? 0;
  const keptTurns = stats.keptUserTurns ?? 0;
  const totalTurns = stats.totalUserTurns ?? 0;
  const keptTok = stats.keptTokensEst ?? 0;
  const summaryTok = stats.summaryTokensEst ?? 0;
  const summaryChars = stats.summaryChars ?? 0;
  const summarized = stats.summarized ?? 0;
  const lines = [
    `**Last compaction** ${stats.timestamp ? new Date(stats.timestamp).toISOString() : ""}`,
    `- Before → After: **${formatTokens(before)} → ${formatTokens(after)}** (${percent}% saved, ~${formatTokens(saved)})`,
    `- Summary: ~${formatTokens(summaryTok)} tok (${summaryChars} chars), kept tail ~${formatTokens(keptTok)} tok (${kept} msgs, ${keptTurns}/${totalTurns} turns)`,
    `- Summarized: ${summarized} messages${stats.smartKeepAdjusted ? ` (smart-keep ${stats.smartFromKeep}→${keptTurns})` : ""}${stats.budgetCut ? ` · budgetCut:${stats.budgetCut}` : ""}`,
    `- Details: ${stats.reason ? `reason=${stats.reason}` : "reason=auto"}${stats.willRetry ? " willRetry=true" : ""}`,
  ];
  if (stats.tokensAfter != null && stats.tokensAfterEst != null && stats.tokensAfter !== stats.tokensAfterEst) {
    lines.push(`- Note: est after ${formatTokens(stats.tokensAfterEst)} vs authoritative ${formatTokens(stats.tokensAfter)}`);
  }
  return lines.join("\n");
};


const readCompactionEventContext = (event: unknown): { reason?: CompactionReason; willRetry: boolean } => {
  const raw = event as { reason?: unknown; willRetry?: unknown };
  const reason = raw.reason === "manual" || raw.reason === "threshold" || raw.reason === "overflow"
    ? raw.reason
    : undefined;
  return { reason, willRetry: raw.willRetry === true };
};

export const scheduleCompactionStatsNotify = (ctx: any, stats: CompactionStats) => {
  setTimeout(() => {
    try {
      ctx?.ui?.notify?.(
        formatCompactionStats(stats),
        "info",
      );
    } catch {}
  }, 500);
};

const parseCompactionInstructions = (customInstructions?: string): {
  isPiVcc: boolean;
  keepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  followUpPrompt: string | null;
} => {
  const trimmed = customInstructions?.trim();
  if (trimmed === PI_VCC_COMPACT_INSTRUCTION || trimmed === OMP_VCC_COMPACT_INSTRUCTION) {
    return { isPiVcc: true, keepUserTurns: 1, keepUserTurnsExplicit: false, followUpPrompt: null };
  }

  for (const sentinel of [PI_VCC_COMPACT_INSTRUCTION, OMP_VCC_COMPACT_INSTRUCTION]) {
    const keepPrefix = `${sentinel} `;
    if (trimmed?.startsWith(keepPrefix)) {
      const parsed = parseKeepAndPrompt(trimmed.slice(keepPrefix.length));
      return {
        isPiVcc: true,
        keepUserTurns: parsed.keepUserTurns ?? 1,
        keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
        followUpPrompt: null,
      };
    }
  }

  const parsed = parseKeepAndPrompt(customInstructions);
  return {
    isPiVcc: false,
    keepUserTurns: parsed.keepUserTurns ?? 1,
    keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
    followUpPrompt: parsed.followUpPrompt || null,
  };
};

const normalizeKeepUserTurns = (keepUserTurns: number): number => {
  if (!Number.isFinite(keepUserTurns)) return 0;
  return Math.max(0, Math.floor(keepUserTurns));
};

const dbg = (settings: PiVccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try { writeFileSync("/tmp/omp-vcc-debug.json", JSON.stringify(data, null, 2)); } catch {}
  try { writeFileSync("/tmp/pi-vcc-debug.json", JSON.stringify(data, null, 2)); } catch {}
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}

// Convert a non-message entry that carries LLM-context text (custom_message /
// branch_summary) into its agent-message form, mirroring pi-core's
// createCustomMessage / createBranchSummaryMessage (not root-exported, so inlined).
const toLiveMessage = (entry: any): { role: string; content: unknown; [key: string]: unknown } | null => {
  if (entry.type === "message" && entry.message) return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      content: undefined,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  return null;
};

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages";

export type OwnCutResult =
  | {
      ok: true;
      messages: any[];
      firstKeptEntryId: string;
      compactAll: boolean;
      keptUserTurns: number;
      totalUserTurns: number;
      requestedKeepUserTurns: number;
      keepFallbackToCompactAll: boolean;
      budgetCut?: BudgetCutKind;
    }
  | { ok: false; reason: OwnCutCancelReason };

const collectLiveMessages = (branchEntries: any[]): EntryWithMessage[] => {
  // Find the last compaction entry and its firstKeptEntryId
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }

  // Honor the latest `/clear` reset_boundary, mirroring prepareCompaction
  // (packages/agent/src/compaction/compaction.ts:1335-1345). A reset after the
  // last compaction supersedes it — the pre-reset summary was cleared, so start
  // fresh after the boundary. A reset at or before the compaction is already
  // superseded and is ignored (scan only newer entries).
  let resetBoundaryIdx = -1;
  for (let i = branchEntries.length - 1; i > lastCompactionIdx; i--) {
    if (branchEntries[i].type === "reset_boundary") {
      resetBoundaryIdx = i;
      break;
    }
  }
  if (resetBoundaryIdx > lastCompactionIdx) {
    const liveMessages: EntryWithMessage[] = [];
    for (let i = resetBoundaryIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      if (e.type === "reset_boundary") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m });
    }
    return liveMessages;
  }

  // Orphan recovery: triggers when lastKeptId is set to "" (sentinel from prior
  // compact-all) OR set to an id that no longer exists in the branch. In both cases,
  // start collecting from right after the last compaction entry.
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  // Collect live messages
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      if (e.type === "reset_boundary") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m });
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      if (e.type === "reset_boundary") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m });
    }
  }
  return liveMessages;
};

export function buildOwnCut(branchEntries: any[], keepUserTurns = 1): OwnCutResult {
  const normalizedKeepUserTurns = normalizeKeepUserTurns(keepUserTurns);
  const liveMessages = collectLiveMessages(branchEntries);

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  const userIndices = liveMessages.reduce<number[]>((acc, e, i) => {
    if (e.message.role === "user") acc.push(i);
    return acc;
  }, []);
  const compactAll = (keepFallbackToCompactAll: boolean) => ({
    ok: true as const,
    messages: liveMessages.map((e) => e.message),
    firstKeptEntryId: "",
    compactAll: true,
    keptUserTurns: 0,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll,
  });

  if (normalizedKeepUserTurns <= 0) return compactAll(false);

  // Summarize all messages before the requested kept user-turn tail.
  const targetUserIdx = userIndices.length - normalizedKeepUserTurns;
  const cutIdx = targetUserIdx >= 0 ? userIndices[targetUserIdx] : -1;

  if (cutIdx <= 0) {
    // Keep request cannot form a safe boundary (single user prompt, no user prompt,
    // or keep larger than available user turns), so compact EVERYTHING and keep no tail.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return compactAll(true);
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
    keptUserTurns: userIndices.length - targetUserIdx,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll: false,
  };
}

// Token-budget tail cut: rescue default-path sessions when the user-turn
// anchored tail is absent (autonomous: no user boundary in the live window)
// or oversized (a single giant last user turn). Cuts at the nearest valid
// non-toolResult boundary, mirroring pi-core's findCutPoint.
export const findBudgetCutIndex = (
  live: EntryWithMessage[],
  maxTokens: number,
  charsPerToken?: number,
): number => {
  let acc = 0;
  let crossed = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    acc += estimateMessageContentTokens(live[i].message.content, charsPerToken);
    if (acc >= maxTokens) {
      crossed = i;
      break;
    }
  }
  if (crossed < 0) return -1;
  // Snap forward off any toolResult to the next valid boundary.
  for (let j = Math.max(crossed, 1); j < live.length; j++) {
    if (live[j].message.role !== "toolResult") return j;
  }
  return -1;
};

export const applyTailBudget = (
  branchEntries: any[],
  cut: OwnCutResult,
  opts: { maxTokens?: number; oversizedFactor?: number; charsPerToken?: number } = {},
): OwnCutResult => {
  if (!cut.ok) return cut;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const factor = opts.oversizedFactor ?? OVERSIZED_TAIL_FACTOR;
  const live = collectLiveMessages(branchEntries);

  const budgetResult = (idx: number, budgetCut: BudgetCutKind): OwnCutResult => ({
    ok: true,
    messages: live.slice(0, idx).map((m) => m.message),
    firstKeptEntryId: live[idx].entry.id,
    compactAll: false,
    keptUserTurns: live.slice(idx).filter((m) => m.message.role === "user").length,
    totalUserTurns: live.filter((m) => m.message.role === "user").length,
    requestedKeepUserTurns: cut.requestedKeepUserTurns,
    keepFallbackToCompactAll: false,
    budgetCut,
  });

  // Case A: no user anchor → compact-all. Re-cut to a token budget unless the
  // compact-all came from explicit keep:0 (which must be respected absolutely).
  if (cut.compactAll) {
    if (!cut.keepFallbackToCompactAll) return cut;
    const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
    if (idx < 0) return cut;
    return budgetResult(idx, "no_anchor");
  }

  // Case B: oversized user-boundary tail. Only re-cut when the kept tail exceeds
  // maxTokens * factor (tolerance zone below is unchanged).
  const tailStart = cut.messages.length; // equals the cut index in the live window
  let tailTokens = 0;
  for (let i = tailStart; i < live.length; i++) {
    tailTokens += estimateMessageContentTokens(live[i].message.content, opts.charsPerToken);
  }
  if (tailTokens <= maxTokens * factor) return cut;
  const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
  if (idx <= tailStart) return cut;
  return budgetResult(idx, "oversized_tail");
};

// ── smart keep-tail: boost default keep when tail is small ──

export const MIN_SMART_TAIL_TOKENS = 5_000;
export const MAX_SMART_TAIL_TOKENS = 25_000;

export interface ResolveSmartKeepOptions {
  branchEntries: any[];
  /** Requested keep:N; null when user did not specify (default path). */
  requestedKeepUserTurns: number | null;
  /** True when user typed keep:N explicitly — always respected. */
  explicit: boolean;
  /** Setting toggle. */
  smartKeepTail: boolean;
  /** Injectable thresholds for tests. */
  minTokens?: number;
  maxTokens?: number;
  /** Calibrated chars/token for the current session; defaults to heuristic when omitted. */
  charsPerToken?: number;
}

export interface ResolveSmartKeepResult {
  keepUserTurns: number;
  smartAdjusted: boolean;
  /** Original base keep, for toast like "1→3". */
  fromKeep: number;
}

/**
 * Estimate tail tokens for a given keep:N.
 * Returns null when keep would trigger compact-all (tail lost) or cancel,
 * so the resolver can stop growing instead of selecting a value that
 * discards the tail entirely.
 */
const tailTokensForKeep = (branchEntries: any[], keepUserTurns: number, charsPerToken?: number): number | null => {
  const cut = buildOwnCut(branchEntries, keepUserTurns);
  if (!cut.ok || cut.compactAll) return null;
  const idx = branchEntries.findIndex((e: any) => e.id === cut.firstKeptEntryId);
  if (idx < 0) return null;
  const kept = branchEntries.slice(idx).filter((e: any) => e.type === "message");
  const chars = kept.reduce(
    (sum: number, e: any) => sum + estimateMessageContentChars(e.message?.content),
    0,
  );
  return estimateTokensFromChars(chars, charsPerToken);
};

/**
 * Resolve the effective keep:N.
 * - Explicit keep:N from the user is always respected.
 * - smartKeepTail=false → old behavior (default keep:1).
 * - smartKeepTail=true → if keep:1 tail <= minTokens, grow keep to the
 *   largest N whose tail stays <= maxTokens. Stops at compact-all boundary.
 */
export const resolveSmartKeepUserTurns = (opts: ResolveSmartKeepOptions): ResolveSmartKeepResult => {
  const minTokens = opts.minTokens ?? MIN_SMART_TAIL_TOKENS;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const baseKeep = opts.requestedKeepUserTurns ?? 1;

  if (opts.explicit || !opts.smartKeepTail) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const baseTokens = tailTokensForKeep(opts.branchEntries, baseKeep, opts.charsPerToken);
  // base tail already above min (or unmeasurable / compact-all) → don't grow.
  if (baseTokens == null || baseTokens > minTokens) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const baseCut = buildOwnCut(opts.branchEntries, baseKeep);
  const totalUserTurns = baseCut.ok ? baseCut.totalUserTurns : 0;

  let selected = baseKeep;
  for (let k = baseKeep + 1; k <= totalUserTurns; k++) {
    const tokens = tailTokensForKeep(opts.branchEntries, k, opts.charsPerToken);
    if (tokens == null || tokens > maxTokens) break;
    selected = k;
  }

  return {
    keepUserTurns: selected,
    smartAdjusted: selected !== baseKeep,
    fromKeep: baseKeep,
  };
};

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "omp-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "omp-vcc: Too few messages to compact",
};

export const registerBeforeCompactHook = (pi: ExtensionAPI) => {
  // Filter our invisible-continue marker out of the LLM context payload so the
  // model just continues from the compaction summary (matched by customType ONLY).
  pi.on("context", (event) => {
    const messages = event.messages.filter((message) => {
      if (message.role !== "custom") return true;
      return message.customType !== AUTO_CONTINUE_CUSTOM_TYPE && message.customType !== LEGACY_AUTO_CONTINUE_CUSTOM_TYPE;
    });
    if (messages.length !== event.messages.length) return { messages };
  });

  pi.on("before_agent_start", () => {
    clearPendingAutoContinueForPi(pi);
  });

  pi.on("session_before_compact", (event, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const { reason, willRetry } = readCompactionEventContext(event);
    const settings = loadSettings(ctx);
    if (!settings.vccEnabled) return;

    // Always handle explicit /pi-vcc or /omp-vcc marker.
    // Otherwise, only handle when user opted in via settings.
    const { isPiVcc, keepUserTurns, keepUserTurnsExplicit, followUpPrompt } = parseCompactionInstructions(customInstructions);
    setPendingFollowUpPrompt(pi, null);
    // Explicit host mode bypass: when the host signals an explicit compact mode
    // (e.g. /compact snapcompact or --mode shake), let the host walker handle it
    // even though overrideDefaultCompaction is true. This enables sequential
    // VCC → snapcompact/shake combinations. The event field is only present when
    // the optional native vcc patch is applied or a future host exposes it; when
    // absent this branch is no-op and the existing override semantics remain.
    const explicitMode = (event as any).compactMode ?? (event as any).explicitMode ?? (event as any).mode;
    if (!isPiVcc && typeof explicitMode === "string" && explicitMode) {
      const m = explicitMode.toLowerCase();
      if (m === "snapcompact" || m === "shake" || m === "soft" || m === "remote" || m === "handoff") return;
    }
    if (!isPiVcc && !settings.overrideDefaultCompaction) return;

    const calibrationCut = buildOwnCut(branchEntries as any[], 0);
    const calibrationMessageChars = calibrationCut.ok
      ? calibrationCut.messages.reduce(
          (sum: number, message: any) => sum + estimateMessageContentChars(message.content),
          0,
        )
      : 0;
    const calibrationSummaryChars = typeof preparation.previousSummary === "string"
      ? preparation.previousSummary.length
      : 0;
    const tokenEstimate = calibrateCharsPerToken(
      calibrationMessageChars + calibrationSummaryChars,
      preparation.tokensBefore,
    );

    // Smart keep-tail: boost default keep when the tail is small.
    // Explicit keep:N from the user is always respected (resolver no-ops).
    const smartKeep = resolveSmartKeepUserTurns({
      branchEntries: branchEntries as any[],
      requestedKeepUserTurns: keepUserTurnsExplicit ? keepUserTurns : null,
      explicit: keepUserTurnsExplicit,
      smartKeepTail: settings.smartKeepTail,
      charsPerToken: tokenEstimate.charsPerToken,
    });
    let ownCut = buildOwnCut(branchEntries as any[], smartKeep.keepUserTurns);
    // Default path only: rescue autonomous / oversized-tail sessions with a
    // token-budget cut. Explicit keep:N is respected absolutely (no-op here).
    if (ownCut.ok && !keepUserTurnsExplicit) {
      ownCut = applyTailBudget(branchEntries as any[], ownCut, { charsPerToken: tokenEstimate.charsPerToken });
    }
    if (!ownCut.ok) {
      const lastComp = [...branchEntries].reverse().find((e: any) => e.type === "compaction");
      const lastCompIdx = lastComp ? (branchEntries as any[]).indexOf(lastComp) : -1;

      // Recompute liveMessages view (same logic as buildOwnCut) for diagnostic —
      // honor reset_boundary like collectLiveMessages does (see compaction.ts:1335).
      let resetIdx = -1;
      for (let i = (branchEntries as any[]).length - 1; i > lastCompIdx; i--) {
        if ((branchEntries as any[])[i].type === "reset_boundary") { resetIdx = i; break; }
      }
      const resetSupersedes = resetIdx > lastCompIdx;
      let diagLastKeptId: string | undefined = lastComp?.firstKeptEntryId;
      let diagLastCompIdx = lastCompIdx;
      if (resetSupersedes) {
        diagLastKeptId = undefined;
        diagLastCompIdx = -1;
      }
      const hasPriorCompaction = diagLastCompIdx >= 0;
      const hasValidKeptId = !!diagLastKeptId && (branchEntries as any[]).some((e: any) => e.id === diagLastKeptId);
      const diagOrphan = hasPriorCompaction && !hasValidKeptId;
      const liveRoles: string[] = [];
      if (resetSupersedes) {
        for (let i = resetIdx + 1; i < (branchEntries as any[]).length; i++) {
          const e = (branchEntries as any[])[i];
          if (e.type === "compaction") continue;
          if (e.type === "reset_boundary") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      } else if (diagOrphan) {
        for (let i = diagLastCompIdx + 1; i < branchEntries.length; i++) {
          const e = (branchEntries as any[])[i];
          if (e.type === "compaction") continue;
          if (e.type === "reset_boundary") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      } else {
        let foundKept = !diagLastKeptId;
        for (const e of branchEntries as any[]) {
          if (!foundKept && e.id === diagLastKeptId) foundKept = true;
          if (!foundKept) continue;
          if (e.type === "compaction") continue;
          if (e.type === "reset_boundary") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      }
      const userIndices = liveRoles.reduce<number[]>((acc, r, i) => (r === "user" ? (acc.push(i), acc) : acc), []);

      setPendingFollowUpPrompt(pi, null);
      // Fallback when pi-vcc cannot cut: for omp, SessionBeforeCompactEvent has no
      // reason/willRetry (shared-events.ts:64-74), so overflow would otherwise be
      // cancelled. Use tokensBefore as heuristic: large context + undefined
      // reason likely means auto threshold/overflow, not manual /compact.
      const isOverflowHeuristic = preparation.tokensBefore > 50000;
      const fallbackToCore = !isPiVcc && (reason === "overflow" || willRetry || (reason == null && isOverflowHeuristic));
      dbg(settings, {
        cancelled: !fallbackToCore,
        fallbackToCore,
        reason: ownCut.reason,
        compaction: { reason, willRetry },
        isPiVcc,
        counts: {
          total: branchEntries.length,
          messages: (branchEntries as any[]).filter((e: any) => e.type === "message").length,
          compactions: (branchEntries as any[]).filter((e: any) => e.type === "compaction").length,
          entriesAfterLastCompaction: lastCompIdx >= 0 ? branchEntries.length - lastCompIdx - 1 : null,
        },
        liveMessages: {
          count: liveRoles.length,
          userCount: userIndices.length,
          firstUserIdx: userIndices[0] ?? null,
          lastUserIdx: userIndices[userIndices.length - 1] ?? null,
          roleSequence: liveRoles.length <= 30
            ? liveRoles
            : [...liveRoles.slice(0, 10), "...", ...liveRoles.slice(-10)],
        },
        lastCompaction: lastComp ? {
          hasFirstKeptEntryId: !!lastComp.firstKeptEntryId,
          foundInBranch: lastComp.firstKeptEntryId
            ? (branchEntries as any[]).some((e: any) => e.id === lastComp.firstKeptEntryId)
            : null,
        } : null,
        tail: (branchEntries as any[]).slice(-5).map((e: any) => ({
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          hasContent: e.type === "message" ? e.message?.content != null : undefined,
        })),
      });

      if (fallbackToCore) return;

      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {}
      return { cancel: true };
    }

    setPendingFollowUpPrompt(pi, followUpPrompt);
    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = convertToLlm(agentMessages);

    // Count kept messages and estimate tokens
    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptChars = keptEntries.reduce(
      (sum: number, e: any) => sum + estimateMessageContentChars(e.message?.content),
      0,
    );
    const keptTokensEst = estimateTokensFromChars(keptChars, tokenEstimate.charsPerToken);
    const config = settings;

    // Ranked compaction: keep the highest-signal blocks under a token budget
    // instead of the old unranked compile() (fixed 120-line cap). The token
    // budget is converted to a char budget via the session's calibrated
    // charsPerToken so the summary targets ~RANKED_BRIEF_BUDGET_TOKENS tokens
    // regardless of content density.
    //
    // The budget is SIZE-RELATIVE: it scales with transcript length between a
    // floor (RANKED_BRIEF_BUDGET_TOKENS) and a ceiling (RANKED_BRIEF_CEILING_TOKENS)
    // at RANKED_BRIEF_CHARS_PER_BLOCK per normalized block. Small/medium sessions
    // stay at the floor (size parity with the old cap); very large transcripts --
    // which carry far more high-value long-tail (edits, commands, tests) than the
    // old 120-line brief could hold -- earn more budget up to the ceiling, while
    // the ceiling keeps growth bounded (no return of the ~60% bloat).
    // Audit (research/audit, 794 sessions, vs shipped master 0.3.18): SMALL/MED
    // unchanged; LARGE bucket paired recall -5.0pp -> -2.3pp (median to parity),
    // long-tail losers 100/369 -> 67/369; fact density stays ~1.4x master.
    const RANKED_BRIEF_BUDGET_TOKENS = 1100;
    const RANKED_BRIEF_CEILING_TOKENS = 2000;
    const RANKED_BRIEF_TOKENS_PER_BLOCK = 15;
    const summary = compileRanked({
      messages,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
      ranking: {
        maxBriefChars: Math.round(RANKED_BRIEF_BUDGET_TOKENS * tokenEstimate.charsPerToken),
        maxBriefCharsCeiling: Math.round(RANKED_BRIEF_CEILING_TOKENS * tokenEstimate.charsPerToken),
        briefCharsPerBlock: Math.round(RANKED_BRIEF_TOKENS_PER_BLOCK * tokenEstimate.charsPerToken),
      },
    });

    const tokensBefore = typeof preparation.tokensBefore === "number" ? preparation.tokensBefore : 0;
    const summaryChars = summary.length;
    const summaryTokensEst = estimateTokensFromChars(summaryChars, tokenEstimate.charsPerToken);
    const tokensAfterEst = summaryTokensEst + keptTokensEst;
    const tokensSavedEst = tokensBefore > 0 ? Math.max(0, tokensBefore - tokensAfterEst) : 0;
    const savedPercentEst = tokensBefore > 0 && tokensSavedEst > 0 ? Math.round((tokensSavedEst / tokensBefore) * 100) : 0;

    setLastStats(pi, {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptUserTurns: ownCut.keptUserTurns,
      totalUserTurns: ownCut.totalUserTurns,
      requestedKeepUserTurns: ownCut.requestedKeepUserTurns,
      keepUserTurnsExplicit,
      keepFallbackToCompactAll: ownCut.keepFallbackToCompactAll,
      keptTokensEst,
      smartKeepAdjusted: smartKeep.smartAdjusted,
      smartFromKeep: smartKeep.fromKeep,
      budgetCut: ownCut.ok ? ownCut.budgetCut : undefined,
      reason,
      willRetry,
      tokensBefore,
      summaryChars,
      summaryTokensEst,
      tokensAfterEst,
      tokensSavedEst,
      savedPercentEst,
    });

    const branchIds = branchEntries.map((e: any) => e.id);
    const cutIdx = branchIds.indexOf(firstKeptEntryId);
    const cutWindow = cutIdx >= 0
      ? branchEntries.slice(Math.max(0, cutIdx - 3), Math.min(branchEntries.length, cutIdx + 3)).map((e: any) => ({
          id: e.id,
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          preview: e.type === "message" ? previewContent(e.message?.content) : undefined,
        }))
      : [];

    const KNOWN_SECTIONS = new Set(["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"]);
    const extractKnownSections = (text: string) =>
      [...text.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]).filter((h) => KNOWN_SECTIONS.has(h));
    dbg(config, {
      usedOwnCut: true,
      budgetCut: ownCut.budgetCut,
      compaction: { reason, willRetry },
      messagesToSummarize: agentMessages.length,
      messagesPreviewHead: agentMessages.slice(0, 3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      messagesPreviewTail: agentMessages.slice(-3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      convertedMessages: messages.length,
      usage: collectUsageStats(agentMessages),
      firstKeptEntryId,
      cutWindow,
      tokensBefore,
      tokenEstimate,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: extractKnownSections(summary),
      savings: {
        tokensBefore,
        summaryChars,
        summaryTokensEst,
        keptTokensEst,
        tokensAfterEst,
        tokensSavedEst,
        savedPercentEst,
      },
    });

    const details: PiVccCompactionDetails = {
      compactor: "omp-vcc",
      version: 2,
      sections: extractKnownSections(summary),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      reason,
      willRetry,
      savings: {
        tokensBefore,
        summaryChars,
        summaryTokensEst,
        keptTokensEst,
        tokensAfterEst,
        tokensSavedEst,
        savedPercentEst,
      },
    };

    setLastCompactWasPiVcc(pi, isPiVcc);

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });
  pi.on("session_compact", async (event, ctx) => {
    const { reason, willRetry } = readCompactionEventContext(event);
    if (!event.fromExtension) return;
    const followUpPrompt = getPendingFollowUpPrompt(pi);
    setPendingFollowUpPrompt(pi, null);
    const per = getPerPi(pi);
    const stats = per ? per.lastStats : lastStats;
    if (!stats) return;
    // Enrich with authoritative tokensAfter from host if available (even for pi-vcc manual, before early return)
    const entry: any = (event as any).compactionEntry;
    if (entry && typeof entry.tokensAfter === "number" && typeof entry.tokensBefore === "number") {
      const before = entry.tokensBefore;
      const after = entry.tokensAfter;
      const saved = Math.max(0, before - after);
      const percent = before > 0 && saved > 0 ? Math.round((saved / before) * 100) : 0;
      if (per && per.lastStats) {
        per.lastStats.tokensAfter = after;
        per.lastStats.tokensSaved = saved;
        per.lastStats.savedPercent = percent;
        per.lastStats.tokensBefore = before;
      }
      if (lastStats) {
        lastStats.tokensAfter = after;
        lastStats.tokensSaved = saved;
        lastStats.savedPercent = percent;
        lastStats.tokensBefore = before;
      }
      (stats as any).tokensAfter = after;
      (stats as any).tokensSaved = saved;
      (stats as any).savedPercent = percent;
      (stats as any).tokensBefore = before;
      try {
        const cfg = loadSettings(ctx);
        if (cfg.debug) {
          dbg(cfg, {
            authoritativeSavings: { tokensBefore: before, tokensAfter: after, tokensSaved: saved, savedPercent: percent },
            eventEntry: { id: entry.id, tokensBefore: entry.tokensBefore, tokensAfter: entry.tokensAfter },
          });
        }
      } catch {}
    }
    const isPiVccLast = per ? per.lastCompactWasPiVcc : lastCompactWasPiVcc;
    if (isPiVccLast) return; // /pi-vcc handles its own toast via onComplete
    if (willRetry) return;
    // omp's SessionCompactEvent is {compactionEntry, fromExtension} only
    // (shared-events.ts:84-89); reason/willRetry are always undefined/false
    // under real omp runs. Treat undefined as auto (threshold/overflow) when
    // the compaction was sizable, otherwise manual /compact should not auto-continue.
    const isLargeCompaction = (stats.summarized > 10) || (stats.kept > 5) || (stats.keptTokensEst > 2000);
    const shouldContinueAfterAutoCompact = (reason === "threshold" || reason === "overflow" || (reason == null && isLargeCompaction)) && loadSettings(ctx).continueAfterThresholdCompact;
    scheduleCompactionStatsNotify(ctx, stats);
    // Eager post-VCC shake chain (chainShakeHint). Host rescue already handles
    // dead-end; this forces a second shake entry even when headroom was made.
    try {
      const cfgChain = loadSettings(ctx);
      const ctxMaybe = ctx as unknown as Record<string, unknown>;
      const compactFn = ctxMaybe["compact"];
      if (cfgChain.chainShakeHint && typeof compactFn === "function" && !pendingChainShake.has(pi as unknown as object) && !willRetry && !isPiVccLast) {
        pendingChainShake.add(pi as unknown as object);
        const maybePromise = (compactFn as unknown as (o: unknown) => Promise<void>).call(ctx, { mode: "shake" } as unknown);
        const asPromise = maybePromise as unknown as Promise<void> | void;
        if (asPromise && typeof (asPromise as unknown as Promise<void>).catch === "function") {
          (asPromise as unknown as Promise<void>).catch(() => {}).finally(() => {
            setTimeout(() => { try { pendingChainShake.delete(pi as unknown as object); } catch {} }, 2000);
          });
        } else {
          setTimeout(() => { try { pendingChainShake.delete(pi as unknown as object); } catch {} }, 2000);
        }
      }
    } catch {}
    if (followUpPrompt) {
      try {
        await pi.sendUserMessage(followUpPrompt);
      } catch {}
    } else if (shouldContinueAfterAutoCompact) {
      scheduleAutoContinueForPi(pi);
    }
  });
};

// ── Recall tool & commands — re-exported for pi-vcc test compatibility (paper V_adapt) ──

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

export const registerRecallTool = (pi: any) => {
  const schema = pi?.zod?.object
    ? pi.zod.object({
        query: pi.zod.string().optional(),
        expand: pi.zod.array(pi.zod.number()).optional(),
        page: pi.zod.number().optional(),
        scope: pi.zod.enum(["lineage", "all", "active"]).optional(),
        mode: pi.zod.enum(["hybrid", "touched"]).optional(),
      })
    : {};
  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Recall",
    description: "Recall earlier parts of the current session",
    approval: "read",
    parameters: schema,
    async execute(_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: any) {
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!sessionFile) return { content: [{ type: "text", text: "No session file available." }] };
      const scope = _normalizeRecallScope(params.scope === "active" ? "lineage" : params.scope);
      const lineageEntryIds = scope === "lineage" ? _getActiveLineageEntryIds(ctx.sessionManager) : undefined;
      const q = params.query?.trim();
      if (q && _parseEntryRef(q)) {
        const ref = _parseEntryRef(q)!;
        if (lineageEntryIds) {
          const { rendered } = _loadAllMessages(sessionFile, false, lineageEntryIds);
          if (!rendered.some((m) => m.index === ref.index)) {
            return { content: [{ type: "text", text: `Cannot expand indices outside active lineage: ${ref.index}. Use scope:'all' to reach other branches.` }] };
          }
        }
        const text = _expandEntry(sessionFile, ref.index, ref.full, ref.offset, ref.limit);
        return { content: [{ type: "text", text }] };
      }
      if (q && _parseDrillDown(q)) {
        const parsed = _parseDrillDown(q)!;
        if (lineageEntryIds) {
          const { rendered } = _loadAllMessages(sessionFile, false, lineageEntryIds);
          if (!rendered.some((m) => m.index === parsed.index)) {
            return { content: [{ type: "text", text: `Cannot expand indices outside active lineage: ${parsed.index}. Use scope:'all' to reach other branches.` }] };
          }
        }
        const text = _expandEntryFile(sessionFile, parsed.index, parsed.pathPattern, parsed.full, parsed.offset, parsed.limit);
        return { content: [{ type: "text", text }] };
      }
      if (_normalizeRecallMode(params.mode) === "touched") {
        const { rendered, rawMessages } = _loadAllMessages(sessionFile, false, lineageEntryIds);
        const touched = _getTouchedFiles(rawMessages as any, rendered);
        const text = _formatTouchedOutput(touched, params.page);
        return { content: [{ type: "text", text }] };
      }
      const expandSet = new Set(params.expand ?? []);
      if (expandSet.size > 0) {
        const { rendered: fullMsgs } = _loadAllMessages(sessionFile, true, lineageEntryIds);
        const requested = [...expandSet];
        const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
        const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
        if (invalid.length > 0) return { content: [{ type: "text", text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}` }] };
        const expanded = requested.map((i) => byIndex.get(i)).filter(Boolean) as any[];
        const output = (scope === "all" ? "Scope: all\n\n" : "") + _formatRecallOutput(expanded);
        return { content: [{ type: "text", text: output }] };
      }
      const { rendered: msgs, rawMessages } = _loadAllMessages(sessionFile, false, lineageEntryIds);
      if (q) {
        const { hits, totalBeforeCap, truncated } = _searchEntriesDetailed(msgs, rawMessages as any, q);
        const page = Math.max(1, params.page ?? 1);
        const totalPages = Math.ceil(hits.length / PAGE_SIZE);
        const scopeSuffix = scope === "all" ? " (scope: all)" : "";
        const truncationNote = truncated ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results` : "";
        if (hits.length > 0 && page > totalPages) {
          const guidance = truncated ? `Use a page between 1 and ${totalPages}.` : `Use a page between 1 and ${totalPages}, or refine your query.`;
          const text = `Page ${page} is outside the available range 1-${totalPages} (${hits.length} matches${scopeSuffix}${truncationNote}). ${guidance}`;
          return { content: [{ type: "text", text }] };
        }
        const start = (page - 1) * PAGE_SIZE;
        const pageResults = hits.slice(start, start + PAGE_SIZE);
        const header = totalPages > 1 ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})` : `${hits.length} matches${scopeSuffix}${truncationNote}`;
        const footer = page < totalPages ? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---` : "";
        const output = _formatRecallOutput(pageResults, q, header, { truncated, totalBeforeCap }) + footer;
        return { content: [{ type: "text", text: output }] };
      }
      const output = (scope === "all" ? "Scope: all\n\n" : "") + _formatRecallOutput(msgs.slice(-DEFAULT_RECENT), q);
      return { content: [{ type: "text", text: output }] };
    },
  });
};

export const registerVccRecallCommand = (pi: any) => {
  pi.registerCommand("pi-vcc-recall", {
    description: "Recall earlier parts of this session",
    handler: async (args: string, ctx: any) => {
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!sessionFile) { try { ctx.ui.notify("No session file available.", "error"); } catch {} return; }
      const raw = args.trim();
      const parsed = _parseRecallScope(raw);
      const lineageEntryIds = parsed.scope === "lineage" ? _getActiveLineageEntryIds(ctx.sessionManager) : undefined;
      if (!parsed.text) {
        const { rendered } = _loadAllMessages(sessionFile, false, lineageEntryIds);
        const recent = rendered.slice(-DEFAULT_RECENT);
        const output = (parsed.scope === "all" ? "Scope: all\n\n" : "") + _formatRecallOutput(recent);
        try { pi.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
        return;
      }
      const pageMatch = parsed.text.match(/\bpage:(\d+)\b/i);
      const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
      const query = parsed.text.replace(/\bpage:\d+\b/i, "").trim();
      if (!query) {
        const { rendered } = _loadAllMessages(sessionFile, false, lineageEntryIds);
        const recent = rendered.slice(-DEFAULT_RECENT);
        const output = (parsed.scope === "all" ? "Scope: all\n\n" : "") + _formatRecallOutput(recent);
        try { pi.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
        return;
      }
      const { rendered, rawMessages } = _loadAllMessages(sessionFile, false, lineageEntryIds);
      const { hits, totalBeforeCap, truncated } = _searchEntriesDetailed(rendered, rawMessages as any, query);
      const totalPages = Math.ceil(hits.length / PAGE_SIZE);
      const scopeSuffix = parsed.scope === "all" ? " (scope: all)" : "";
      const scopeArg = parsed.scope === "all" ? " scope:all" : "";
      const truncationNote = truncated ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results` : "";
      if (hits.length > 0 && page > totalPages) {
        const guidance = truncated ? `Use /pi-vcc-recall ${query}${scopeArg} page:N with N between 1 and ${totalPages}.` : `Use /pi-vcc-recall ${query}${scopeArg} page:N with N between 1 and ${totalPages}, or refine your query.`;
        const text = `Page ${page} is outside the available range 1-${totalPages} (${hits.length} matches${scopeSuffix}${truncationNote}). ${guidance}`;
        try { pi.sendMessage?.({ customType: "vcc-recall", content: text, display: true }, { triggerTurn: false }); } catch {}
        return;
      }
      const start = (page - 1) * PAGE_SIZE;
      const pageResults = hits.slice(start, start + PAGE_SIZE);
      const header = totalPages > 1 ? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})` : `${hits.length} matches${scopeSuffix}${truncationNote}`;
      const footer = page < totalPages ? `\n--- /pi-vcc-recall ${query}${scopeArg} page:${page + 1} ---` : "";
      const output = _formatRecallOutput(pageResults, query, header, { truncated, totalBeforeCap }) + footer;
      try { pi.sendMessage?.({ customType: "vcc-recall", content: output, display: true }, { triggerTurn: false }); } catch {}
    },
  });
};

export const registerPiVccCommand = (pi: any) => {
  pi.registerCommand("pi-vcc", {
    description: "Compact conversation with pi-vcc structured summary",
    handler: async (args: string, ctx: any) => {
      const { followUpPrompt, keepUserTurns } = parseKeepAndPrompt(args);
      ctx.compact({
        customInstructions: buildPiVccCustomInstructions(keepUserTurns),
        onComplete: () => {
          const stats = getLastCompactionStats(pi);
          if (stats) {
            scheduleCompactionStatsNotify(ctx, stats);
          } else {
            ctx.ui.notify("Compacted with pi-vcc", "info");
          }
          if (followUpPrompt) {
            try {
              void Promise.resolve(pi.sendUserMessage(followUpPrompt)).catch(() => {});
            } catch {}
          }
        },
        onError: (err) => {
          if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
            ctx.ui.notify("Nothing to compact", "warning");
          } else {
            ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
          }
        },
      });
    },
  });
};
export const registerVccStatsTool = (pi: any) => {
  const hasBoolean = typeof pi?.zod?.boolean === "function";
  const schema = pi?.zod?.object && hasBoolean
    ? pi.zod.object({
        history: pi.zod.boolean().optional().describe("Include full history table of all compactions in this session"),
      })
    : {};
  pi.registerTool({
    name: "vcc_stats",
    label: "VCC Stats",
    description: "Show omp-vcc compaction savings — last compaction before→after, tokens saved, percent, and optional history of all compactions in this session. Divider in transcript already shows 256K→20K; this tool surfaces the same numbers with kept/summarized details.",
    approval: "read",
    parameters: schema,
    async execute(_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, _ctx: any) {
      const history = getCompactionHistory(pi);
      const last = getLastCompactionStats(pi);
      const wantHistory = params?.history === true;
      if (!last && history.length === 0) {
        return { content: [{ type: "text", text: "No compactions yet in this session." }], details: undefined };
      }
      if (wantHistory) {
        const table = formatStatsTable(history);
        const detail = last ? `\n\n${formatLastStatsDetail(last)}` : "";
        return { content: [{ type: "text", text: `${table}${detail}` }], details: undefined };
      }
      const detail = formatLastStatsDetail(last);
      const table = history.length > 1 ? `\n\nHistory:\n${formatStatsTable(history)}` : "";
      return { content: [{ type: "text", text: `${detail}${table}` }], details: undefined };
    },
  } as unknown as Parameters<(typeof pi)["registerTool"]>[0]);
};

export const registerVccStatsCommand = (pi: any) => {
  const handler = async (args: string, ctx: any) => {
    const raw = (args || "").trim().toLowerCase();
    const wantHistory = raw.includes("history") || raw.includes("--history") || raw.includes("all");
    const history = getCompactionHistory(pi);
    const last = getLastCompactionStats(pi);
    const piAny = pi as unknown as { sendMessage?: (msg: unknown, opts?: unknown) => void };
    if (!last && history.length === 0) {
      try { piAny.sendMessage?.({ customType: "vcc-stats", content: "No compactions yet in this session.", display: true }, { triggerTurn: false }); } catch {}
      try { ctx?.ui?.notify?.("No compactions yet.", "info"); } catch {}
      return;
    }
    let output: string;
    if (wantHistory) {
      const table = formatStatsTable(history);
      const detail = last ? `\n\n${formatLastStatsDetail(last)}` : "";
      output = `${table}${detail}`;
    } else {
      const detail = formatLastStatsDetail(last);
      const table = history.length > 1 ? `\n\nHistory (${history.length} compactions):\n${formatStatsTable(history)}` : "";
      output = `${detail}${table}`;
    }
    try { piAny.sendMessage?.({ customType: "vcc-stats", content: output, display: true }, { triggerTurn: false }); } catch {}
    try { ctx?.ui?.notify?.(`vcc_stats: ${history.length} compaction(s)`, "info"); } catch {}
  };
  pi.registerCommand("vcc-stats", { description: "Show omp-vcc compaction savings (last + history)", handler });
};