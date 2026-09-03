// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { extractFiles, longestCommonDirPrefix, renderFileCategoryLines } from "../extensions/vcc-core/extract/files";
import { DEFAULT_SETTINGS } from "../extensions/vcc-core/core/settings";
import type { NormalizedBlock } from "../extensions/vcc-core/types";

describe("extractFiles", () => {
  it("matches tool names case-insensitively", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "read", args: { path: "a.ts" } },
      { kind: "tool_call", name: "Read", args: { path: "b.ts" } },
      { kind: "tool_call", name: "Write", args: { path: "c.ts" } },
      { kind: "tool_call", name: "MultiEdit", args: { path: "d.ts" } },
    ];
    const r = extractFiles(blocks);
    expect([...r.read].sort()).toEqual(["a.ts", "b.ts"]);
    expect([...r.modified].sort()).toEqual(["c.ts", "d.ts"]);
    expect([...r.created]).toEqual(["c.ts"]);
  });

  it("records modern edit tools as modifications", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "quick_edit", args: { path: "a.ts" } },
      { kind: "tool_call", name: "target_edit", args: { path: "b.ts" } },
    ];
    const r = extractFiles(blocks);
    expect([...r.modified].sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("seeds activity from hook-provided fileOps", () => {
    const r = extractFiles([], { readFiles: ["x.ts"], modifiedFiles: ["y.ts"], createdFiles: [] });
    expect([...r.read]).toEqual(["x.ts"]);
    expect([...r.modified]).toEqual(["y.ts"]);
  });
});

describe("renderFileCategoryLines", () => {
  const files = (n: number, dir = "/repo/src") =>
    Array.from({ length: n }, (_, i) => `${dir}/f-${String(i).padStart(2, "0")}.ts`);

  it("collapses a shared prefix for display", () => {
    const lines = renderFileCategoryLines("Modified", files(3));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("(in /repo/src/)");
    expect(lines[0]).toContain("f-00.ts");
  });

  it("groups overflow by directory, all names preserved", () => {
    const lines = renderFileCategoryLines("Modified", files(25));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("(+5 more under /repo/src/):");
    expect(lines[1]).toContain("f-24.ts");
  });

  it("past the total cap degrades to an honest bare count", () => {
    const lines = renderFileCategoryLines("Modified", files(120));
    expect(lines[lines.length - 1]).toBe("Modified (+20 more)");
  });

  it("returns [] for no paths", () => {
    expect(renderFileCategoryLines("Read", [])).toEqual([]);
  });
});

describe("longestCommonDirPrefix", () => {
  it("needs two absolute paths with /a/b common", () => {
    expect(longestCommonDirPrefix(["/a/b/c.ts"])).toBe("");
    expect(longestCommonDirPrefix(["a.ts", "b.ts"])).toBe("");
    expect(longestCommonDirPrefix(["/a/c.ts", "/b/d.ts"])).toBe("");
    expect(longestCommonDirPrefix(["/a/b/c.ts", "/a/b/d.ts"])).toBe("/a/b/");
  });
});

describe("settings defaults", () => {
  it("overrides pi core compaction by default", () => {
    expect(DEFAULT_SETTINGS.overrideDefaultCompaction).toBe(true);
  });
});
