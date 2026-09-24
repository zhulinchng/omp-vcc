// @ts-nocheck
import type { PiVccAppendDetails, PiVccAppendSegment } from "../details";
import { estimateScriptAwareTokens } from "./token-estimate";

export type ChainEntry = Record<string, unknown>;

export interface ActiveCompactionChain {
  details: PiVccAppendDetails[];
  segments: PiVccAppendSegment[];
  trailingSummary: string;
  fallbackSummary?: string;
}

export interface CollectActiveSegmentsOptions {
  /** The complete summary returned to the host for the latest compaction. */
  fallbackSummary?: string;
}

export interface CoverageForMessagesInput {
  selectedIds: Array<string | undefined>;
  firstKeptEntryId: string;
  sourceMessageCount?: number;
}

export interface AppendDetailsInput {
  segment: Omit<PiVccAppendSegment, "sequence">;
  chainStart: boolean;
  trailingSummary: string;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  previous?: ActiveCompactionChain | null;
  retainedToolOutputProjection?: PiVccAppendDetails["retainedToolOutputProjection"];
}

export interface CompactionThresholds {
  contextWindow?: number;
  chainThreshold: number;
  contextThreshold?: number;
  minimumSaving: number;
  capacity?: number;
}

export interface CompactionDecisionInput {
  manual?: boolean;
  overflow?: boolean;
  willRetry?: boolean;
  pressure?: boolean;
  chainTokens: number;
  rebaseChainTokens?: number;
  contextWindow?: number;
  reserveTokens?: number;
  fullContextTokens?: number;
}

export interface CompactionDecision {
  chainStart: boolean;
  mode: "append" | "rebase";
  pressure: boolean;
  capacityPressure: boolean;
  chainThreshold: number;
  contextThreshold?: number;
  minimumSaving: number;
  capacity?: number;
  chainTokens: number;
  rebaseChainTokens?: number;
  /** Present only when the caller supplied a trusted full-context estimate. */
  fullContextTokens?: number;
}
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

const finiteNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

const uniqueEntryPositions = (entries: ChainEntry[]): Map<string, number> => {
  const positions = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i]?.id;
    if (typeof id !== "string") continue;
    if (positions.has(id)) positions.set(id, -1);
    else positions.set(id, i);
  }
  return positions;
};

const isCompactionEntry = (entry: ChainEntry): boolean => entry.type === "compaction";

/** Runtime parser for the immutable v3 persisted details record. */
export const isPiVccAppendDetails = (value: unknown): value is PiVccAppendDetails => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.compactor !== "omp-vcc" || candidate.version !== 3 || candidate.summaryMode !== "append") return false;
  if (typeof candidate.chainStart !== "boolean" || typeof candidate.trailingSummary !== "string") return false;
  if (!nonEmptyString(candidate.trailingSummary)) return false;
  if (!Array.isArray(candidate.sections) || !candidate.sections.every(nonEmptyString)) return false;
  if (typeof candidate.sourceMessageCount !== "number" || !Number.isInteger(candidate.sourceMessageCount) || candidate.sourceMessageCount < 0) return false;
  if (typeof candidate.previousSummaryUsed !== "boolean" || candidate.segment === null || typeof candidate.segment !== "object" || Array.isArray(candidate.segment)) return false;
  const segment = candidate.segment as Record<string, unknown>;
  if (typeof segment.sequence !== "number" || !Number.isInteger(segment.sequence) || segment.sequence < 1) return false;
  if (!nonEmptyString(segment.summary) || !finiteNonNegative(segment.tokensBefore)) return false;
  if (segment.coverage === null || typeof segment.coverage !== "object" || Array.isArray(segment.coverage)) return false;
  const coverage = segment.coverage as Record<string, unknown>;
  if (!nonEmptyString(coverage.firstCoveredEntryId) || !nonEmptyString(coverage.lastCoveredEntryId) || typeof coverage.firstKeptEntryId !== "string") return false;
  if (typeof coverage.sourceMessageCount !== "number" || !Number.isInteger(coverage.sourceMessageCount) || coverage.sourceMessageCount < 1) return false;
  if (coverage.includesLegacySummary !== undefined && typeof coverage.includesLegacySummary !== "boolean") return false;
  if (coverage.rebasedFromCompactionId !== undefined && typeof coverage.rebasedFromCompactionId !== "string") return false;
  if (candidate.retainedToolOutputProjection !== undefined) {
    const projection = candidate.retainedToolOutputProjection;
    if (projection === null || typeof projection !== "object" || Array.isArray(projection)) return false;
    const record = projection as Record<string, unknown>;
    if (record.version !== 1 || !finiteNonNegative(record.retainedTokens) || !finiteNonNegative(record.omittedTokens)) return false;
    if (typeof record.pendingCount !== "number" || !Number.isInteger(record.pendingCount) || record.pendingCount < 0) return false;
    if (!Array.isArray(record.omissions) || !record.omissions.every((value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
        nonEmptyString((value as Record<string, unknown>).entryId) && nonEmptyString((value as Record<string, unknown>).marker))) return false;
  }
  return true;
};

const validCoverageForBranch = (coverage: PiVccAppendSegment["coverage"], positions: Map<string, number>): boolean => {
  const first = positions.get(coverage.firstCoveredEntryId);
  const last = positions.get(coverage.lastCoveredEntryId);
  if (first === undefined || last === undefined || first < 0 || last < 0 || first > last) return false;
  if (coverage.firstKeptEntryId.length === 0) return true;
  const kept = positions.get(coverage.firstKeptEntryId);
  return kept !== undefined && kept > last;
};


/**
 * Collect the append chain ending at the latest compaction. A non-append
 * compaction before the chain start is a legal legacy base; any malformed v3
 * record, summary mismatch, branch mismatch, or sequence gap invalidates the
 * entire chain.
 */
export const collectActiveSegments = (
  branchEntries: ChainEntry[],
  options: CollectActiveSegmentsOptions = {},
): ActiveCompactionChain | null => {
  if (!Array.isArray(branchEntries)) return null;
  const compactions = branchEntries.filter(isCompactionEntry);
  if (compactions.length === 0) return null;
  const collected: Array<{ details: PiVccAppendDetails; compaction: ChainEntry }> = [];
  const positions = uniqueEntryPositions(branchEntries);
  for (let i = compactions.length - 1; i >= 0; i--) {
    const compaction = compactions[i];
    const candidate = compaction.details;
    if (!isPiVccAppendDetails(candidate)) {
      if (collected.length === 0) return null;
      break;
    }
    if (compaction.summary !== candidate.trailingSummary || compaction.firstKeptEntryId !== candidate.segment.coverage.firstKeptEntryId || !validCoverageForBranch(candidate.segment.coverage, positions)) return null;
    collected.push({ details: candidate, compaction });
    if (candidate.chainStart) break;
  }
  if (collected.length === 0 || !collected[collected.length - 1].details.chainStart) return null;
  collected.reverse();
  const details = collected.map((value) => value.details);
  for (let i = 0; i < details.length; i++) {
    if (details[i].segment.sequence !== i + 1 || (i > 0 && details[i].chainStart)) return null;
    if (i > 0 && details[i - 1].segment.coverage.firstKeptEntryId.length > 0 &&
        details[i].segment.coverage.firstCoveredEntryId !== details[i - 1].segment.coverage.firstKeptEntryId) return null;
  }
  const firstCoverage = details[0].segment.coverage;
  if (firstCoverage.rebasedFromCompactionId !== undefined &&
      !compactions.some((value) => value.id === firstCoverage.rebasedFromCompactionId)) return null;
  const latest = details[details.length - 1];
  if (options.fallbackSummary !== undefined && options.fallbackSummary !== latest.trailingSummary) return null;
  return {
    details,
    segments: details.map((detail) => detail.segment),
    trailingSummary: latest.trailingSummary,
    fallbackSummary: latest.trailingSummary,
  };
};

/** Derive immutable coverage from selected ids; an undefined id fails closed. */
export const coverageForMessages = (input: CoverageForMessagesInput): PiVccAppendSegment["coverage"] | null => {
  const ids = input.selectedIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !nonEmptyString(id))) return null;
  const first = ids[0];
  const last = ids[ids.length - 1];
  if (!nonEmptyString(first) || !nonEmptyString(last)) return null;
  const sourceMessageCount = input.sourceMessageCount ?? ids.length;
  if (!Number.isInteger(sourceMessageCount) || sourceMessageCount < 1) return null;
  return {
    firstCoveredEntryId: first,
    lastCoveredEntryId: last,
    firstKeptEntryId: typeof input.firstKeptEntryId === "string" ? input.firstKeptEntryId : "",
    sourceMessageCount,
  };
};

/** Build a v3 details record and reject a missing/invalid prior chain. */
export const buildAppendOnlyDetails = (input: AppendDetailsInput): PiVccAppendDetails | null => {
  if (!input || !input.segment || !nonEmptyString(input.segment.summary) || !nonEmptyString(input.trailingSummary)) return null;
  if (!input.segment.coverage || !nonEmptyString(input.segment.coverage.firstCoveredEntryId) || !nonEmptyString(input.segment.coverage.lastCoveredEntryId)) return null;
  if (typeof input.segment.coverage.firstKeptEntryId !== "string" || input.segment.coverage.sourceMessageCount < 1) return null;
  if (!input.chainStart && (!input.previous || input.previous.segments.length === 0)) return null;
  const priorDetails = input.previous?.details[input.previous.details.length - 1];
  if (!input.chainStart && (!priorDetails || !isPiVccAppendDetails(priorDetails) || priorDetails.segment.sequence !== input.previous?.segments.length)) return null;
  const prior = input.previous?.segments[input.previous.segments.length - 1];
  const sequence = input.chainStart ? 1 : (prior?.sequence ?? 0) + 1;
  if (!Number.isInteger(sequence) || sequence < 1) return null;
  const details: PiVccAppendDetails = {
    compactor: "omp-vcc",
    version: 3,
    summaryMode: "append",
    chainStart: input.chainStart,
    segment: { ...input.segment, sequence },
    trailingSummary: input.trailingSummary,
    sections: input.sections.slice(),
    sourceMessageCount: input.sourceMessageCount,
    previousSummaryUsed: input.previousSummaryUsed,
  };
  if (input.retainedToolOutputProjection !== undefined) details.retainedToolOutputProjection = input.retainedToolOutputProjection;
  return isPiVccAppendDetails(details) ? details : null;
};

export const estimateChainTokens = (chain: ActiveCompactionChain): number => {
  let total = estimateScriptAwareTokens(chain.trailingSummary);
  for (const segment of chain.segments) total += estimateScriptAwareTokens(segment.summary);
  return total;
};

export const compactionThresholds = (contextWindow?: number, reserveTokens?: number): CompactionThresholds => {
  if (!finitePositive(contextWindow)) {
    return { chainThreshold: 34_000, minimumSaving: 24_000 };
  }
  const capacity = typeof reserveTokens === "number" && Number.isFinite(reserveTokens) && reserveTokens >= 0
    ? Math.max(0, contextWindow - reserveTokens)
    : undefined;
  return {
    contextWindow,
    chainThreshold: Math.floor(contextWindow / 8),
    contextThreshold: Math.floor(contextWindow / 2),
    minimumSaving: Math.max(1, Math.min(24_000, Math.floor(24_000 * contextWindow / 272_000))),
    capacity,
  };
};

export const decideAppendMode = (input: CompactionDecisionInput): CompactionDecision => {
  const thresholds = compactionThresholds(input.contextWindow, input.reserveTokens);
  const capacityPressure = thresholds.capacity !== undefined && finiteNonNegative(input.fullContextTokens) && input.fullContextTokens > thresholds.capacity;
  const pressure = input.pressure === true || input.chainTokens >= thresholds.chainThreshold;
  const explicit = input.overflow === true || input.willRetry === true || capacityPressure;
  const rebaseTokens = finiteNonNegative(input.rebaseChainTokens) ? input.rebaseChainTokens : undefined;
  const saving = finiteNonNegative(input.fullContextTokens) && rebaseTokens !== undefined
    ? Math.max(0, input.fullContextTokens - rebaseTokens)
    : undefined;
  let mode: "append" | "rebase" = "append";
  if (input.manual === true) mode = "rebase";
  else if (explicit && rebaseTokens !== undefined) mode = rebaseTokens < input.chainTokens ? "rebase" : "append";
  else if (pressure && saving !== undefined && saving >= thresholds.minimumSaving && (rebaseTokens === undefined || rebaseTokens < input.chainTokens)) mode = "rebase";
  const decision: CompactionDecision = {
    chainStart: input.manual === true && mode === "rebase",
    mode,
    pressure,
    capacityPressure,
    chainThreshold: thresholds.chainThreshold,
    minimumSaving: thresholds.minimumSaving,
    chainTokens: input.chainTokens,
    rebaseChainTokens: rebaseTokens,
  };
  if (thresholds.contextThreshold !== undefined) decision.contextThreshold = thresholds.contextThreshold;
  if (thresholds.contextWindow !== undefined) decision.contextWindow = thresholds.contextWindow;
  if (thresholds.capacity !== undefined) decision.capacity = thresholds.capacity;
  if (finiteNonNegative(input.fullContextTokens)) decision.fullContextTokens = input.fullContextTokens;
  return decision;
};

export const APPEND_SEGMENT_CUSTOM_TYPE = "omp-vcc-append-segment";
export const APPEND_TRAILING_CUSTOM_TYPE = "omp-vcc-append-trailing";

export interface AppendContextProjectionInput {
  messages: ChainEntry[];
  chain: ActiveCompactionChain;
  fallbackSummary: string;
}

/** Replace exactly one host fallback summary with hidden segment + trailing messages. */
export const projectAppendOnlyContext = (input: AppendContextProjectionInput): ChainEntry[] => {
  if (!input || !Array.isArray(input.messages) || !input.chain || !nonEmptyString(input.fallbackSummary)) return input?.messages;
  if (input.fallbackSummary !== input.chain.fallbackSummary && input.fallbackSummary !== input.chain.trailingSummary) return input.messages;
  const matches: number[] = [];
  for (let i = 0; i < input.messages.length; i++) {
    const message = input.messages[i];
    if ((message.role === "compactionSummary" || message.role === "branchSummary") && message.summary === input.fallbackSummary) matches.push(i);
  }
  if (matches.length !== 1) return input.messages;
  const replacement: ChainEntry[] = input.chain.segments.map((segment) => ({
    role: "custom",
    customType: APPEND_SEGMENT_CUSTOM_TYPE,
    display: false,
    content: segment.summary,
  }));
  replacement.push({ role: "custom", customType: APPEND_TRAILING_CUSTOM_TYPE, display: false, content: input.chain.trailingSummary });
  const result = input.messages.slice();
  result.splice(matches[0], 1, ...replacement);
  return result;
};
