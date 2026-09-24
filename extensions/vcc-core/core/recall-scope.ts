// @ts-nocheck
export type RecallScope = "lineage" | "all";
export type RecallMode = "hybrid" | "touched" | "file";

const SCOPE_RE = /\bscope:(lineage|all)\b/i;

const VALID_MODES: Record<string, true> = { hybrid: true, touched: true, file: true };

export const normalizeRecallScope = (scope?: unknown): RecallScope =>
  typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";

/**
 * Normalize a mode param to a supported recall mode. `file` searches only
 * content-bearing file tool-call arguments and excludes shell output.
 */
export const normalizeRecallMode = (mode?: unknown): RecallMode =>
  typeof mode === "string" && VALID_MODES[mode.toLowerCase()]
    ? (mode.toLowerCase() as RecallMode)
    : "hybrid";

const MODE_RE = /\bmode:(hybrid|touched|file)\b/i;

/** Parse and remove a command/tool mode selector without changing query text. */
export const parseRecallMode = (text: string): { mode?: RecallMode; text: string } => {
  const match = text.match(MODE_RE);
  return {
    mode: match?.[1] ? normalizeRecallMode(match[1]) : undefined,
    text: text.replace(MODE_RE, "").replace(/\s+/g, " ").trim(),
  };
};

export const parseRecallScope = (text: string): { scope: RecallScope; text: string } => {
  const match = text.match(SCOPE_RE);
  return {
    scope: normalizeRecallScope(match?.[1]),
    text: text.replace(SCOPE_RE, "").replace(/\s+/g, " ").trim(),
  };
};
