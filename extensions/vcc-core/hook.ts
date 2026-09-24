// @ts-nocheck
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { compileRanked, compileSegment } from "./core/summarize";
import { buildGlobalIndex, type PersistedSessionEntry } from "./core/global-indices";
import { scanSessionEntries } from "./core/session-lines";
import {
  buildAppendOnlyDetails,
  collectActiveSegments,
  compactionThresholds,
  coverageForMessages,
  decideAppendMode,
  estimateChainTokens,
  isPiVccAppendDetails,
  projectAppendOnlyContext,
} from "./core/compaction-chain";
import {
  applyRetainedToolOutputProjection,
  buildRetainedToolOutputProjection,
  type RetainedToolOutputProjection,
} from "./core/tool-output-budget";
import { buildPiVccCustomInstructions, parseKeepAndPrompt, PI_VCC_COMPACT_INSTRUCTION } from "./core/compact-args";
import { loadSettings, loadSettingsWithPluginOverlay, loadSettingsWithSourcesAsync, getSettingsPath, DEFAULT_SETTINGS, type PiVccSettings, type VccConfigView } from "./core/settings";
import { calibrateCharsPerToken, estimateMessageContentChars, estimateScriptAwareTokens, estimateScriptAwareMessageContentTokens, collectUsageStats } from "./core/token-estimate";
import { sanitize } from "./core/sanitize";
import type { PiVccCompactionDetails } from "./details";
import type { CompactionReason } from "./types";

// convertToLlm shim: resolve the host export, fallback to identity (identity
// is fine for bashExecution/custom, which the pipeline renders natively, but
// it leaks !!-excluded spans and drops branchSummary entries — so the
// @earendil-works root (pi's canonical export path) is tried first.
const CONVERT_TO_LLM_CANDIDATES = [
  "@earendil-works/pi-coding-agent",
  "@oh-my-pi/pi-coding-agent",
  "@oh-my-pi/pi-coding-agent/session/messages",
] as const;
// Pure loader-driven resolver: first candidate whose module exports a
// convertToLlm function wins, else null (caller keeps identity).
export const resolveConvertToLlm = (
  load: (id: string) => any,
): ((messages: any[]) => any[]) | null => {
  for (const id of CONVERT_TO_LLM_CANDIDATES) {
    try {
      const mod = load(id);
      if (mod && typeof mod.convertToLlm === "function") return mod.convertToLlm;
    } catch {}
  }
  return null;
};
let convertToLlm: (messages: any[]) => any[] = (m) => m;
try {
  const req = createRequire(import.meta.url);
  convertToLlm = resolveConvertToLlm((id) => req(id)) ?? convertToLlm;
} catch {}
// Test-only override for the module-level binding (mirrors
// clearCompactionHistoryForTests): lets suites pin convertToLlm wiring without
// stubbing node module resolution. Null resets to the identity fallback.
export const __setConvertToLlmForTests = (fn: ((messages: Array<unknown>) => Array<unknown>) | null): void => {
  convertToLlm = fn ?? ((m) => m);
};
// Host-kind detection: omp and pi expose incompatible ctx.compact shapes
// (omp: (string|CompactOptions)=>Promise<void> with instructions on the
// string; pi: (CompactOptions)=>void with instructions only via
// options.customInstructions). Three layers, first hit wins:
// 1. Explicit test override (__setHostKindForTests).
// 2. Observable ctx shape — works in bundled runtimes where module
//    resolution misses: pi's getSystemPrompt() returns a string, omp's
//    returns string[]. Pure getters, safe to call.
// 3. Module scope — works in dev/source runtimes: @earendil-works is
//    pi-exclusive (same mechanism as the convertToLlm shim above).
// Default "omp" preserves the legacy string-form call when host-free.
const HOST_KIND_CANDIDATES = ["@earendil-works/pi-coding-agent", "@oh-my-pi/pi-coding-agent"] as const;
export type VccHostKind = "pi" | "omp";
export type VccCompactForm = "object" | "string";
// Pure loader-driven resolver: first resolvable scope wins (@earendil-works
// first, mirroring CONVERT_TO_LLM_CANDIDATES), else "omp".
export const resolveHostKind = (load: (id: string) => unknown): VccHostKind => {
  for (const id of HOST_KIND_CANDIDATES) {
    try {
      if (load(id)) return id.startsWith("@earendil-works") ? "pi" : "omp";
    } catch {}
  }
  return "omp";
};
let defaultHostKind: VccHostKind = "omp";
try {
  defaultHostKind = resolveHostKind((id) => createRequire(import.meta.url)(id));
} catch {}
let hostKindOverride: VccHostKind | null = null;
export const getHostKind = (): VccHostKind => hostKindOverride ?? defaultHostKind;
// Test-only override (mirrors __setConvertToLlmForTests). Null restores the
// detected default.
export const __setHostKindForTests = (kind: VccHostKind | null): void => {
  hostKindOverride = kind;
};
// Layered compact-form decision for a live ctx. getSystemPrompt is read off
// the calling ctx (command or event); absent (host-free mocks) falls through
// to module scope, then the legacy default.
export const resolveCompactForm = (
  load: (id: string) => unknown,
  getSystemPrompt?: () => unknown,
): VccCompactForm => {
  if (hostKindOverride) return hostKindOverride === "pi" ? "object" : "string";
  try {
    const sp = getSystemPrompt?.();
    if (typeof sp === "string") return "object";
    if (Array.isArray(sp)) return "string";
  } catch {}
  return resolveHostKind(load) === "pi" ? "object" : "string";
};
export const getCompactForm = (getSystemPrompt?: () => unknown): VccCompactForm => {
  let load: (id: string) => unknown = () => {
    throw new Error("no loader");
  };
  try {
    const req = createRequire(import.meta.url);
    load = (id) => req(id);
  } catch {}
  return resolveCompactForm(load, getSystemPrompt);
};

export { PI_VCC_COMPACT_INSTRUCTION } from "./core/compact-args";
export const OMP_VCC_COMPACT_INSTRUCTION = "__omp_vcc__";
// (Both pi/omp sentinels are matched inline at the explicit-mode bypass in
// the session_before_compact handler below.)

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
// Growth-guard tolerance: compacting removes N messages (freeing their
// per-message framing) and adds one summary entry (framing + details JSON).
// Char-diff is otherwise exact, but host token accounting has noise both
// ways, so the guard only fires on MATERIAL growth: the net-new summary
// content must exceed the removed prefix by more than a fixed framing
// allowance (one entry, ~128 tok) or 25% of the prefix (per-message
// overhead share) — or exceed the absolute cap (~1k tok) at any ratio, so
// large-scale drift cannot hide behind a big denominator.
export const COMPACTION_GROWTH_FIXED_MARGIN_CHARS = 512;
export const COMPACTION_GROWTH_RELATIVE_MARGIN = 0.25;
export const COMPACTION_GROWTH_ABSOLUTE_CAP_CHARS = 4096;

export interface GrowthGuardVerdict {
  trip: boolean;
  netGrowthChars: number;
  toleranceChars: number;
}

// Pure growth-guard predicate (calibration-free). Table-driven unit tests in
// tests/compaction-growth-guard.test.ts pin every arm and edge.
export const evaluateGrowthGuard = (prefixChars: number, netNewSummaryChars: number): GrowthGuardVerdict => {
  const netGrowthChars = netNewSummaryChars - prefixChars;
  const toleranceChars = Math.max(
    COMPACTION_GROWTH_FIXED_MARGIN_CHARS,
    Math.round(prefixChars * COMPACTION_GROWTH_RELATIVE_MARGIN),
  );
  return {
    trip: netGrowthChars > toleranceChars || netGrowthChars > COMPACTION_GROWTH_ABSOLUTE_CAP_CHARS,
    netGrowthChars,
    toleranceChars,
  };
}

let lastStats: CompactionStats | null = null;
let lastCompactWasPiVcc = false;
let pendingFollowUpPrompt: string | null = null;
let pendingAutoContinueTimer: unknown = null;
let globalHistory: CompactionStats[] = [];

interface PerPiState {
  lastStats: CompactionStats | null;
  lastCompactWasPiVcc: boolean;
  pendingFollowUpPrompt: string | null;
  pendingAutoContinueTimer: unknown;
  statsHistory: CompactionStats[];
  generation: number;
  sessionId?: string;
  timers: Set<unknown>;
  pendingDisplay?: { text: string; sourceEntryId?: string; truncated: boolean };
  autoCompaction?: { generation: number; sessionId?: string; reason: string; action: string; willRetry: boolean };
  pendingCompactionFingerprint?: string;
  pendingPreviousStats?: CompactionStats | null;
  pendingStatsHistoryLength?: number;
  lastSettings?: PiVccSettings;
}

const perPi = new WeakMap<any, PerPiState>();
const perPiKeys = new Set<any>();
const pendingChainShake = new WeakSet<object>();
const getPerPi = (pi: any): PerPiState | null => {
  if (!pi || typeof pi !== "object") return null;
  let state = perPi.get(pi);
  if (!state) {
    state = {
      lastStats: null,
      lastCompactWasPiVcc: false,
      pendingFollowUpPrompt: null,
      pendingAutoContinueTimer: null,
      statsHistory: [],
      generation: 0,
      timers: new Set<unknown>(),
      pendingDisplay: undefined,
    };
    perPi.set(pi, state);
    perPiKeys.add(pi);
  }
  if (!state.statsHistory) state.statsHistory = [];
  if (!state.timers) state.timers = new Set<unknown>();
  if (!state.pendingDisplay) state.pendingDisplay = undefined;
  return state;
};
const setLastStats = (pi: any, v: CompactionStats | null) => {
  if (v && v.timestamp == null) v.timestamp = Date.now();
  lastStats = v;
  const state = getPerPi(pi);
  if (state) {
    state.lastStats = v;
    if (v) {
      state.statsHistory.push(v);
      if (state.statsHistory.length > 50) state.statsHistory.shift();
    }
  }
  if (v) {
    globalHistory.push(v);
    if (globalHistory.length > 50) globalHistory.shift();
  }
};
const setLastCompactWasPiVcc = (pi: any, v: boolean) => {
  lastCompactWasPiVcc = v;
  const state = getPerPi(pi);
  if (state) state.lastCompactWasPiVcc = v;
};
const setPendingFollowUpPrompt = (pi: any, v: string | null) => {
  pendingFollowUpPrompt = v;
  const state = getPerPi(pi);
  if (state) state.pendingFollowUpPrompt = v;
};
const getPendingFollowUpPrompt = (pi: any) => {
  const state = getPerPi(pi);
  return state ? state.pendingFollowUpPrompt : pendingFollowUpPrompt;
};
const sessionIdOf = (ctx: any): string | undefined => {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
};
const isCurrentGeneration = (pi: any, ctx: any, generation: number, sessionId: string | undefined): boolean => {
  const state = getPerPi(pi);
  if (!state || state.generation !== generation) return false;
  return (state.sessionId ?? sessionIdOf(ctx)) === sessionId;
};
const clearTimerHandle = (ctx: any, timer: unknown): void => {
  if (timer == null) return;
  try {
    if (typeof ctx?.clearTimer === "function") ctx.clearTimer(timer);
    else clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
  } catch {}
};
const scheduleManaged = (
  pi: any,
  ctx: any,
  callback: () => void,
  delay: number,
  kind: string,
): unknown => {
  const state = getPerPi(pi);
  const generation = state?.generation ?? 0;
  const sessionId = state?.sessionId ?? sessionIdOf(ctx);
  let handle: unknown;
  const guarded = () => {
    if (state) state.timers.delete(handle);
    if (state && (state.generation !== generation || state.sessionId !== sessionId)) {
      logMetrics(loadSettings(ctx), { event: "stale-callback", kind, generation, sessionId });
      return;
    }
    try { callback(); } catch (error) { throw error; }
  };
  handle = typeof ctx?.setTimeout === "function" ? ctx.setTimeout(guarded, delay) : setTimeout(guarded, delay);
  state?.timers.add(handle);
  return handle;
};
const advanceSessionGeneration = (pi: any, ctx: any): void => {
  const state = getPerPi(pi);
  if (!state) return;
  for (const timer of state.timers) clearTimerHandle(ctx, timer);
  state.timers.clear();
  state.generation++;
  state.sessionId = sessionIdOf(ctx);
  state.lastStats = null;
  state.pendingCompactionFingerprint = undefined;
  state.pendingPreviousStats = undefined;
  state.pendingStatsHistoryLength = undefined;
  state.lastSettings = undefined;
  state.pendingAutoContinueTimer = null;
  state.statsHistory = [];
  state.pendingDisplay = undefined;
  state.autoCompaction = undefined;
  pendingFollowUpPrompt = null;
  pendingAutoContinueTimer = null;
  lastCompactWasPiVcc = false;
  pendingChainShake.delete(pi);
};
const clearPendingAutoContinueForPi = (pi: any, ctx?: any): void => {
  const state = getPerPi(pi);
  const timer = state ? state.pendingAutoContinueTimer : pendingAutoContinueTimer;
  clearTimerHandle(ctx, timer);
  if (state) {
    state.timers.delete(timer);
    state.pendingAutoContinueTimer = null;
  } else {
    pendingAutoContinueTimer = null;
  }
};
const scheduleAutoContinueForPi = (pi: any, ctx?: any): void => {
  clearPendingAutoContinueForPi(pi, ctx);
  const state = getPerPi(pi);
  const timer = scheduleManaged(pi, ctx, () => {
    if (state) state.pendingAutoContinueTimer = null;
    try { triggerInvisibleContinue(pi); } catch {}
  }, 0, "auto-continue");
  if (state) state.pendingAutoContinueTimer = timer;
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
  clearTimerHandle(undefined, pendingAutoContinueTimer);
  pendingAutoContinueTimer = null;
  for (const pi of perPiKeys) {
    const state = perPi.get(pi);
    if (state) {
      for (const timer of state.timers) clearTimerHandle(undefined, timer);
      state.timers.clear();
      state.statsHistory = [];
      state.lastStats = null;
      state.lastCompactWasPiVcc = false;
      state.pendingFollowUpPrompt = null;
      state.pendingAutoContinueTimer = null;
    }
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
const resolveGlobalIndex = (ctx: any): Map<string, number> | undefined => {
  try {
    const manager = ctx?.sessionManager;
    if (typeof manager?.getEntries === "function") {
      const entries = manager.getEntries();
      if (Array.isArray(entries)) return buildGlobalIndex(entries as PersistedSessionEntry[]).indexById;
    }
    const sessionFile = typeof manager?.getSessionFile === "function" ? manager.getSessionFile() : undefined;
    if (typeof sessionFile !== "string") return undefined;
    const entries: PersistedSessionEntry[] = [];
    const scan = scanSessionEntries(sessionFile, (entry) => entries.push(entry as PersistedSessionEntry));
    if (scan.missing) return undefined;
    return buildGlobalIndex(entries).indexById;
  } catch {
    return undefined;
  }
};

const trustedFullContextTokens = (branchEntries: any[], preparation: any, ctx: any): number | undefined => {
  let boundary = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i]?.type === "compaction" || branchEntries[i]?.type === "reset_boundary") {
      boundary = i;
      break;
    }
  }
  for (let i = branchEntries.length - 1; i > boundary; i--) {
    const entry = branchEntries[i];
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const usage = message.usage;
    if (!usage || typeof usage !== "object") continue;
    const expectedModel = ctx?.model?.id;
    const actualModel = typeof message.model === "string" ? message.model : undefined;
    if (expectedModel && actualModel && expectedModel !== actualModel) continue;
    const authoritative = typeof preparation?.tokensBefore === "number" && preparation.tokensBefore > 0
      ? preparation.tokensBefore
      : typeof usage.contextTokens === "number" && Number.isFinite(usage.contextTokens) && usage.contextTokens > 0
        ? usage.contextTokens
        : undefined;
    if (authoritative === undefined) continue;
    let postAnchor = 0;
    for (let j = i + 1; j < branchEntries.length; j++) {
      const post = branchEntries[j];
      if (post?.type !== "message") continue;
      postAnchor += estimateScriptAwareMessageContentTokens(post.message?.content);
    }
    return Math.max(0, authoritative + postAnchor);
  }
  return undefined;
};
const sourceIndicesFor = (selectedIds: Array<string | undefined>, indexById?: Map<string, number>): Array<number | undefined> =>
  selectedIds.map((id) => id && indexById ? indexById.get(id) : undefined);

const convertSelectedMessages = (
  selectedMessages: any[],
  selectedIds: Array<string | undefined>,
  sourceIndices: Array<number | undefined>,
): { messages: any[]; sourceIndices: Array<number | undefined> } => {
  const messages: any[] = [];
  const aligned: Array<number | undefined> = [];
  for (let i = 0; i < selectedMessages.length; i++) {
    const converted = convertToLlm([selectedMessages[i]]);
    for (const message of converted) {
      messages.push(message);
      aligned.push(sourceIndices[i]);
    }
  }
  return { messages, sourceIndices: aligned };
};
export const __convertSelectedMessagesForTests = convertSelectedMessages;
const nativeMemoryQuery = (branchEntries: any[]): string => {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "user") continue;
    let text = "";
    if (typeof message.content === "string") text = message.content;
    else if (Array.isArray(message.content)) {
      text = message.content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n");
    }
    if (text.trim()) return text.trim().slice(0, 2_000);
  }
  return "";
};

const nativeMemoryBlock = (ctx: any, event: any, branchEntries: any[], settings: PiVccSettings): string | Promise<string> => {
  if (!settings.nativeMemory || !ctx?.memory || typeof ctx.memory.search !== "function") return "";
  if (event?.signal?.aborted) return "";
  const query = nativeMemoryQuery(branchEntries);
  if (!query) return "";
  const format = (result: any): string => {
    const root = result as any;
    const items = Array.isArray(result) ? result : Array.isArray(root?.items) ? root.items : Array.isArray(root?.results) ? root.results : [];
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const raw of items) {
      if (lines.length >= 8) break;
      const item = raw as any;
      const content = typeof item?.content === "string" ? item.content : typeof item?.text === "string" ? item.text : "";
      if (!content) continue;
      const id = typeof item?.id === "string" ? item.id : undefined;
      const source = typeof item?.source === "string" ? item.source : undefined;
      const key = id ?? `${source ?? ""}\u0000${content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const metadata = [id ? `id=${id}` : undefined, source ? `source=${source}` : undefined].filter(Boolean).join(" ");
      lines.push(`- ${metadata ? `${metadata}: ` : ""}${content.slice(0, 500)}`);
    }
    if (lines.length === 0) return "";
    return `[Host Memory]\n${lines.join("\n")}`.slice(0, 4_000);
  };
  const fail = (error: unknown): string => {
    dbg(settings, { nativeMemory: "error", errorClass: error instanceof Error ? error.name : typeof error });
    logMetrics(settings, { event: "native-memory", status: "error", errorClass: error instanceof Error ? error.name : typeof error });
    return "";
  };
  try {
    const result = ctx.memory.search(query, { limit: 8, signal: event.signal });
    return result && typeof result.then === "function" ? Promise.resolve(result).then(format, fail) : format(result);
  } catch (error) {
    return fail(error);
  }
};

const injectBeforeRecallNote = (summary: string, memoryBlock: string): string => {
  if (!memoryBlock) return summary;
  const marker = summary.lastIndexOf("\n\n---\n\n");
  return marker >= 0 ? `${summary.slice(0, marker)}\n\n${memoryBlock}${summary.slice(marker)}` : `${summary}\n\n${memoryBlock}`;
};

const clipUtf8 = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
  let out = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) return { text: out, truncated: true };
    out += character;
    bytes += size;
  }
  return { text: out, truncated: false };
};


const capturePreCompactionDisplay = (pi: any, selectedMessages: any[], selectedIds: Array<string | undefined>): void => {
  for (let i = selectedMessages.length - 1; i >= 0; i--) {
    const message = selectedMessages[i];
    if (message?.role !== "assistant") continue;
    let text = "";
    if (typeof message.content === "string") text = message.content;
    else if (Array.isArray(message.content)) {
      text = message.content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n");
    }
    text = sanitize(text).replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "").replace(/[\u0080-\u009f]/g, "");
    if (!text) continue;
    const clipped = clipUtf8(text, 16 * 1024);
    const state = getPerPi(pi);
    if (state) state.pendingDisplay = { text: clipped.text, sourceEntryId: selectedIds[i], truncated: clipped.truncated };
    return;
  }
};

export function scheduleCompactionStatsNotify(pi: any, ctx: any, stats: CompactionStats): void;
export function scheduleCompactionStatsNotify(ctx: any, stats: CompactionStats): void;
export function scheduleCompactionStatsNotify(piOrCtx: any, ctxOrStats: any, maybeStats?: CompactionStats): void {
  const hasManagedContext = maybeStats !== undefined;
  const pi = hasManagedContext ? piOrCtx : undefined;
  const ctx = hasManagedContext ? ctxOrStats : piOrCtx;
  const stats: CompactionStats = maybeStats ?? ctxOrStats;
  const notify = () => {
    try {
      ctx?.ui?.notify?.(formatCompactionStats(stats), "info");
    } catch {}
  };
  if (hasManagedContext) scheduleManaged(pi, ctx, notify, 500, "stats");
  else setTimeout(notify, 500);
}

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
const METRICS_MAX_BYTES = 10 * 1024 * 1024;
const logMetrics = (settings: PiVccSettings, data: Record<string, unknown>): void => {
  if (!settings.debugLog) return;
  try {
    const path = join(dirname(getSettingsPath()), "debug-metrics.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    const line = `${JSON.stringify({ timestamp: Date.now(), ...data })}\n`;
    let size = 0;
    try { size = statSync(path).size; } catch {}
    if (size > 0 && size + Buffer.byteLength(line, "utf8") > METRICS_MAX_BYTES) {
      try { rmSync(`${path}.1`, { force: true }); } catch {}
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, line, "utf8");
  } catch {}
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

/** Join parts with "\n" truncated to `bound` chars — byte-identical to
 *  `parts.join("\n").slice(0, bound)` without materializing the full
 *  joined string (calibration samples join up to 50 message contents,
 *  any one of which can be megabytes). */
export const joinBounded = (parts: string[], bound: number): string => {
  let out = "";
  let rem = bound;
  for (let i = 0; i < parts.length; i++) {
    if (rem <= 0) break;
    if (i > 0) {
      out += "\n";
      rem--;
      if (rem <= 0) break;
    }
    const take = parts[i].slice(0, rem);
    out += take;
    rem -= take.length;
  }
  return out;
};

interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}
const selectedEntryId = (entry: { id?: unknown }): string | undefined =>
  typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;


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
      selectedIds: Array<string | undefined>;
    }
  | { ok: false; reason: OwnCutCancelReason };

export const collectLiveMessages = (branchEntries: any[]): EntryWithMessage[] => {
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

export function buildOwnCut(branchEntries: any[], keepUserTurns = 1, explicitKeep = false): OwnCutResult {
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
    selectedIds: liveMessages.map((e) => selectedEntryId(e.entry)),
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
    // Explicit keep covering every user turn: keep the whole tail instead of
    // compacting it away. Only the prefix before the first user turn (when
    // any) is summarized. Default-path cuts and no-user-message sessions keep
    // the old compact-all fallback so auto-compaction still makes progress
    // (single-prompt + autonomous tail) and explicit compacts in autonomous
    // sessions still do something.
    if (explicitKeep && userIndices.length > 0) {
      const firstUserIdx = userIndices[0];
      return {
        ok: true,
        messages: liveMessages.slice(0, firstUserIdx).map((e) => e.message),
        selectedIds: liveMessages.slice(0, firstUserIdx).map((e) => selectedEntryId(e.entry)),
        firstKeptEntryId: liveMessages[firstUserIdx].entry.id,
        compactAll: false,
        keptUserTurns: userIndices.length,
        totalUserTurns: userIndices.length,
        requestedKeepUserTurns: normalizedKeepUserTurns,
        keepFallbackToCompactAll: false,
      };
    }
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return compactAll(true);
  }
  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    selectedIds: liveMessages.slice(0, cutIdx).map((e) => selectedEntryId(e.entry)),
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
    acc += estimateScriptAwareMessageContentTokens(live[i].message.content);
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
    selectedIds: live.slice(0, idx).map((m) => selectedEntryId(m.entry)),
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
    tailTokens += estimateScriptAwareMessageContentTokens(live[i].message.content);
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
  // Null when keep would trigger compact-all, cancel, or summarize nothing
  // (keep-all cut with an empty prefix): the resolver stops growing instead
  // of selecting a value that discards the tail or compacts nothing new.
  if (!cut.ok || cut.compactAll || cut.messages.length === 0) return null;
  // Measure over the live window (message + custom_message/branch_summary via
  // toLiveMessage), not branchEntries filtered to type === "message": custom
  // tails otherwise undercount and smart-keep over-grows (under-compaction).
  const live = collectLiveMessages(branchEntries);
  const keptIdx = live.findIndex((e) => e.entry.id === cut.firstKeptEntryId);
  if (keptIdx < 0) return null;
  return live.slice(keptIdx).reduce(
    (sum: number, e) => sum + estimateScriptAwareMessageContentTokens(e.message?.content),
    0,
  );
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
  pi.on("context", (event, ctx) => {
    let messages = event.messages;
    const filtered = event.messages.filter((message) => {
      if (message.role !== "custom") return true;
      return message.customType !== AUTO_CONTINUE_CUSTOM_TYPE && message.customType !== LEGACY_AUTO_CONTINUE_CUSTOM_TYPE;
    });
    if (filtered.length !== event.messages.length) messages = filtered;
    let entries: any[] = [];
    try {
      const branch = ctx?.sessionManager?.getBranch?.();
      if (Array.isArray(branch)) entries = branch;
      else {
        const value = ctx?.sessionManager?.getEntries?.();
        if (Array.isArray(value)) entries = value;
      }
    } catch {}
    const latest = [...entries].reverse().find((entry) => entry?.type === "compaction");
    if (latest && typeof latest.summary === "string") {
      if (isPiVccAppendDetails(latest.details)) {
        const chain = collectActiveSegments(entries, { fallbackSummary: latest.summary });
        if (chain) {
          const projected = projectAppendOnlyContext({ messages, chain, fallbackSummary: latest.summary });
          if (projected !== messages) messages = projected;
        }
      }
      const projection: RetainedToolOutputProjection | undefined = latest.details?.retainedToolOutputProjection;
      if (projection) {
        const serializedByEntryId: Record<string, string> = {};
        const omissionToolCallIds: Record<string, string> = {};
        for (const entry of entries) {
          if (entry?.type !== "message" || typeof entry.id !== "string") continue;
          try { serializedByEntryId[entry.id] = JSON.stringify(entry.message); } catch {}
          if (typeof entry.message?.toolCallId === "string") omissionToolCallIds[entry.id] = entry.message.toolCallId;
        }
        const projected = applyRetainedToolOutputProjection(messages, projection, { serializedByEntryId, omissionToolCallIds });
        if (projected !== messages) messages = projected;
      }
    }
    if (messages !== event.messages) return { messages };
  });

  for (const eventName of ["session_start", "session_switch", "session_branch", "session_shutdown"]) {
    pi.on(eventName, (_event, ctx) => advanceSessionGeneration(pi, ctx));
  }
  pi.on("auto_compaction_start", (event, ctx) => {
    const state = getPerPi(pi);
    if (!state) return;
    state.autoCompaction = {
      generation: state.generation,
      sessionId: state.sessionId ?? sessionIdOf(ctx),
      reason: typeof (event as any)?.reason === "string" ? (event as any).reason : "unknown",
      action: typeof (event as any)?.action === "string" ? (event as any).action : "unknown",
      willRetry: false,
    };
  });
  pi.on("auto_compaction_end", (event, ctx) => {
    const state = getPerPi(pi);
    if (!state) return;
    const auto = state.autoCompaction;
    state.autoCompaction = undefined;
    logMetrics(loadSettings(ctx), {
      event: "auto-compaction-end",
      action: (event as any)?.action,
      aborted: (event as any)?.aborted === true,
      willRetry: (event as any)?.willRetry === true,
      generation: auto?.generation,
    });
  });

  pi.on("before_agent_start", (_event, ctx) => {
    clearPendingAutoContinueForPi(pi, ctx);
  });

  pi.on("session_before_compact", (event, ctx) => {
    const attemptState = getPerPi(pi);
    const attemptGeneration = attemptState?.generation ?? 0;
    const attemptSessionId = sessionIdOf(ctx);
    const attemptCurrent = (): boolean => !event?.signal?.aborted && isCurrentGeneration(pi, ctx, attemptGeneration, attemptSessionId);
    const settingsResult = loadSettingsWithPluginOverlay(ctx);
    const runBefore = (settings: PiVccSettings) => {
      if (!attemptCurrent()) return;
      if (attemptState) {
        attemptState.pendingCompactionFingerprint = undefined;
        attemptState.pendingPreviousStats = attemptState.lastStats;
        attemptState.pendingStatsHistoryLength = attemptState.statsHistory.length;
      }
      if (attemptState) {
        attemptState.pendingDisplay = undefined;
        attemptState.lastSettings = settings;
      }
      const { preparation, branchEntries, customInstructions } = event;
      const eventContext = readCompactionEventContext(event);
      const auto = attemptState?.autoCompaction;
      const autoReason = auto?.reason === "threshold" || auto?.reason === "overflow" || auto?.reason === "manual" ? auto.reason : undefined;
      const reason = eventContext.reason ?? autoReason;
      const willRetry = eventContext.willRetry || auto?.willRetry === true;
      if (!settings.vccEnabled) return;

    // Always handle explicit /pi-vcc or /omp-vcc marker.
    // Otherwise, only handle when user opted in via settings.
    const { isPiVcc, keepUserTurns, keepUserTurnsExplicit, followUpPrompt } = parseCompactionInstructions(customInstructions);
    // Explicit host mode bypass: when the host signals an explicit compact mode
    // via an event field, let the host walker handle it even though
    // overrideDefaultCompaction is true. This enables sequential VCC →
    // snapcompact/shake combinations. No shipped host exposes such a field
    // today — omp carries the mode in the compact() options (never the event)
    // and pi has no modes (its /compact text is raw focus instructions, so
    // lone mode words must NEVER bypass: on pi `/compact shake` means
    // "focus on shake"). The branch stays as the contract for the optional
    // native patch / future hosts; unpatched, override:true serves explicit
    // omp modes via VCC (use override:false for native modes).
    const explicitMode = (event as any).compactMode ?? (event as any).explicitMode ?? (event as any).mode;
    if (!isPiVcc && typeof explicitMode === "string" && explicitMode) {
      const m = explicitMode.toLowerCase();
      if (m === "snapcompact" || m === "shake" || m === "soft" || m === "remote" || m === "handoff") return;
    }
    // Chain-shake yield: while a {mode:"shake"} chain is in flight (see
    // session_compact below), let the host run it — otherwise VCC would
    // swallow the modeless call into a second VCC pass. Sentinel compactions
    // still handled (isPiVcc path falls through below).
    if (!isPiVcc && pendingChainShake.has(pi as unknown as object)) return;
    if (!isPiVcc && !settings.overrideDefaultCompaction) return;
    const memoryResult = nativeMemoryBlock(ctx, event, branchEntries as any[], settings);
    function runBody(memoryBlock: string) {
      if (!attemptCurrent()) return;

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
    // Content samples for the mismatch guards: head text (first 50 mapped
    // contents — string content or "" per message) plus tail text (last 50).
    // A prose head with a dense tail is the exact shape that under-reported
    // kept tails, so density is checked on both ends. Bounded (8k chars each):
    // only the sampled windows are joined, never the whole transcript.
    const calibrationMsgs = calibrationCut.ok ? calibrationCut.messages : [];
    const headContents: string[] = [];
    for (let i = 0; i < calibrationMsgs.length && headContents.length < 50; i++) {
      const c = (calibrationMsgs[i] as any).content;
      headContents.push(typeof c === "string" ? c : "");
    }
    const tailContents: string[] = [];
    for (let i = Math.max(0, calibrationMsgs.length - 50); i < calibrationMsgs.length; i++) {
      const c = (calibrationMsgs[i] as any).content;
      tailContents.push(typeof c === "string" ? c : "");
    }
    const calibrationSample = joinBounded(headContents, 8000);
    const calibrationTailSample = joinBounded(tailContents, 8000);
    const tokenEstimate = calibrateCharsPerToken(
      calibrationMessageChars + calibrationSummaryChars,
      preparation.tokensBefore,
      calibrationSample || (typeof preparation.previousSummary === "string" ? preparation.previousSummary.slice(0, 8000) : undefined),
      calibrationTailSample || undefined,
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
    let ownCut = buildOwnCut(branchEntries as any[], smartKeep.keepUserTurns, keepUserTurnsExplicit);
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
    const globalIndexById = resolveGlobalIndex(ctx);
    const selectedSourceIndices = sourceIndicesFor(ownCut.selectedIds, globalIndexById);
    const converted = convertSelectedMessages(agentMessages, ownCut.selectedIds, selectedSourceIndices);
    const messages = converted.messages;
    const sourceIndices = converted.sourceIndices;

    // Count kept messages and estimate tokens with the script-aware estimator.
    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptTokensEst = keptEntries.reduce(
      (sum: number, entry: any) => sum + estimateScriptAwareMessageContentTokens(entry.message?.content),
      0,
    );
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
    let summary = compileRanked({
      messages,
      sourceIndices,
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
    summary = injectBeforeRecallNote(summary, memoryBlock);

    // Keep-all cut with an empty prefix and no previous summary yields nothing
    // new to summarize. Never hand the host an empty summary — cancel and keep
    // the session intact. (A non-empty prefix that compiles to "" falls through
    // with the pre-existing behavior; custom-only prefixes carry no sections.)
    if (!summary && agentMessages.length === 0) {
      try {
        ctx?.ui?.notify?.("omp-vcc: Nothing new to compact (keep covers all turns)", "info");
      } catch {}
      return { cancel: true };
    }

    // Growth guard: never emit a summary that materially adds more than it
    // removes. tokensAfter - tokensBefore ≈ (netNew - prefix) / cpt: the kept
    // tail cancels out, so the comparison is calibration-independent and
    // exact in chars (plan-mode "compact and execute" grew 85K→87K: a 2-msg
    // prefix replaced by a fixed-cost summary + brief floor). Compare the
    // net-new content (summary minus carried-forward previous summary, which
    // is already counted in the live context) against the removed prefix.
    // Fires only on material growth — a fixed framing allowance or 25% of the
    // prefix (host accounting noise), or the absolute cap (~1k tok) at any
    // ratio. On overflow/willRetry the window is exhausted and SOME compaction
    // must happen: abstain (host default proceeds) instead of cancelling.
    const summaryChars = summary.length;
    const prefixChars = agentMessages.reduce(
      (sum: number, message: any) => sum + estimateMessageContentChars(message.content),
      0,
    );
    const prevSummaryChars = typeof preparation.previousSummary === "string"
      ? preparation.previousSummary.length
      : 0;
    const netNewSummaryChars = summaryChars - Math.min(summaryChars, prevSummaryChars);
    const guard = evaluateGrowthGuard(prefixChars, netNewSummaryChars);
    const { netGrowthChars, toleranceChars } = guard;
    if (guard.trip) {
      const prefixTok = agentMessages.reduce(
        (sum: number, message: any) => sum + estimateScriptAwareMessageContentTokens(message.content),
        0,
      );
      const netNewTok = estimateScriptAwareTokens(String(Math.max(0, netNewSummaryChars)));
      dbg(settings, {
        growthGuard: true,
        cancelled: reason !== "overflow" && !willRetry,
        fallbackToCore: reason === "overflow" || willRetry,
        compaction: { reason, willRetry },
        prefixChars,
        prevSummaryChars,
        netNewSummaryChars,
        netGrowthChars,
        toleranceChars,
      });
      try {
        ctx?.ui?.notify?.(
          `omp-vcc: compaction would grow context (prefix ~${formatTokens(prefixTok)} tok, summary adds ~${formatTokens(netNewTok)} tok) — ${reason === "overflow" || willRetry ? "deferring to host compaction" : "cancelled"}`,
          "info",
        );
      } catch {}
      if (reason === "overflow" || willRetry) return;
      return { cancel: true };
    }

    const tokensBefore = typeof preparation.tokensBefore === "number" ? preparation.tokensBefore : 0;
    const summaryTokensEst = estimateScriptAwareTokens(summary);
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
    const retainedCandidates = collectLiveMessages(branchEntries as any[]).map(({ entry, message }) => ({ id: entry.id, type: entry.type, message }));
    const retainedProjection = buildRetainedToolOutputProjection(retainedCandidates, settings.retainedToolOutputMaxTokens, globalIndexById);

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
    const appendMode = settings.compactionSummaryMode === "append";
    const latestCompaction = [...branchEntries].reverse().find((entry: any) => entry?.type === "compaction");
    const hasPriorCompaction = latestCompaction !== undefined;
    const previousChain = appendMode && hasPriorCompaction && typeof preparation.previousSummary === "string"
      ? collectActiveSegments(branchEntries, { fallbackSummary: preparation.previousSummary })
      : null;
    const legacyRewriteBase = isPiVcc && hasPriorCompaction
      && (latestCompaction?.details?.compactor === "omp-vcc" || latestCompaction?.details?.compactor === "pi-vcc")
      && latestCompaction?.details?.version === 2
      && typeof preparation.previousSummary === "string"
      && latestCompaction.summary === preparation.previousSummary;
    const appendEligible = appendMode && (!hasPriorCompaction || previousChain !== null || legacyRewriteBase);
    const freshSummary = appendEligible
      ? compileSegment({
          messages,
          sourceIndices,
          fileOps: {
            readFiles: [...preparation.fileOps.read],
            modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
          },
        })
      : "";
    const appendCoverage = appendEligible
      ? coverageForMessages({ selectedIds: ownCut.selectedIds, firstKeptEntryId, sourceMessageCount: agentMessages.length })
      : null;
    const contextWindow = typeof ctx?.model?.contextWindow === "number" && Number.isFinite(ctx.model.contextWindow) && ctx.model.contextWindow > 0
      ? ctx.model.contextWindow
      : undefined;
    const reserveTokens = typeof preparation.settings?.reserveTokens === "number" ? preparation.settings.reserveTokens : undefined;
    const chainTokens = (previousChain ? estimateChainTokens(previousChain) : 0) + estimateScriptAwareTokens(freshSummary);
    const rebaseChainTokens = estimateScriptAwareTokens(summary);
    const thresholds = compactionThresholds(contextWindow, reserveTokens);
    const fullContextTokens = trustedFullContextTokens(branchEntries, preparation, ctx);
    const pressure = chainTokens >= thresholds.chainThreshold
      || (thresholds.contextThreshold !== undefined && fullContextTokens !== undefined && fullContextTokens >= thresholds.contextThreshold)
      || (thresholds.capacity !== undefined && fullContextTokens !== undefined && fullContextTokens > thresholds.capacity);
    const decision = decideAppendMode({
      manual: isPiVcc,
      overflow: reason === "overflow",
      willRetry,
      pressure,
      chainTokens,
      rebaseChainTokens,
      contextWindow,
      reserveTokens,
      fullContextTokens,
    });
    const appendDetails = appendEligible && appendCoverage && freshSummary
      ? buildAppendOnlyDetails({
          segment: { summary: freshSummary, coverage: appendCoverage, tokensBefore },
          chainStart: !previousChain || decision.mode === "rebase",
          trailingSummary: summary,
          sections: extractKnownSections(summary),
          sourceMessageCount: agentMessages.length,
          previousSummaryUsed: Boolean(previousChain) || legacyRewriteBase,
          previous: decision.mode === "rebase" ? null : previousChain,
          retainedToolOutputProjection: retainedProjection,
        })
      : null;
    if (appendDetails) {
      Object.assign(appendDetails, {
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
      });
    }
    logMetrics(settings, {
      event: "append-decision",
      mode: decision.mode,
      chainStart: !previousChain || decision.mode === "rebase",
      pressure,
      chainTokens,
      rebaseChainTokens,
      retainedTokens: retainedProjection?.retainedTokens ?? 0,
      omittedTokens: retainedProjection?.omittedTokens ?? 0,
      pendingCount: retainedProjection?.pendingCount ?? 0,
    });


    const details = appendDetails ?? {
      compactor: "omp-vcc",
      version: 2,
      sections: extractKnownSections(summary),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      retainedToolOutputProjection: retainedProjection,
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
    capturePreCompactionDisplay(pi, agentMessages, ownCut.selectedIds);

    setLastCompactWasPiVcc(pi, isPiVcc);

    const compaction = {
      summary,
      details,
      tokensBefore: preparation.tokensBefore,
      firstKeptEntryId,
    };
    if (attemptState) {
      attemptState.pendingCompactionFingerprint = JSON.stringify({
        summary: compaction.summary,
        firstKeptEntryId: compaction.firstKeptEntryId,
        details: compaction.details,
      });
    }
    return { compaction };
    };
    if (typeof memoryResult !== "string") return memoryResult.then((memoryBlock) => {
      if (!attemptCurrent()) return;
      return runBody(memoryBlock);
    });
    return runBody(memoryResult);
    };
    if (settingsResult && typeof (settingsResult as any).then === "function") {
      return settingsResult.then((settings) => {
        if (!attemptCurrent()) return;
        return runBefore(settings);
      });
    }
    return runBefore(settingsResult as PiVccSettings);
  });
  pi.on("session_compact", async (event, ctx) => {
    const per = getPerPi(pi);
    const generation = per?.generation ?? 0;
    const sessionId = per?.sessionId ?? sessionIdOf(ctx);
    const isCurrent = () => isCurrentGeneration(pi, ctx, generation, sessionId);
    const settings = await loadSettingsWithPluginOverlay(ctx);
    if (!isCurrent()) return;
    const entry: any = (event as any).compactionEntry;
    const committedFingerprint = entry
      ? JSON.stringify({ summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId, details: entry.details })
      : undefined;
    const pendingFingerprint = per?.pendingCompactionFingerprint;
    const legacyCompletionShape = !entry || (entry.summary === undefined && entry.details === undefined);
    const ownsCompaction = event.fromExtension === true
      && (!pendingFingerprint || committedFingerprint === pendingFingerprint || legacyCompletionShape);
    const pendingDisplay = per?.pendingDisplay;
    const followUpPrompt = getPendingFollowUpPrompt(pi);
    if (per) {
      if (!ownsCompaction && pendingFingerprint && per.pendingStatsHistoryLength !== undefined) {
        per.statsHistory.length = per.pendingStatsHistoryLength;
        per.lastStats = per.pendingPreviousStats;
      }
      per.pendingDisplay = undefined;
      per.pendingCompactionFingerprint = undefined;
      per.pendingPreviousStats = undefined;
      per.pendingStatsHistoryLength = undefined;
    }
    setPendingFollowUpPrompt(pi, null);
    if (!ownsCompaction) return;
    if (pendingDisplay && settings.showPreCompactionMessage) {
      try { ctx?.ui?.notify?.(`[Previous output — display only]\n${pendingDisplay.text}`, "info"); } catch {}
    }
    const stats = per ? per.lastStats : lastStats;
    if (!stats) return;
    if (entry && typeof entry.tokensAfter === "number" && typeof entry.tokensBefore === "number") {
      const before = entry.tokensBefore;
      const after = entry.tokensAfter;
      const saved = Math.max(0, before - after);
      const percent = before > 0 && saved > 0 ? Math.round((saved / before) * 100) : 0;
      if (per?.lastStats) {
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
        if (settings.debug) {
          dbg(settings, {
            authoritativeSavings: { tokensBefore: before, tokensAfter: after, tokensSaved: saved, savedPercent: percent },
            eventEntry: { id: entry.id, tokensBefore: entry.tokensBefore, tokensAfter: entry.tokensAfter },
          });
        }
      } catch {}
    }
    const isPiVccLast = per ? per.lastCompactWasPiVcc : lastCompactWasPiVcc;
    if (isPiVccLast) {
      if (per) per.lastCompactWasPiVcc = false;
      else lastCompactWasPiVcc = false;
      return;
    }
    const auto = per?.autoCompaction;
    const hostOwnsContinuation = auto?.generation === generation && (auto.sessionId ?? sessionIdOf(ctx)) === sessionId;
    const eventContext = readCompactionEventContext(event);
    const autoReason = auto?.reason === "threshold" || auto?.reason === "overflow" ? auto.reason : undefined;
    const reason = eventContext.reason ?? autoReason;
    const willRetry = eventContext.willRetry || auto?.willRetry === true;
    const isLargeCompaction = (stats.summarized > 10) || (stats.kept > 5) || (stats.keptTokensEst > 2000);
    const shouldContinueAfterAutoCompact = !hostOwnsContinuation
      && (reason === "threshold" || reason === "overflow" || (reason == null && isLargeCompaction))
      && settings.continueAfterThresholdCompact;
    if (willRetry) return;
    scheduleCompactionStatsNotify(pi, ctx, stats);
    if (hostOwnsContinuation) return;
    try {
      const ctxMaybe = ctx as unknown as Record<string, unknown>;
      const compactFn = ctxMaybe["compact"];
      const promptOf = ctxMaybe["getSystemPrompt"] as ((this: unknown) => unknown) | undefined;
      const chainForm = getCompactForm(() => promptOf?.call(ctx));
      if (settings.chainShakeHint && chainForm === "string" && typeof compactFn === "function" && !pendingChainShake.has(pi as unknown as object) && !willRetry) {
        pendingChainShake.add(pi as unknown as object);
        const startShake = () => {
          try {
            const maybePromise = (compactFn as unknown as (o: unknown) => Promise<void>).call(ctx, { mode: "shake" } as unknown);
            const asPromise = maybePromise as unknown as Promise<void> | void;
            if (asPromise && typeof (asPromise as unknown as Promise<void>).catch === "function") {
              (asPromise as unknown as Promise<void>).catch(() => { pendingChainShake.delete(pi as unknown as object); });
            }
          } catch {
            pendingChainShake.delete(pi as unknown as object);
          }
        };
        if (typeof ctx?.setTimeout === "function") scheduleManaged(pi, ctx, startShake, 5, "chain-shake-start");
        else startShake();
        scheduleManaged(pi, ctx, () => { try { pendingChainShake.delete(pi as unknown as object); } catch {} }, 2000, "chain-shake-cleanup");
      }
    } catch {}
    if (followUpPrompt) {
      try {
        const sent = (pi as any).sendUserMessage?.(followUpPrompt) as Promise<void> | undefined;
        if (sent && typeof sent.catch === "function") sent.catch(() => {});
      } catch {}
    } else if (shouldContinueAfterAutoCompact) {
      scheduleAutoContinueForPi(pi, ctx);
    }
  });
};

// ── Recall tool & commands — re-exported for pi-vcc test compatibility (paper V_adapt) ──

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

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
// ── /vcc-config command — show effective configuration with per-key source ──
export const formatVccConfigCard = (view: VccConfigView): string => {
  const header = `**omp-vcc config** (\`${view.path}\`)`;
  const status = !view.filePresent
    ? "No config file found — showing defaults."
    : !view.fileValid
      ? "Config file unparseable — showing defaults."
      : view.readPath === view.path
        ? `Source: file ${view.readPath}`
        : `Source: fallback file ${view.readPath}`;
  const lines = (Object.keys(DEFAULT_SETTINGS) as (keyof PiVccSettings)[]).map((key) => {
    const value = view.values[key];
    const display = typeof value === "number" ? String(value) : typeof value === "string" ? value : value ? "on" : "off";
    return `- ${key}: ${display} (${view.sources[key] === "overlay" ? "host overlay" : view.sources[key]})`;
  });
  return [header, status, ...lines].join("\n");
};

export const registerVccConfigCommand = (pi: any) => {
  const handler = async (_args: string, ctx: any) => {
    // args deliberately ignored — always show the effective config
    const view = await loadSettingsWithSourcesAsync(ctx);
    const output = formatVccConfigCard(view);
    const piAny = pi as unknown as { sendMessage?: (msg: unknown, opts?: unknown) => void };
    try { piAny.sendMessage?.({ customType: "vcc-config", content: output, display: true }, { triggerTurn: false }); } catch {}
    try { ctx?.ui?.notify?.(`vcc_config: ${Object.keys(view.values).length} keys from ${view.readPath ?? "defaults"}`, "info"); } catch {}
  };
  pi.registerCommand("vcc-config", { description: "Show omp-vcc effective configuration with per-key source", handler });
};