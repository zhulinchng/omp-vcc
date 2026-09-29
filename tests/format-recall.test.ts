// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { formatRecallOutput, formatTouchedOutput } from "../extensions/vcc-core/core/format-recall";
import type { RenderedEntry } from "../extensions/vcc-core/core/render-entries";

describe("formatRecallOutput", () => {
  it("shows no-match message with query", () => {
    const r = formatRecallOutput([], "xyz");
    expect(r).toContain('No matches for "xyz"');
  });

  it("shows no-entries message without query", () => {
    expect(formatRecallOutput([])).toContain("No entries");
  });

  it("formats entries with index and role", () => {
    const entries: RenderedEntry[] = [
      { index: 0, role: "user", summary: "hello" },
    ];
    const r = formatRecallOutput(entries);
    expect(r).toContain("#0 [user] hello");
  });

  it("shows match count with query", () => {
    const entries: RenderedEntry[] = [
      { index: 2, role: "assistant", summary: "done" },
    ];
    const r = formatRecallOutput(entries, "done");
    expect(r).toContain('Found 1 matches for "done"');
  });
});

describe("formatTouchedOutput pagination", () => {
  it("guides an out-of-range page instead of printing an empty body", () => {
    const touched = [{ path: "/tmp/a.ts", entries: [{ index: 3, toolName: "Write" }] }];
    const r = formatTouchedOutput(touched, 99);
    expect(r).toContain("Page 99 is outside the available range 1-1 (1 total files).");
    expect(r).toContain("Use page:N with N between 1 and 1.");
  });

  it("floors a fractional page", () => {
    const touched = [{ path: "/tmp/a.ts", entries: [{ index: 3, toolName: "Write" }] }];
    expect(formatTouchedOutput(touched, 1.5)).toContain("1 files touched");
  });

  it("pages within range", () => {
    const touched = Array.from({ length: 7 }, (_, i) => ({ path: `/tmp/f${i}.ts`, entries: [{ index: i, toolName: "Read" }] }));
    expect(formatTouchedOutput(touched, 2)).toContain("Page 2/2 (7 total files)");
  });
});
