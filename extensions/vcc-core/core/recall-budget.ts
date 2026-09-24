// @ts-nocheck
/**
 * Pure helpers for bounding model-facing recall responses. Human-facing
 * commands deliberately do not call this module; their existing per-entry
 * clips remain the boundary for those surfaces.
 */

export const DEFAULT_RECALL_RESPONSE_MAX_CHARS = 48_000;
export const EXPAND_FLOOR_CHARS = 2_000;
export const EXPAND_ENTRY_OVERHEAD = 200;

export interface RecallBudgetBlock {
  /** Stable entry/page number used in the continuation marker. */
  id?: string | number;
  text: string;
  /** Optional human label, e.g. "entry #4" or "page 2". */
  label?: string;
}

export interface CapRecallBlocksOptions {
  header?: string;
  /** Used instead of `entry` in the omitted-content marker. */
  blockKind?: string;
}

/**
 * Allocate a total expansion budget fairly across requested expansions.
 * The floor is honoured whenever the requested total can afford it; smaller
 * budgets degrade proportionally, and the result never allocates more than
 * the supplied budget. The per-entry overhead is reserved for separators and
 * continuation bookkeeping.
 */
export const expandAllocation = (
  totalChars: number,
  count: number,
  overhead = EXPAND_ENTRY_OVERHEAD,
): number[] => {
  if (!Number.isFinite(totalChars) || totalChars <= 0 || count <= 0) return [];
  const safeCount = Math.max(1, Math.floor(count));
  const safeOverhead = Number.isFinite(overhead) && overhead > 0 ? overhead : 0;
  const available = Math.max(0, totalChars - safeOverhead * safeCount);
  const share = Math.floor(available / safeCount);
  const floorFits = share >= EXPAND_FLOOR_CHARS;
  if (floorFits) {
    const result = new Array<number>(safeCount).fill(EXPAND_FLOOR_CHARS);
    let remainder = available - EXPAND_FLOOR_CHARS * safeCount;
    for (let i = 0; i < safeCount && remainder > 0; i++) {
      const extra = Math.min(remainder, share - EXPAND_FLOOR_CHARS);
      result[i] += extra;
      remainder -= extra;
    }
    return result;
  }
  return new Array<number>(safeCount).fill(share);
};

const blockLabel = (block: RecallBudgetBlock, index: number, kind: string): string => {
  if (block.label) return block.label;
  if (block.id !== undefined) return `${kind} ${block.id}`;
  return `${kind} ${index + 1}`;
};

const asBlocks = (blocks: string[] | RecallBudgetBlock[]): RecallBudgetBlock[] =>
  blocks.map((block) => (typeof block === "string" ? { text: block } : block));

/**
 * Cap a sequence of response blocks while retaining a bounded excerpt of
 * every requested block. A zero budget is intentionally unbounded. The
 * continuation marker is intentionally outside the nominal budget so callers
 * can always explain why content was omitted.
 */
export const capRecallBlocks = (
  blocks: Array<string | RecallBudgetBlock>,
  maxChars = DEFAULT_RECALL_RESPONSE_MAX_CHARS,
  options: CapRecallBlocksOptions = {},
): string => {
  const normalized = asBlocks(blocks);
  if (maxChars === 0) {
    return [options.header, ...normalized.map((b) => b.text)].filter(Boolean).join("\n\n");
  }
  if (normalized.length === 0) return options.header ?? "";

  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : DEFAULT_RECALL_RESPONSE_MAX_CHARS;
  const header = options.header ?? "";
  const bodyBudget = Math.max(0, limit - header.length);
  const allocations = expandAllocation(bodyBudget, normalized.length);
  const kind = options.blockKind ?? "entry";
  const output: string[] = [];
  const omitted: string[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const block = normalized[i];
    const allocation = allocations[i] ?? 0;
    const text = block.text ?? "";
    if (text.length <= allocation) {
      output.push(text);
    } else {
      const excerpt = allocation > 0 ? text.slice(0, allocation) : "";
      output.push(excerpt);
      omitted.push(blockLabel(block, i, kind));
    }
  }
  let result = [header, ...output].filter(Boolean).join("\n\n");
  if (omitted.length > 0) {
    result += `\n\n--- recall response capped at ${limit} characters; omitted ${kind}${omitted.length === 1 ? "" : "s"}: ${omitted.join(", ")} ---`;
  }
  return result;
};
