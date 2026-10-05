// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { normalize } from "../extensions/vcc-core/core/normalize";
import {
  userMsg,
  assistantText,
  assistantWithThinking,
  assistantWithToolCall,
  toolResult,
} from "./fixtures";

describe("normalize", () => {
  it("returns empty for empty input", () => {
    expect(normalize([])).toEqual([]);
  });

  it("normalizes user message (string content)", () => {
    const blocks = normalize([userMsg("fix the bug")]);
    expect(blocks).toEqual([{ kind: "user", text: "fix the bug", sourceIndex: 0 }]);
  });

  it("normalizes assistant text message", () => {
    const blocks = normalize([assistantText("done")]);
    expect(blocks).toEqual([{ kind: "assistant", text: "done", sourceIndex: 0 }]);
  });

  it("normalizes assistant string content", () => {
    const msg = { ...assistantText("done"), content: "plain text" } as any;
    expect(normalize([msg])).toEqual([{ kind: "assistant", text: "plain text", sourceIndex: 0 }]);
  });

  it("keeps assistant thinking as its own block (see thinking.test.ts)", () => {
    const blocks = normalize([assistantWithThinking("result", "hmm")]);
    expect(blocks).toEqual([
      { kind: "thinking", text: "hmm", sourceIndex: 0 },
      { kind: "assistant", text: "result", sourceIndex: 0 },
    ]);
  });

  it("normalizes tool call", () => {
    const blocks = normalize([assistantWithToolCall("Read", { path: "a.ts" })]);
    expect(blocks).toEqual([{
      kind: "tool_call", name: "Read", args: { path: "a.ts" }, sourceIndex: 0,
    }]);
  });

  it("normalizes tool result", () => {
    const blocks = normalize([toolResult("Read", "file contents")]);
    expect(blocks).toEqual([{
      kind: "tool_result", name: "Read",
      text: "file contents", sourceIndex: 0,
    }]);
  });

  it("handles mixed message sequence", () => {
    const blocks = normalize([
      userMsg("fix it"),
      assistantWithToolCall("Read", { path: "x.ts" }),
      toolResult("Read", "code"),
      assistantText("done"),
    ]);
    expect(blocks).toHaveLength(4);
    expect(blocks.map((b) => b.kind)).toEqual([
      "user", "tool_call", "tool_result", "assistant",
    ]);
  });

  it("produces image placeholder for user image content", () => {
    const msg = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "look at this" },
        { type: "image" as const, data: "abc", mimeType: "image/png" },
      ],
      timestamp: Date.now(),
    };
    const blocks = normalize([msg]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ kind: "user", text: "look at this", sourceIndex: 0 });
    expect(blocks[1]).toEqual({ kind: "user", text: "[image: image/png]", sourceIndex: 0 });
  });

  it("normalizes bashExecution messages", () => {
    const msg = { role: "bashExecution", command: "ls -la", output: "files", exitCode: 0 } as any;
    const blocks = normalize([msg]);
    expect(blocks).toEqual([
      { kind: "bash", command: "ls -la", output: "files", exitCode: 0, sourceIndex: 0 },
    ]);
  });

  it("normalizes custom role content as its own kind", () => {
    const custom = { role: "custom", content: "hello" } as any;
    expect(normalize([custom])).toEqual([{ kind: "custom", text: "hello", sourceIndex: 0 }]);
  });

  it("drops custom role content that sanitizes to empty", () => {
    const empty = { role: "custom", content: "" } as any;
    expect(normalize([empty])).toEqual([]);
  });

  it("skips truly unknown message roles gracefully", () => {
    const telex = { role: "telex", content: "hello" } as any;
    expect(normalize([telex])).toEqual([]);
  });
});

// bashExecution command/output and toolCall argument strings were the only
// un-sanitized text-bearing branches, so a carriage return or a live escape
// sequence reached the brief line and the persisted summary verbatim.
describe("normalize sanitizes every text-bearing branch", () => {
  it("sanitizes bashExecution command and output", () => {
    const out = normalize([
      { role: "bashExecution", command: "ls\r\ngrep foo", output: "\x1b[31mfailed\x1b[0m\r\n" },
    ] as never, [0]);
    expect(out).toEqual([{
      kind: "bash",
      command: "ls\ngrep foo",
      output: "failed\n",
      exitCode: undefined,
      sourceIndex: 0,
    }]);
  });

  it("drops a non-string bashExecution command and output", () => {
    const out = normalize([{ role: "bashExecution", command: 7, output: { text: "x" } }] as never, [0]);
    expect(out).toEqual([{ kind: "bash", command: "", output: "", exitCode: undefined, sourceIndex: 0 }]);
  });

  it("keeps a numeric bashExecution exitCode", () => {
    const out = normalize([{ role: "bashExecution", command: "false", output: "", exitCode: 1 }] as never, [0]);
    expect(out[0].exitCode).toBe(1);
  });

  it("sanitizes tool-call argument strings", () => {
    const out = normalize([{
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command: "echo a\r\necho b\x1b[0m" } }],
    }] as never, [0]);
    expect(out[0].args).toEqual({ command: "echo a\necho b" });
  });

  it("passes non-string argument values through by reference", () => {
    const edits = [{ oldText: "a", newText: "b" }];
    const out = normalize([{
      role: "assistant",
      content: [{ type: "toolCall", name: "edit", arguments: { path: "a\x1b[31m.ts", edits } }],
    }] as never, [0]);
    expect(out[0].args.path).toBe("a.ts");
    expect(out[0].args.edits).toBe(edits);
  });

  it("normalizes a bare CR in an argument to LF, not to nothing", () => {
    const out = normalize([{
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command: "a\rb" } }],
    }] as never, [0]);
    expect(out[0].args.command).toBe("a\nb");
  });

  // `sanitize()` calls .replace, so a non-string `text`/`thinking` part threw
  // out of the compaction handler. content.ts's textParts coerces the same
  // field; normalize must too.
  it("drops a non-string text or thinking part instead of throwing", () => {
    for (const bad of [42, true, {}, [], null]) {
      expect(() => normalize([{
        role: "assistant",
        content: [{ type: "text", text: bad }, { type: "thinking", thinking: bad }],
      }] as never, [0])).not.toThrow();
      const out = normalize([{
        role: "assistant",
        content: [{ type: "text", text: bad }, { type: "thinking", thinking: bad }],
      }] as never, [0]);
      // Empty text blocks are still emitted (pre-existing behaviour); the
      // thinking block is dropped because it sanitizes to "".
      for (const block of out) expect(typeof block.text).toBe("string");
    }
  });
});


