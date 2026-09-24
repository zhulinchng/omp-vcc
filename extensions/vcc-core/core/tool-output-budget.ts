// @ts-nocheck
import { estimateScriptAwareTokens } from "./token-estimate";

type UnknownRecord = Record<string, unknown>;

export interface RetainedToolOutputProjection {
  version: 1;
  retainedTokens: number;
  omittedTokens: number;
  pendingCount: number;
  omissions: Array<{ entryId: string; marker: string }>;
}

export interface ToolOutputEntry {
  id?: string;
  type?: string;
  message?: UnknownRecord;
}

export interface RetainedProjectionOptions {
  /** Entry ids aligned with `messages`. Missing ids are allowed. */
  entryIds?: Array<string | undefined>;
  /** Serialized persisted source messages keyed by entry id. */
  serializedByEntryId?: Record<string, string>;
  /** Maps a persisted omission entry id to its tool call id. */
  omissionToolCallIds?: Record<string, string>;
}

const isOutputMessage = (message: UnknownRecord | undefined): boolean => {
  const role = message?.role;
  return role === "toolResult" || (role === "bashExecution" && message?.excludeFromContext !== true);
};

const successfulAssistant = (message: UnknownRecord | undefined): boolean =>
  message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted";

const outputText = (message: UnknownRecord): string => {
  if (message.role === "bashExecution") return typeof message.output === "string" ? message.output : "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part !== null && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
      text += part.text;
    }
  }
  return text;
};

const outputTokens = (message: UnknownRecord): number => estimateScriptAwareTokens(outputText(message));

const uniqueIdCounts = (entries: ToolOutputEntry[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  return counts;
};

/**
 * Select immutable, consumed tool output for the provider-visible retained-tail
 * budget. Entries are message wrappers exactly as persisted by the host.
 */
export const buildRetainedToolOutputProjection = (
  entries: ToolOutputEntry[],
  retainedToolOutputMaxTokens: number,
  globalIndexById?: ReadonlyMap<string, number>,
): RetainedToolOutputProjection => {
  let lastAssistant = -1;
  let pendingCount = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]?.message;
    if (successfulAssistant(message)) {
      lastAssistant = i;
      break;
    }
    if (isOutputMessage(message)) pendingCount++;
  }

  const projection: RetainedToolOutputProjection = {
    version: 1,
    retainedTokens: 0,
    omittedTokens: 0,
    pendingCount,
    omissions: [],
  };
  const limit = Number.isFinite(retainedToolOutputMaxTokens) && retainedToolOutputMaxTokens > 0
    ? Math.floor(retainedToolOutputMaxTokens)
    : 0;
  if (limit === 0 || lastAssistant < 0) return projection;

  const idCounts = uniqueIdCounts(entries);
  let exhausted = false;
  for (let i = lastAssistant - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = entry?.message;
    if (!isOutputMessage(message)) continue;
    const text = outputText(message);
    if (!text) continue;

    // Missing/ambiguous ids cannot be replayed safely. They do not consume the
    // allowance and cannot be persisted as omissions.
    if (typeof entry?.id !== "string" || entry.id.length === 0 || idCounts.get(entry.id) !== 1) continue;

    const tokens = outputTokens(message);
    if (!exhausted && projection.retainedTokens + tokens <= limit) {
      projection.retainedTokens += tokens;
      continue;
    }

    exhausted = true;
    projection.omittedTokens += tokens;
    const globalIndex = globalIndexById?.get(entry.id);
    projection.omissions.push({
      entryId: entry.id,
      marker: Number.isInteger(globalIndex)
        ? `[Tool output text omitted from active context; recall #${globalIndex}.]`
        : "[Tool output text omitted from active context; use recall.]",
    });
  }
  projection.omissions.reverse();
  return projection;
};

const directMessageId = (message: UnknownRecord): string | undefined => {
  if (typeof message.entryId === "string") return message.entryId;
  if (typeof message._entryId === "string") return message._entryId;
  return undefined;
};

const replaceText = (message: UnknownRecord, marker: string): UnknownRecord => {
  if (message.role === "bashExecution") {
    if (typeof message.output !== "string") return message;
    return { ...message, output: marker };
  }
  if (typeof message.content === "string") return { ...message, content: marker };
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((part: unknown) => {
    if (part !== null && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
      changed = true;
      return { ...part, text: marker };
    }
    return part;
  });
  return changed ? { ...message, content } : message;
};

const findProjectionTarget = (
  omission: { entryId: string },
  messages: UnknownRecord[],
  metadata: RetainedProjectionOptions,
): number => {
  const direct: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const id = metadata.entryIds?.[i] ?? directMessageId(messages[i]);
    if (id === omission.entryId) direct.push(i);
  }
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return -1;

  const toolCallId = metadata.omissionToolCallIds?.[omission.entryId];
  if (typeof toolCallId === "string" && toolCallId.length > 0) {
    const byCall: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.toolCallId === toolCallId) byCall.push(i);
    }
    if (byCall.length === 1) return byCall[0];
    if (byCall.length > 1) return -1;
  }

  const serialized = metadata.serializedByEntryId?.[omission.entryId];
  if (typeof serialized !== "string") return -1;
  const bySerialized: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    let current: string | undefined;
    try { current = JSON.stringify(messages[i]); } catch { current = undefined; }
    if (current === serialized) bySerialized.push(i);
  }
  return bySerialized.length === 1 ? bySerialized[0] : -1;
};

/** Replay a persisted projection without mutating any host/session object. */
export const applyRetainedToolOutputProjection = (
  messages: UnknownRecord[],
  projection: RetainedToolOutputProjection,
  options: RetainedProjectionOptions = {},
): UnknownRecord[] => {
  if (!Array.isArray(messages) || !projection || projection.version !== 1 || !Array.isArray(projection.omissions)) return messages;
  const next = messages.slice();
  for (const omission of projection.omissions) {
    if (typeof omission?.entryId !== "string" || typeof omission?.marker !== "string") return messages;
    const target = findProjectionTarget(omission, messages, options);
    if (target < 0 || !isOutputMessage(messages[target])) return messages;
    next[target] = replaceText(messages[target], omission.marker);
  }
  return next;
};

export interface ApplyToolOutputBudgetResult {
  messages: UnknownRecord[];
  projection: RetainedToolOutputProjection;
}

/** Convenience build+replay for a context payload aligned with persisted entries. */
export const applyToolOutputBudget = (
  messages: UnknownRecord[],
  entries: ToolOutputEntry[],
  retainedToolOutputMaxTokens: number,
  globalIndexById?: ReadonlyMap<string, number>,
  options: RetainedProjectionOptions = {},
): ApplyToolOutputBudgetResult => {
  const projection = buildRetainedToolOutputProjection(entries, retainedToolOutputMaxTokens, globalIndexById);
  return { messages: applyRetainedToolOutputProjection(messages, projection, options), projection };
};
