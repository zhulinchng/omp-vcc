// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { formatRecallOutput, formatTouchedOutput, normalizePageNumber } from "../extensions/vcc-core/core/format-recall";
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

// A non-numeric page made Math.floor NaN and Math.max(1, NaN) NaN, so the
// out-of-range guard compared false, slice(NaN, NaN) was empty, and the header
// still printed "Page NaN/N" over a blank body.
describe("normalizePageNumber", () => {
  it("accepts only finite numeric input", () => {
    expect(normalizePageNumber(3)).toBe(3);
    expect(normalizePageNumber(3.9)).toBe(3);
    expect(normalizePageNumber(0)).toBe(1);
    expect(normalizePageNumber(-2)).toBe(1);
    expect(normalizePageNumber("2")).toBe(1);
    expect(normalizePageNumber({ page: 1 })).toBe(1);
    expect(normalizePageNumber(Number.NaN)).toBe(1);
    expect(normalizePageNumber(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalizePageNumber(undefined)).toBe(1);
  });
});

describe("formatTouchedOutput: non-numeric page", () => {
  const touched = Array.from({ length: 7 }, (_, i) => ({ path: `/tmp/f${i}.ts`, entries: [{ index: i, toolName: "Read" }] }));
  // `as unknown as number` is deliberate: this test exists precisely because a
  // provider can deliver a string where the schema declares a number.
  const asPage = (v: unknown): number => v as unknown as number;

  it("falls back to page 1 instead of emitting NaN", () => {
    const out = formatTouchedOutput(touched, asPage("two"));
    expect(out).not.toContain("NaN");
    expect(out).toContain("Page 1/2 (7 total files)");
    expect(out).toContain("f0.ts");
  });

  it("falls back for NaN, Infinity and a fractional page above the range", () => {
    expect(formatTouchedOutput(touched, asPage(Number.NaN))).toContain("Page 1/2");
    expect(formatTouchedOutput(touched, asPage(Number.POSITIVE_INFINITY))).toContain("Page 1/2");
    expect(formatTouchedOutput(touched, asPage(-3))).toContain("Page 1/2");
  });

  it("still reports a genuinely out-of-range numeric page", () => {
    expect(formatTouchedOutput(touched, 9)).toContain("Page 9 is outside the available range 1-2");
  });
});
