// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { renderMessage } from "../extensions/vcc-core/core/render-entries";
import type { Message } from "@oh-my-pi/pi-ai";
import { userMsg, assistantText, assistantWithToolCall, toolResult } from "./fixtures";

describe("renderMessage", () => {
  it("renders user message", () => {
    const r = renderMessage(userMsg("hello"), 0);
    expect(r).toEqual({ index: 0, role: "user", summary: "hello" });
  });

  it("renders assistant text", () => {
    const r = renderMessage(assistantText("done"), 1);
    expect(r.role).toBe("assistant");
    expect(r.summary).toBe("done");
  });

  it("renders tool result", () => {
    const r = renderMessage(toolResult("Read", "file contents"), 2);
    expect(r.role).toBe("tool_result");
    expect(r.summary).toContain("[Read]");
  });

  it("renders tool call arguments with values", () => {
    const r = renderMessage(assistantWithToolCall("Read", { path: "a.ts" }), 2);
    expect(r.summary).toContain("Read(path=a.ts)");
  });

  it("renders tool results without error prefix", () => {
    const r = renderMessage(toolResult("bash", "not found"), 3);
    expect(r.summary).toBe("[bash] not found");
  });

  it("truncates long user text", () => {
    const long = "x".repeat(500);
    const r = renderMessage(userMsg(long), 0);
    expect(r.summary.length).toBeLessThanOrEqual(300);
  });

  it("renders bashExecution message", () => {
    const msg = { role: "bashExecution", command: "ls -la", output: "total 0\n" } as any;
    const r = renderMessage(msg, 5);
    expect(r.role).toBe("bash");
    expect(r.summary).toContain("$ ls -la");
    expect(r.summary).toContain("total 0");
  });

  it("renders bashExecution with missing output", () => {
    const msg = { role: "bashExecution", command: "exit 1" } as any;
    const r = renderMessage(msg, 6);
    expect(r.role).toBe("bash");
    expect(r.summary).toContain("$ exit 1");
  });

  it("handles message with undefined content", () => {
    const msg = { role: "assistant", content: undefined } as any;
    const r = renderMessage(msg, 3);
    expect(r.role).toBe("assistant");
    expect(r.summary).toBe("");
  });
});

// A single malformed element used to throw out of renderMessage, which
// loadAllMessages swallows into an EMPTY session — every vcc_recall query and
// every #N ref for the whole session then reports "not found".
//
// `as unknown as Message` is deliberate: these fixtures exist precisely to
// carry shapes the host Message union forbids (null parts, string arguments).
const malformedAssistant = (content: unknown): Message =>
  ({ role: "assistant", content }) as unknown as Message;

describe("renderMessage: malformed content parts", () => {
  it("skips a null part instead of throwing", () => {
    const r = renderMessage(malformedAssistant([null, { type: "text", text: "fixed the parser" }]), 3);
    expect(r.role).toBe("assistant");
    expect(r.summary).toContain("fixed the parser");
  });

  it("skips a non-object part", () => {
    const r = renderMessage(malformedAssistant(["stray string", { type: "text", text: "kept" }]), 3);
    expect(r.summary).toContain("kept");
  });

  it("renders a toolCall with no arguments object", () => {
    const r = renderMessage(malformedAssistant([{ type: "toolCall", name: "Read" }]), 4);
    expect(r.summary).toContain("Read()");
    expect(r.files).toBeUndefined();
  });

  it("renders a toolCall whose arguments are not an object", () => {
    const msg = malformedAssistant([{ type: "toolCall", name: "Read", arguments: "oops" }]);
    expect(() => renderMessage(msg, 5)).not.toThrow();
    expect(renderMessage(msg, 5).summary).toContain("Read()");
  });

  it("still extracts files from a well-formed toolCall alongside a malformed one", () => {
    const msg = malformedAssistant([
      null,
      { type: "toolCall", name: "Read", arguments: { path: "src/a.ts" } },
      { type: "toolCall", name: "Write" },
    ]);
    expect(renderMessage(msg, 6).files).toEqual(["src/a.ts"]);
  });

  // Guarding only null/non-object ELEMENTS left the non-array leg: a truthy
  // non-array content ({}, 42, true) still reached `.filter` and threw, which
  // loadAllMessages swallowed into an empty session.
  it("degrades on a truthy non-array content instead of throwing", () => {
    for (const bad of [{}, 42, true, { type: "text" }, { 0: "x" }]) {
      expect(() => renderMessage(malformedAssistant(bad), 7)).not.toThrow();
      expect(renderMessage(malformedAssistant(bad), 7).summary).toBe("");
    }
  });

  it("treats an empty array as no content", () => {
    expect(renderMessage(malformedAssistant([]), 8).summary).toBe("");
  });
});

