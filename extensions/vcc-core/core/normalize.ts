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
    if (msg.content && typeof msg.content !== "string") {
      for (const part of msg.content) {
        if (part.type === "image") {
          blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex }];
  }

  if (msg.role === "bashExecution") {
    const cmd = (msg as any).command ?? "";
    const out = (msg as any).output ?? "";
    const exit = (msg as any).exitCode;
    return [{ kind: "bash", command: cmd, output: out, exitCode: exit, sourceIndex }];
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

    const blocks: NormalizedBlock[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({ kind: "assistant", text: sanitize(part.text), sourceIndex });
      } else if (part.type === "thinking") {
        const thinkingText = sanitize(part.text ?? part.thinking ?? "");
        if (thinkingText) blocks.push({ kind: "thinking", text: thinkingText, sourceIndex });
      } else if (part.type === "toolCall") {
        blocks.push({
          kind: "tool_call",
          name: part.name,
          args: part.arguments,
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


