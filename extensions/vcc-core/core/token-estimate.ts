// @ts-nocheck
export const DEFAULT_CHARS_PER_TOKEN = 4;
export const MIN_CHARS_PER_TOKEN = 2;
export const MAX_CHARS_PER_TOKEN = 6;

export type TokenEstimateMode = "heuristic" | "calibrated";

export interface TokenEstimateCalibration {
  mode: TokenEstimateMode;
  charsPerToken: number;
  sourceChars?: number;
  sourceTokens?: number;
  rawCharsPerToken?: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const calibrateCharsPerToken = (
  sourceChars: number,
  sourceTokens: number | undefined,
): TokenEstimateCalibration => {
  if (!sourceTokens || sourceTokens <= 0 || sourceChars <= 0) {
    return { mode: "heuristic", charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  }

  const rawCharsPerToken = sourceChars / sourceTokens;
  if (!Number.isFinite(rawCharsPerToken) || rawCharsPerToken <= 0) {
    return { mode: "heuristic", charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  }

  return {
    mode: "calibrated",
    charsPerToken: clamp(rawCharsPerToken, MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN),
    sourceChars,
    sourceTokens,
    rawCharsPerToken,
  };
};

export const estimateTokensFromChars = (
  chars: number,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number => Math.ceil(chars / charsPerToken);

/**
 * Chars attributed to one image part, mirroring pi-agent-core's own
 * estimateTokens heuristic (4800 chars ≈ 1200 tokens at 4 chars/token).
 */
export const IMAGE_CONTENT_CHARS = 4800;

const safeJsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? "") ?? "";
  } catch {
    return "";
  }
};

/**
 * Estimate the char length of a message's content (string or content-parts
 * array). Counts every token-bearing part that pi-agent-core's harness
 * estimateTokens counts, so the calibrated chars/token ratio is not deflated:
 *  - text       → text.length
 *  - thinking   → thinking.length   (opus emits large reasoning blocks)
 *  - toolCall   → name + arguments  (Pi uses `arguments`; `input` kept for compat)
 *  - image      → IMAGE_CONTENT_CHARS
 *  - toolResult → nested content    (legacy part shape)
 */
export const estimateMessageContentChars = (content: unknown): number => {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum: number, part: any) => {
    if (!part || typeof part !== "object") return sum;
    switch (part.type) {
      case "text":
        return sum + (typeof part.text === "string" ? part.text.length : 0);
      case "thinking":
        return sum + (typeof part.thinking === "string" ? part.thinking.length : 0);
      case "toolCall": {
        const args = part.arguments ?? part.input;
        const argLength = typeof args === "string" ? args.length : safeJsonStringify(args).length;
        return sum + (part.name?.length ?? 0) + argLength;
      }
      case "toolResult": {
        const c = part.content;
        return sum + (typeof c === "string" ? c.length : safeJsonStringify(c).length);
      }
      case "image":
        return sum + IMAGE_CONTENT_CHARS;
      default:
        // Unknown part: fall back to any text field so we never undercount.
        return sum + (typeof part.text === "string" ? part.text.length : 0);
    }
  }, 0);
};

export const estimateMessageContentTokens = (
  content: unknown,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number => estimateTokensFromChars(estimateMessageContentChars(content), charsPerToken);

export interface UsageStats {
  messageCount: number;
  byRole: Record<string, number>;
  toolCallCount: number;
  models: string[];
  /** Wall-clock span (ms) from message timestamps, null when unavailable. */
  spanMs: number | null;
  inputChars: number;
  outputChars: number;
  inputTokensEst: number;
  outputTokensEst: number;
  /** Summed provider usage counters when messages carry them. */
  usageTotals: { input: number; output: number; cacheRead: number; cacheWrite: number };
  calibration: TokenEstimateCalibration;
}

/**
 * Reference `_collect_stats` equivalent for the debug snapshot: per-compaction
 * usage/timing/model block. Assistant content counts as output; user text,
 * tool results, and bash executions count as input. Calibrates chars/token
 * against summed provider usage when present, heuristic fallback otherwise.
 */
export const collectUsageStats = (messages: any[]): UsageStats => {
  const byRole: Record<string, number> = {};
  const models = new Set<string>();
  let toolCallCount = 0;
  let inputChars = 0;
  let outputChars = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawUsage = false;
  for (const m of messages ?? []) {
    const role = typeof m?.role === "string" ? m.role : "unknown";
    byRole[role] = (byRole[role] ?? 0) + 1;
    if (typeof m?.model === "string" && m.model) models.add(m.model);
    if (typeof m?.timestamp === "number" && Number.isFinite(m.timestamp)) {
      if (m.timestamp < minTs) minTs = m.timestamp;
      if (m.timestamp > maxTs) maxTs = m.timestamp;
    }
    const u = m?.usage;
    if (u && typeof u === "object") {
      sawUsage = true;
      for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        if (typeof u[k] === "number" && Number.isFinite(u[k])) usageTotals[k] += u[k];
      }
    }
    if (role === "assistant") {
      outputChars += estimateMessageContentChars(m?.content);
      if (Array.isArray(m?.content)) {
        for (const part of m.content) if (part?.type === "toolCall") toolCallCount++;
      }
    } else if (role === "bashExecution") {
      inputChars += (typeof m?.command === "string" ? m.command.length : 0) + 1
        + (typeof m?.output === "string" ? m.output.length : 0);
    } else {
      inputChars += estimateMessageContentChars(m?.content);
    }
  }
  const totalChars = inputChars + outputChars;
  const sourceTokens = sawUsage ? usageTotals.input + usageTotals.output : undefined;
  const calibration = calibrateCharsPerToken(totalChars, sourceTokens);
  return {
    messageCount: messages?.length ?? 0,
    byRole,
    toolCallCount,
    models: [...models],
    spanMs: minTs <= maxTs ? maxTs - minTs : null,
    inputChars,
    outputChars,
    inputTokensEst: estimateTokensFromChars(inputChars, calibration.charsPerToken),
    outputTokensEst: estimateTokensFromChars(outputChars, calibration.charsPerToken),
    usageTotals,
    calibration,
  };
};
