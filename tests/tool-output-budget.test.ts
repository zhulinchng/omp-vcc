// @ts-nocheck
import { describe, expect, test } from "bun:test";
import {
  applyRetainedToolOutputProjection,
  applyToolOutputBudget,
  buildRetainedToolOutputProjection,
} from "../extensions/vcc-core/core/tool-output-budget";

const output = (id: string, text: string, toolCallId = `call-${id}`) => ({
  id,
  type: "message",
  message: { role: "toolResult", toolCallId, toolName: "Read", content: [{ type: "text", text }, { type: "image", data: "abc", mimeType: "image/png" }] },
});
const assistant = (id: string, stopReason = "stop") => ({ id, type: "message", message: { role: "assistant", stopReason, content: "done" } });
const bash = (id: string, outputText: string) => ({ id, type: "message", message: { role: "bashExecution", command: "pwd", output: outputText, exitCode: 0 } });

describe("retained tool output budget", () => {
  test("retains newest consumed output, omits older text, preserves images, and leaves pending output", () => {
    const entries = [
      output("old", "a".repeat(80)),
      output("new", "abcd"),
      assistant("a1"),
      output("pending", "still pending"),
    ];
    const projection = buildRetainedToolOutputProjection(entries, 2, new Map([["old", 4]]));
    expect(projection).toMatchObject({ version: 1, retainedTokens: 1, pendingCount: 1 });
    expect(projection.omissions).toEqual([{ entryId: "old", marker: "[Tool output text omitted from active context; recall #4.]" }]);

    const messages = entries.map((value) => structuredClone(value.message));
    const projected = applyRetainedToolOutputProjection(messages, projection, { entryIds: entries.map((value) => value.id) });
    expect(projected[0].content[0].text).toContain("recall #4");
    expect(projected[0].content[1]).toEqual({ type: "image", data: "abc", mimeType: "image/png" });
    expect(projected[1].content[0].text).toBe("abcd");
    expect(projected[3]).toEqual(messages[3]);
    expect(messages[0].content[0].text).toHaveLength(80);
  });

  test("protects ambiguous ids and uses a generic marker without a global index", () => {
    const entries = [output("duplicate", "a".repeat(80)), output("duplicate", "b".repeat(80)), output("other", "c".repeat(80)), assistant("a1")];
    const projection = buildRetainedToolOutputProjection(entries, 1);
    expect(projection.omissions.map((value) => value.entryId)).toEqual(["other"]);
    expect(projection.omissions[0].marker).toBe("[Tool output text omitted from active context; use recall.]");
  });

  test("fails the whole replay when an omission has no unique target", () => {
    const entries = [output("old", "a".repeat(80)), assistant("a1")];
    const projection = buildRetainedToolOutputProjection(entries, 1);
    const messages = entries.map((value) => structuredClone(value.message));
    const projected = applyRetainedToolOutputProjection(messages, projection, { entryIds: ["wrong"] });
    expect(projected).toEqual(messages);
  });

  test("matches a unique toolCallId after entry-id matching fails", () => {
    const entries = [output("old", "a".repeat(80)), assistant("a1")];
    const projection = buildRetainedToolOutputProjection(entries, 1);
    const message = entries[0].message;
    const projected = applyRetainedToolOutputProjection([message], projection, {
      omissionToolCallIds: { old: "call-old" },
    });
    expect(projected[0].content[0].text).toContain("use recall");
  });

  test("budget zero disables omissions; convenience helper returns projection", () => {
    const entries = [output("old", "a".repeat(80)), assistant("a1")];
    const result = applyToolOutputBudget(entries.map((value) => structuredClone(value.message)), entries, 0, undefined, { entryIds: ["old", "a1"] });
    expect(result.projection.omissions).toEqual([]);
    expect(result.messages[0].content[0].text).toHaveLength(80);
  });

  test("includes bash output in the shared token policy", () => {
    const entries = [bash("old", "认".repeat(20)), assistant("a1")];
    const projection = buildRetainedToolOutputProjection(entries, 1);
    expect(projection.omissions[0].entryId).toBe("old");
    expect(projection.omittedTokens).toBe(20);
  });
});
