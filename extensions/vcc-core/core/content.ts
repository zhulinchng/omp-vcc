// @ts-nocheck
import type { Message } from "@oh-my-pi/pi-ai";
import { PATH_KEYS } from "./tool-args";

export const clip = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  // Try to cut at a word boundary
  const cut = text.lastIndexOf(" ", max);
  let end = cut > max * 0.6 ? cut : max;
  // Avoid splitting a surrogate pair
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return text.slice(0, end);
};

/**
 * Clip text to last sentence boundary at or before `max` chars.
 * Falls back to word boundary (clip()) if no sentence end is found in the
 * acceptable range. Trailing whitespace stripped.
 */
export const clipSentence = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  // Look for sentence terminators followed by space/newline within [max*0.5, max]
  const window = text.slice(0, max);
  const matches = [...window.matchAll(/[.!?](?:\s|$)/g)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const end = (last.index ?? 0) + 1; // include the punctuation
    if (end >= max * 0.5) return text.slice(0, end);
  }
  return clip(text, max);
};

export const nonEmptyLines = (text: string): string[] =>
  text.split("\n").map((line) => line.trim()).filter(Boolean);

export const firstLine = (text: string, max = 200): string =>
  clip(text.split("\n")[0] ?? "", max);

export const textParts = (content: Message["content"]): string[] => {
  if (!content) return [];
  if (typeof content === "string") return [content];
  // A malformed content array (null elements, or a non-array object) must
  // degrade rather than throw: this runs inside the session_before_compact
  // handler, where a throw makes the host discard the entire return value.
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""));
};

export const textOf = (content: Message["content"]): string =>
  textParts(content).join("\n");

export const thinkingParts = (content: Message["content"]): string[] => {
  if (!content || typeof content === "string") return [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && typeof part === "object" && part.type === "thinking")
    .map((part) => (part.thinking ?? part.text ?? "") as string)
    .filter((t) => typeof t === "string" && t.length > 0);
};

export const thinkingOf = (content: Message["content"]): string =>
  thinkingParts(content).join("\n");

/**
 * Check if tool call arguments contain content-bearing data.
 *
 * A call is content-bearing if it has a path argument AND at least one
 * large string/array field (content, edits, oldText, newText).
 * This is a generic heuristic — not dependent on tool names.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const isContentBearing = (args: Record<string, unknown>): boolean => {
  if (!args || typeof args !== "object") return false;
  // Must have a path in one of the known keys
  const hasPath = PATH_KEYS.some((k) => typeof args[k] === "string");
  if (!hasPath) return false;
  // Must have at least one content-bearing field
  if (typeof args.content === "string" && args.content.length > 0) return true;
  // edits must be a non-empty array of objects (each with oldText/newText)
  if (
    Array.isArray(args.edits) &&
    args.edits.length > 0 &&
    args.edits.every((e) => typeof e === "object" && e !== null)
  )
    return true;
  // oldText/newText without edits are content-bearing
  if (
    typeof args.oldText === "string" &&
    args.oldText.length > 0 &&
    args.edits === undefined
  )
    return true;
  if (
    typeof args.newText === "string" &&
    args.newText.length > 0 &&
    args.edits === undefined
  )
    return true;
  return false;
};

/**
 * Extract textual content from tool call arguments (content, edits,
 * oldText, newText). Used for counting touched-file lines and search.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const extractToolCallText = (args: Record<string, unknown>): string => {
  let text = "";
  if (typeof args.content === "string") text += args.content + "\n";
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object") {
        if (typeof edit.oldText === "string") text += edit.oldText + "\n";
        if (typeof edit.newText === "string") text += edit.newText + "\n";
      }
    }
  }
  if (typeof args.oldText === "string" && !Array.isArray(args.edits))
    text += args.oldText + "\n";
  if (typeof args.newText === "string" && !Array.isArray(args.edits))
    text += args.newText + "\n";
  return text;
};

/**
 * Extract every scalar string argument from a tool call for search indexing
 * — command, query, content, oldText/newText, etc. Generic value walk (no
 * tool-name allowlist): top-level strings plus strings one level into
 * array-of-object fields (e.g. `edits`). Unbounded by design — a single
 * toolCall's raw argument text — so a message with several toolCalls doesn't
 * silently multiply an internal cap. The caller (search-entries.ts) applies
 * one shared budget across all toolCalls in a message.
 */
export const extractToolCallArgsText = (args: Record<string, unknown>): string => {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === "string") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          parts.push(item);
        } else if (item && typeof item === "object") {
          for (const v of Object.values(item)) {
            if (typeof v === "string") parts.push(v);
          }
        }
      }
    }
  }
  return parts.join("\n");
};

const stringField = (record: Record<string, unknown> | undefined, key: string): string => {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
};

/**
 * Text-bearing fields of the message shapes that carry NO `content` part array:
 * `bashExecution` keeps its text in `command`/`output`, `pythonExecution` in
 * `code`/`output`, the summary roles in `summary`, `fileMention` in
 * `files[].content`. Returns `undefined` for every other shape, so callers can
 * tell "this shape has its own text" from "this message realises 0 chars".
 */
export const messageShapeText = (message: unknown): string | undefined => {
  const m = message as Record<string, unknown> | null | undefined;
  switch (stringField(m ?? undefined, "role")) {
    case "bashExecution":
      return `${stringField(m ?? undefined, "command")}\n${stringField(m ?? undefined, "output")}`;
    case "pythonExecution":
      return `${stringField(m ?? undefined, "code")}\n${stringField(m ?? undefined, "output")}`;
    case "branchSummary":
    case "compactionSummary":
      return stringField(m ?? undefined, "summary");
    case "fileMention": {
      const files = m?.files;
      if (!Array.isArray(files)) return "";
      return files
        .map((file: unknown) => {
          const f = file as Record<string, unknown> | null | undefined;
          return `${stringField(f ?? undefined, "path")}\n${stringField(f ?? undefined, "content")}`;
        })
        .join("\n");
    }
    default:
      return undefined;
  }
};

/**
 * Text of a whole message for sampling (density classification, calibration
 * slices): shape-aware for the `content`-less roles and `textOf(content)`
 * otherwise. Reading only `typeof content === "string"` made every array-content
 * message sample as "" — a newline-only string that `isDenseContent` classifies
 * as dense, so the prose-vs-dense prior was a constant.
 */
export const messageText = (message: unknown): string => {
  const shape = messageShapeText(message);
  if (shape !== undefined) return shape;
  const content = (message as Record<string, unknown> | null | undefined)?.content;
  return typeof content === "string" ? content : textOf(content as Message["content"]);
};

/** Aggregate character budget for ALL toolCall arguments appended to one message. */
export const TOOL_ARGS_BUDGET = 2000;

/**
 * Aggregate, bounded text of every toolCall's arguments in a message's content.
 * The bounded-once-in-aggregate rule and the null/non-object element guard are
 * load-bearing (persisted sessions carry both shapes); `excludeToolNames` are
 * compared case-insensitively, so a tool can be kept out of its own search
 * results (see RECALL_TOOL_NAME in search-entries.ts).
 */
export const toolCallArgsText = (
  content: Message["content"],
  excludeToolNames: readonly string[] = [],
): string => {
  if (!Array.isArray(content)) return "";
  const excluded = new Set(excludeToolNames.map((name) => name.toLowerCase()));
  const raw = content
    // A content array may hold a null/non-object element (persisted sessions do
    // carry them), and `part.type` on it throws. Same guard as the other
    // text-bearing branches in content.ts / render-entries.ts.
    .filter((part) => part !== null && typeof part === "object" && part.type === "toolCall")
    // Coerced, like every other tool-name read in this file: `name` is not
    // guaranteed to be a string in a persisted line, and `42?.toLowerCase()`
    // throws.
    .filter((part) => !excluded.has(String(part.name ?? "").toLowerCase()))
    .map((part) => extractToolCallArgsText(part.arguments))
    .filter(Boolean)
    .join("\n");
  return clip(raw, TOOL_ARGS_BUDGET);
};

/** Extract a snippet of ~`radius` chars around the first match of `term` in `text`. */
export const snippet = (text: string, term: string, radius = 60): string | null => {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
};
