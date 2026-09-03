// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { normalize } from "../extensions/vcc-core/core/normalize";
import { compileBrief } from "../extensions/vcc-core/core/brief";
import { renderMessage } from "../extensions/vcc-core/core/render-entries";
import { searchEntries } from "../extensions/vcc-core/core/search-entries";
import type { Message } from "@oh-my-pi/pi-ai";
import { assistantWithThinking } from "./fixtures";

const THINKING_MARKER = "zephyr internal plan upside down";
const VISIBLE_TEXT = "visible reply";

const thinkingOnlyMsg = (): Message => ({
  role: "assistant",
  content: [{ type: "thinking", thinking: THINKING_MARKER }],
} as any);

describe("thinking preservation (VCC paper first-class thinking nodes)", () => {
  it("normalize keeps thinking as its own block with sourceIndex", () => {
    const blocks = normalize([assistantWithThinking(VISIBLE_TEXT, THINKING_MARKER)]);
    expect(blocks).toEqual([
      { kind: "thinking", text: THINKING_MARKER, sourceIndex: 0 },
      { kind: "assistant", text: VISIBLE_TEXT, sourceIndex: 0 },
    ]);
  });

  it("normalize drops empty or missing thinking text", () => {
    const empty = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: VISIBLE_TEXT }],
    } as any;
    expect(normalize([empty])).toEqual([
      { kind: "assistant", text: VISIBLE_TEXT, sourceIndex: 0 },
    ]);
    const missing = {
      role: "assistant",
      content: [{ type: "thinking" }, { type: "text", text: VISIBLE_TEXT }],
    } as any;
    expect(normalize([missing])).toEqual([
      { kind: "assistant", text: VISIBLE_TEXT, sourceIndex: 0 },
    ]);
  });

  it("brief elides thinking blocks (reference lower_brief parity)", () => {
    const brief = compileBrief(normalize([assistantWithThinking(VISIBLE_TEXT, THINKING_MARKER)]));
    expect(brief).not.toContain(THINKING_MARKER);
    expect(brief).toContain(VISIBLE_TEXT);
  });

  it("renderMessage tags thinking-only messages with the thinking role", () => {
    const r = renderMessage(thinkingOnlyMsg(), 7);
    expect(r.role).toBe("thinking");
    expect(r.summary).toContain(THINKING_MARKER);
  });

  it("renderMessage keeps the assistant role for mixed thinking+text", () => {
    const r = renderMessage(assistantWithThinking(VISIBLE_TEXT, THINKING_MARKER), 7);
    expect(r.role).toBe("assistant");
    expect(r.summary).toBe(VISIBLE_TEXT);
  });

  it("recall finds terms that exist only in thinking, with a thinking hit", () => {
    const msgs: Message[] = [thinkingOnlyMsg()];
    const rendered = msgs.map((m, i) => renderMessage(m, i));
    const hits = searchEntries(rendered, msgs, "zephyr");
    expect(hits).toHaveLength(1);
    expect(hits[0].role).toBe("thinking");
    expect(hits[0].snippet).toContain("zephyr");
  });

  it("recall finds thinking-only terms inside mixed messages", () => {
    const msgs: Message[] = [assistantWithThinking(VISIBLE_TEXT, THINKING_MARKER)];
    const rendered = msgs.map((m, i) => renderMessage(m, i));
    const hits = searchEntries(rendered, msgs, "zephyr");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("zephyr");
  });
});
