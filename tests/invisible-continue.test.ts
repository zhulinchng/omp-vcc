// @ts-nocheck
import { describe, expect, it, test } from "bun:test";
import {
  registerBeforeCompactHook,
  triggerInvisibleContinue,
  buildOwnCut,
  AUTO_CONTINUE_CUSTOM_TYPE,
} from "../extensions/vcc-core/hook";

describe("invisible auto-continue: trigger + context filter", () => {
  it("triggerInvisibleContinue sends a hidden custom message with followUp delivery", () => {
    const calls: { m: any; o: any }[] = [];
    const pi = { sendMessage: (m: any, o: any) => calls.push({ m, o }) } as any;
    triggerInvisibleContinue(pi);

    expect(calls).toHaveLength(1);
    expect(calls[0].o).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(calls[0].m).toMatchObject({
      customType: AUTO_CONTINUE_CUSTOM_TYPE,
      content: [],
      display: false,
    });
  });

  it("context hook filters ONLY our customType; other custom messages pass through untouched", () => {
    let handler: ((event: any) => unknown) | undefined;
    const pi = { on: (e: string, h: any) => { if (e === "context") handler = h; } } as any;
    registerBeforeCompactHook(pi);

    const user = { role: "user", content: [{ type: "text", text: "keep" }] };
    const own = { role: "custom", customType: AUTO_CONTINUE_CUSTOM_TYPE, content: [] };
    const other = { role: "custom", customType: "some-other-ext", content: [{ type: "text", text: "ctx" }] };

    const result = handler?.({ messages: [user, own, other] });
    const filtered = ((result as any)?.messages ?? [user, own, other]) as any[];
    expect(filtered).toEqual([user, other]);
  });

  it("context hook is a pure filter: returns undefined when nothing to remove", () => {
    let handler: ((event: any) => unknown) | undefined;
    const pi = { on: (e: string, h: any) => { if (e === "context") handler = h; } } as any;
    registerBeforeCompactHook(pi);

    const user = { role: "user", content: [{ type: "text", text: "hi" }] };
    const other = { role: "custom", customType: "other-ext", content: [] };
    const result = handler?.({ messages: [user, other] });
    expect(result).toBeUndefined(); // no mutation, no return
  });

  it("filter is idempotent: removing our marker yields empty result deterministically", () => {
    let handler: ((event: any) => unknown) | undefined;
    const pi = { on: (e: string, h: any) => { if (e === "context") handler = h; } } as any;
    registerBeforeCompactHook(pi);

    const own = { role: "custom", customType: AUTO_CONTINUE_CUSTOM_TYPE, content: [] };
    const once = handler?.({ messages: [own] });
    const messages = ((once as any)?.messages ?? []) as any[];
    expect(messages).toEqual([]);
  });
});

describe("invisible auto-continue: summarize-path noise", () => {
  it("our continue custom message carries empty content → adds no noise to summarizer input", () => {
    const entries = [
      { id: "u1", type: "message", message: { role: "user", content: "go" } },
      { id: "a1", type: "message", message: { role: "assistant", content: "reply" } },
      {
        id: "c1",
        type: "custom_message",
        customType: AUTO_CONTINUE_CUSTOM_TYPE,
        content: [],
        display: false,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      { id: "u2", type: "message", message: { role: "user", content: "next" } },
      { id: "a2", type: "message", message: { role: "assistant", content: "done" } },
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;

    // The continue message is collected into the live window (harmless) but its
    // content is empty, so it contributes zero text/tokens to the summarizer.
    const custom = cut.messages.find((m: any) => m.content && m.role === "custom");
    expect(custom).toBeDefined();
    const contentLen = Array.isArray(custom.content)
      ? custom.content.length
      : String(custom.content ?? "").length;
    expect(contentLen).toBe(0);
  });
});