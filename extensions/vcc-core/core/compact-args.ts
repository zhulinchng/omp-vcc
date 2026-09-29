// @ts-nocheck
export const PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__";

const KEEP_TOKEN_ANY_RE = /\bkeep:(\d+)\b/gi;

export interface ParsedCompactionArgs {
  followUpPrompt: string;
  keepUserTurns: number | null;
  keepUserTurnsExplicit: boolean;
}

const parseKeepUserTurns = (raw: string): number => {
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
};

export const parseKeepAndPrompt = (args?: string): ParsedCompactionArgs => {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) return { followUpPrompt: "", keepUserTurns: null, keepUserTurnsExplicit: false };

  // Every `keep:N` token (case-insensitive, anywhere in the args) is consumed:
  // the LAST one wins. A repeated token must never survive into the follow-up
  // prompt — that text is sent to the model as a user message.
  const tokens = [...trimmed.matchAll(KEEP_TOKEN_ANY_RE)];
  if (tokens.length === 0) {
    return { followUpPrompt: trimmed, keepUserTurns: null, keepUserTurnsExplicit: false };
  }
  const last = tokens[tokens.length - 1];
  return {
    followUpPrompt: trimmed.replace(KEEP_TOKEN_ANY_RE, " ").replace(/\s+/g, " ").trim(),
    keepUserTurns: parseKeepUserTurns(last[1]),
    keepUserTurnsExplicit: true,
  };
};

export const buildPiVccCustomInstructions = (keepUserTurns: number | null): string => {
  if (keepUserTurns == null) return PI_VCC_COMPACT_INSTRUCTION;
  return `${PI_VCC_COMPACT_INSTRUCTION} keep:${keepUserTurns}`;
};
