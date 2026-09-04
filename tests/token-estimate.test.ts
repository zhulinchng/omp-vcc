// @ts-nocheck
import { describe, expect, test } from "bun:test";
import {
  calibrateCharsPerToken,
  collectUsageStats,
  estimateMessageContentChars,
  estimateMessageContentTokens,
  estimateTokensFromChars,
} from "../extensions/vcc-core/core/token-estimate";

describe("token estimate", () => {
  test("estimates tokens from chars with ceil to avoid undercounting", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
  });

  test("supports calibrated chars/token ratios", () => {
    expect(estimateTokensFromChars(5, 2)).toBe(3);
    expect(estimateMessageContentTokens("abcde", 2)).toBe(3);
  });

  test("calibrates chars/token from source chars and tokens", () => {
    expect(calibrateCharsPerToken(120, 40)).toMatchObject({
      mode: "calibrated",
      charsPerToken: 3,
      sourceChars: 120,
      sourceTokens: 40,
      rawCharsPerToken: 3,
    });
  });

  test("clamps calibrated ratios and falls back without usable source tokens", () => {
    expect(calibrateCharsPerToken(10, 100).charsPerToken).toBe(2);
    expect(calibrateCharsPerToken(1000, 10).charsPerToken).toBe(6);
    expect(calibrateCharsPerToken(1000, 0)).toMatchObject({
      mode: "heuristic",
      charsPerToken: 4,
    });
  });

  test("dense head sample selects the dense prior (3), prose keeps 4", () => {
    const dense = "0x1a2b3c|sess:99-a3f9c2|q=1.618033989|{err:E1234,fn:__h_99_req}|//#endregion[99]\n".repeat(100);
    const prose = "the quick brown fox jumps over the lazy dog. ".repeat(100);
    // raw 2.0: dense truth (measured ~2.1 cpt) vs prose inflation.
    expect(calibrateCharsPerToken(2000, 1000, dense)).toMatchObject({ mode: "heuristic", charsPerToken: 3 });
    expect(calibrateCharsPerToken(2000, 1000, prose)).toMatchObject({ mode: "heuristic", charsPerToken: 4 });
  });

  test("dense tail alone selects the dense prior (prose head, dense tail)", () => {
    const prose = "Planning approach drafted. Ready to execute the approved plan. ";
    const dense = "0x1a2b3c|sess:99-a3f9c2|q=1.618033989|{err:E1234}|//#endregion[99]\n".repeat(120);
    expect(calibrateCharsPerToken(2000, 1000, prose, dense).charsPerToken).toBe(3);
    expect(calibrateCharsPerToken(2000, 1000, prose, prose).charsPerToken).toBe(4);
    expect(calibrateCharsPerToken(2000, 1000, prose).charsPerToken).toBe(4);
  });

  test("usage stats sample the tail for dense-tail sessions", () => {
    const dense = "0x1a2b3c|sess:99-a3f9c2|q=1.618033989|{err:E1234}|//#endregion[99]\n".repeat(200);
    const s = collectUsageStats([
      { role: "user", content: "Please analyze the failure dump below.", usage: { input: 80000, output: 0 } },
      { role: "user", content: dense, usage: { input: 0, output: 0 } },
    ] as any);
    // raw ~2.4 with a dense tail: dense prior, not the prose 4.
    expect(s.calibration).toMatchObject({ mode: "heuristic", charsPerToken: 3 });
  });

  test("estimates message content chars from strings and content parts", () => {
    expect(estimateMessageContentChars("hello")).toBe(5);
    expect(estimateMessageContentChars([
      { type: "text", text: "hello" },
      { type: "toolCall", name: "read", input: { path: "a.ts" } },
      { type: "toolResult", content: "done" },
      { type: "image", mimeType: "image/png" },
    ])).toBe(5 + 4 + JSON.stringify({ path: "a.ts" }).length + 4 + 4800);
  });

  test("counts real Pi part shapes: thinking text and toolCall arguments", () => {
    // Pi assistant content: thinking.thinking + toolCall.arguments (not .input).
    expect(estimateMessageContentChars([
      { type: "thinking", thinking: "reasoning", thinkingSignature: "sig" },
      { type: "text", text: "answer" },
      { type: "toolCall", name: "bash", arguments: { command: "ls" } },
    ])).toBe(9 + 6 + 4 + JSON.stringify({ command: "ls" }).length);
  });

  test("ignores non-token parts and unknown shapes without throwing", () => {
    expect(estimateMessageContentChars([
      { type: "thinking" },              // missing thinking field → 0
      { type: "toolCall", name: "noop" }, // name(4) + stringify("")=('""'=2) → 6
      { type: "mystery", text: "x" },     // unknown → falls back to text → 1
      null,                               // 0
      "not-an-object",                    // 0
    ] as any)).toBe(0 + 6 + 1 + 0 + 0);
  });

  test("estimates message content tokens through the shared char estimator", () => {
    expect(estimateMessageContentTokens("abcde")).toBe(2);
  });
});

describe("collectUsageStats", () => {
  test("counts roles, tool calls, models, span, and chars", () => {
    const msgs = [
      { role: "user", content: "hello", timestamp: 1000 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reply here" },
          { type: "toolCall", name: "Read", arguments: { path: "a" } },
        ],
        model: "m1",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        timestamp: 3000,
      },
      { role: "toolResult", toolName: "Read", content: "body", timestamp: 2000 },
      { role: "assistant", content: "done", model: "m1", timestamp: 4000 },
    ];
    const s = collectUsageStats(msgs as any);
    expect(s.messageCount).toBe(4);
    expect(s.byRole).toEqual({ user: 1, assistant: 2, toolResult: 1 });
    expect(s.toolCallCount).toBe(1);
    expect(s.models).toEqual(["m1"]);
    expect(s.spanMs).toBe(3000);
    expect(s.inputChars).toBe("hello".length + "body".length);
    expect(s.outputChars).toBe(
      "reply here".length + "Read".length + JSON.stringify({ path: "a" }).length + "done".length,
    );
    expect(s.usageTotals).toMatchObject({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
    expect(s.calibration.mode).toBe("calibrated");
    expect(s.inputTokensEst).toBeGreaterThan(0);
    expect(s.outputTokensEst).toBeGreaterThan(0);
  });

  test("falls back to heuristic calibration without provider usage", () => {
    const s = collectUsageStats([{ role: "user", content: "hi" }] as any);
    expect(s.calibration).toMatchObject({ mode: "heuristic", charsPerToken: 4 });
    expect(s.spanMs).toBeNull();
    expect(s.models).toEqual([]);
    expect(s.inputTokensEst).toBe(1);
  });

  test("handles empty input", () => {
    const s = collectUsageStats([]);
    expect(s.messageCount).toBe(0);
    expect(s.byRole).toEqual({});
    expect(s.spanMs).toBeNull();
  });
});
