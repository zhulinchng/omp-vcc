// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { filterNoise } from "../extensions/vcc-core/core/filter-noise";
import type { NormalizedBlock } from "../extensions/vcc-core/types";

describe("filterNoise", () => {
  it("removes noise tool calls and results", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "TodoWrite", args: {} },
      { kind: "tool_result", name: "TodoWrite", text: "ok" },
      { kind: "tool_call", name: "Read", args: { path: "x.ts" } },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "tool_call", name: "Read", args: { path: "x.ts" } });
  });

  it("removes user blocks that are pure XML wrappers", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "<system-reminder>some noise</system-reminder>" },
      { kind: "user", text: "Fix the bug" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "user", text: "Fix the bug" });
  });

  it("cleans XML wrappers from user text but keeps real content", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "<system-reminder>noise</system-reminder>\nFix the login" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect((result[0] as any).text).toBe("Fix the login");
  });

  it("removes known noise strings", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Continue from where you left off." },
      { kind: "user", text: "real task" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect((result[0] as any).text).toBe("real task");
  });

  it("removes the host-facing snake_case noise tool names", () => {
    // omp/pi emit `todo`, `web_search` and `ask` (builtin-names.ts), while
    // NOISE_TOOLS only carried the legacy camelCase names, so none of them were
    // ever filtered.
    for (const name of ["todo", "TodoWrite", "web_search", "WebSearch", "ask", "AskUser"]) {
      const blocks: NormalizedBlock[] = [
        { kind: "tool_call", name, args: {} },
        { kind: "tool_result", name, text: "ok" },
        { kind: "user", text: "real task" },
      ];
      const result = filterNoise(blocks);
      expect(result).toHaveLength(1);
      expect((result[0] as any).text).toBe("real task");
    }
  });

  it("never throws on a non-string tool name", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: 123 as unknown as string, args: {} },
      { kind: "tool_result", name: undefined as unknown as string, text: "ok" },
    ];
    expect(() => filterNoise(blocks)).not.toThrow();
    expect(filterNoise(blocks)).toHaveLength(2);
  });

  it("preserves non-noise tool calls", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Edit", args: { path: "a.ts" } },
      { kind: "tool_result", name: "Edit", text: "ok" },
    ];
    expect(filterNoise(blocks)).toHaveLength(2);
  });
});
