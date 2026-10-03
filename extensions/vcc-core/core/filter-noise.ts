// @ts-nocheck
import type { NormalizedBlock } from "../types";

const NOISE_TOOLS = new Set([
  "TodoWrite", "TodoRead", "ToolSearch", "WebSearch",
  "AskUser", "ExitSpecMode", "GenerateDroid",
]);

const NOISE_STRINGS = [
  "Continue from where you left off.",
  "No response requested.",
  "IMPORTANT: TodoWrite was not called yet.",
];

// The harness injects these wrappers into user turns both as a prelude and as a
// trailing reminder (tests pin both shapes), so they are stripped wherever they
// appear. That does mean a user who types a literal `<system-reminder>` block
// loses that span; the two shapes are indistinguishable from the message text
// alone, and stripping is required for the harness case.
const XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;

const cleanUserText = (text: string): string =>
  text.replace(XML_WRAPPER_RE, "").trim();

const isNoiseUserBlock = (text: string): boolean => {
  const trimmed = text.trim();
  // Exact match only. These are standalone harness messages; a user who merely
  // QUOTES one of these phrases must keep their message (the previous unbounded
  // `includes` test dropped the entire user turn).
  if (NOISE_STRINGS.some((s) => trimmed === s)) return true;
  const stripped = cleanUserText(trimmed);
  if (NOISE_STRINGS.some((s) => stripped === s)) return true;
  return stripped.length === 0;
};

export const filterNoise = (blocks: NormalizedBlock[]): NormalizedBlock[] => {
  const out: NormalizedBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "tool_call" && NOISE_TOOLS.has(b.name)) continue;
    if (b.kind === "tool_result" && NOISE_TOOLS.has(b.name)) continue;
    if (b.kind === "user") {
      if (isNoiseUserBlock(b.text)) continue;
      const cleaned = cleanUserText(b.text);
      if (!cleaned) continue;
      // sourceIndex must survive: brief.ts renders ` (#N)` for user blocks, so
      // dropping it here silently strips the vcc_recall drill-down pointer from
      // every [user] line of every compaction summary.
      out.push({ kind: "user", text: cleaned, sourceIndex: b.sourceIndex });
      continue;
    }
    out.push(b);
  }
  return out;
};
