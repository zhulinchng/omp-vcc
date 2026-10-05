// @ts-nocheck
import type { Message } from "@oh-my-pi/pi-ai";
import type { NormalizedBlock } from "../types";
import { textOf } from "./content";
import { sanitize } from "./sanitize";

const normalizeOne = (msg: Message, msgIndex: number, sourceIndex: number | undefined): NormalizedBlock[] => {
  if (msg.role === "user") {
    const blocks: NormalizedBlock[] = [];
    const text = sanitize(textOf(msg.content));
    if (text) blocks.push({ kind: "user", text, sourceIndex });
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === "object" && part.type === "image") {
          blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex }];
  }

  if (msg.role === "bashExecution") {
    // The command and its output are the ONLY un-sanitized text-bearing branch
    // of normalize: a carriage return or a live escape sequence here reached
    // the brief line and the persisted summary verbatim.
    const rawCmd = msg.command;
    const rawOut = msg.output;
    const rawExit = msg.exitCode;
    return [{
      kind: "bash",
      command: typeof rawCmd === "string" ? sanitize(rawCmd) : "",
      output: typeof rawOut === "string" ? sanitize(rawOut) : "",
      exitCode: typeof rawExit === "number" ? rawExit : undefined,
      sourceIndex,
    }];
  }

  if (msg.role === "toolResult") {
    return [{
      kind: "tool_result",
      name: msg.toolName,
      text: sanitize(textOf(msg.content)),
      sourceIndex,
    }];
  }

  if (msg.role === "assistant") {
    if (!msg.content) return [];
    if (typeof msg.content === "string") {
      return [{ kind: "assistant", text: sanitize(msg.content), sourceIndex }];
    }

    if (!Array.isArray(msg.content)) return [];
    const blocks: NormalizedBlock[] = [];
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text") {
        // `part.text` is not guaranteed to be a string in a persisted line;
        // sanitize() calls .replace on it, so a non-string would throw out of
        // the compaction handler. Same coercion as content.ts's textParts.
        blocks.push({ kind: "assistant", text: sanitize(typeof part.text === "string" ? part.text : ""), sourceIndex });
      } else if (part.type === "thinking") {
        const rawThinking = part.text ?? part.thinking ?? "";
        const thinkingText = sanitize(typeof rawThinking === "string" ? rawThinking : "");
        if (thinkingText) blocks.push({ kind: "thinking", text: thinkingText, sourceIndex });
      } else if (part.type === "toolCall") {
        // Downstream extractors read `b.args.<key>` directly; a toolCall part
        // with no arguments object must not become an undefined `args`.
        const rawArgs = part.arguments && typeof part.arguments === "object" ? part.arguments : {};
        // Argument strings are persisted into the summary ([Commits] reads
        // `command`, the file extractors read `path`/`content`), so they need
        // the same sanitize pass as every other text-bearing branch. Matched
        // escapes are removed per value; non-string values pass through by
        // reference so array/object shapes downstream extractors parse survive.
        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rawArgs)) {
          args[key] = typeof value === "string" ? sanitize(value) : value;
        }
        blocks.push({
          kind: "tool_call",
          name: part.name,
          args,
          sourceIndex,
        });
      }
    }
    return blocks;
  }

  // Injected context (custom_message entries: memory, skill context). Kept as
  // its own kind so the brief can attribute it without mislabeling it as a
  // user or assistant turn. branchSummary entries carry no content here.
  if (msg.role === "custom") {
    const text = sanitize(textOf(msg.content));
    if (text) return [{ kind: "custom", text, sourceIndex }];
    return [];
  }

  return [];
};

export const normalize = (messages: Message[], sourceIndices?: Array<number | undefined>): NormalizedBlock[] =>
  messages.flatMap((msg, i) => normalizeOne(msg, i, sourceIndices ? sourceIndices[i] : i));


