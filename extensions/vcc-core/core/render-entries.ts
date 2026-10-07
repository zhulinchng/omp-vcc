// @ts-nocheck
import type { Message } from "@oh-my-pi/pi-ai";
import { clip, textOf, thinkingOf, toolCallArgsText } from "./content";
import { summarizeToolArgs } from "./tool-args";
import { extractPath } from "./tool-args";

export interface RenderedEntry {
  index: number;
  role: string;
  summary: string;
  files?: string[];
}

const toolCalls = (content: Message["content"]): string => {
  // Same three-legged guard as content.ts's textParts: falsy, string, or a
  // truthy NON-array (`{}`, `42`) each take their own path. Only rejecting
  // null/non-object ELEMENTS left the non-array leg throwing
  // `content.filter is not a function`, which loadAllMessages swallows into an
  // empty session — the exact failure this guard exists to prevent.
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c !== null && typeof c === "object" && c.type === "toolCall")
    .map((c) => `${c.name}(${summarizeToolArgs(c.arguments ?? {})})`)
    .join(", ");
};

const extractFilesFromContent = (content: Message["content"]): string[] => {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c !== null && typeof c === "object" && c.type === "toolCall")
    .map((c) => extractPath(c.arguments ?? {}))
    .filter((p): p is string => p !== null);
};

export const renderMessage = (msg: Message, index: number, full = false): RenderedEntry => {
  if (msg.role === "user") {
    return { index, role: "user", summary: full ? textOf(msg.content) : clip(textOf(msg.content), 300) };
  }
  if (msg.role === "toolResult") {
    const text = full ? textOf(msg.content) : clip(textOf(msg.content), 200);
    return {
      index, role: "tool_result",
      summary: `[${msg.toolName}] ${text}`,
    };
  }
  // bashExecution has command+output instead of content
  if ((msg as any).role === "bashExecution") {
    const cmd = (msg as any).command ?? "";
    const out = (msg as any).output ?? "";
    const text = full ? `$ ${cmd}\n${out}` : clip(`$ ${cmd}\n${out}`, 300);
    return { index, role: "bash", summary: text };
  }
  // pythonExecution carries code+output instead of content, and fileMention
  // carries files[]: both used to fall through to the assistant branch and
  // render as an EMPTY `[assistant]` row (their text was never indexed either).
  if ((msg as any).role === "pythonExecution") {
    const code = (msg as any).code ?? "";
    const out = (msg as any).output ?? "";
    const text = full ? `>>> ${code}\n${out}` : clip(`>>> ${code}\n${out}`, 300);
    return { index, role: "python", summary: text };
  }
  if ((msg as any).role === "fileMention") {
    const mentionFiles = Array.isArray((msg as any).files) ? (msg as any).files : [];
    const text = mentionFiles.map((f: any) => `${f?.path ?? ""}\n${f?.content ?? ""}`).join("\n");
    return { index, role: "file_mention", summary: full ? text : clip(text, 300) };
  }
  const thinking = thinkingOf(msg.content);
  const text = full ? textOf(msg.content) : clip(textOf(msg.content), 300);
  const tools = toolCalls(msg.content);
  const files = extractFilesFromContent(msg.content);
  if (!text && !tools && thinking) {
    return { index, role: "thinking", summary: full ? thinking : clip(thinking, 300) };
  }
  // Search indexes text + thinking + toolCall arguments (search-entries.ts
  // fullText), so the FULL view must carry the same fields. Without them a hit
  // whose only match lives in a Write/Edit argument gets a `#N`/`#N:full` ref
  // that cannot reproduce the matched text. The non-full body is unchanged
  // (pinned by tests/thinking.test.ts mixed thinking+text).
  const base = tools ? `${tools}\n${text}` : text;
  const argsText = full ? toolCallArgsText(msg.content) : "";
  const summary = [
    full && thinking ? `[thinking]\n${thinking}` : "",
    base,
    argsText ? `[tool args]\n${argsText}` : "",
  ].filter(Boolean).join("\n\n");
  // Label with the REAL role: developer/hookMessage blocks used to masquerade
  // as `[assistant]`.
  const role = typeof (msg as any).role === "string" && (msg as any).role ? (msg as any).role : "assistant";
  return { index, role, summary, ...(files.length > 0 && { files }) };
};


