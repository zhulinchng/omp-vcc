// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { capBrief, formatSummary } from "../extensions/vcc-core/core/format";
import type { SectionData } from "../extensions/vcc-core/sections";

const empty: SectionData = {
  sessionGoal: [],
  outstandingContext: [],
  filesAndChanges: [],
  commits: [],
  userPreferences: [],
  briefTranscript: "",
};

describe("formatSummary", () => {
  it("returns empty string for all-empty sections", () => {
    expect(formatSummary(empty)).toBe("");
  });

  it("formats a single header section", () => {
    const data = {
      ...empty,
      sessionGoal: ["fix auth bug"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("- fix auth bug");
  });

  it("separates header and brief transcript with ---", () => {
    const data = {
      ...empty,
      sessionGoal: ["goal"],
      briefTranscript: "[user]\ndo something",
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("---");
    expect(r).toContain("[user]\ndo something");
  });

  it("renders brief transcript alone when no header sections", () => {
    const data = {
      ...empty,
      briefTranscript: "[user]\nhi\n\n[assistant]\nhello",
    };
    const r = formatSummary(data);
    expect(r).toContain("[user]\nhi\n\n[assistant]\nhello");
  });

  it("joins multiple header sections with blank line", () => {
    const data = {
      ...empty,
      sessionGoal: ["goal"],
      outstandingContext: ["blocker"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("[Outstanding Context]");
    expect(r).toContain("\n\n");
  });

  it("wraps long lines so compaction TUI rendering stays bounded", () => {
    const data = {
      ...empty,
      briefTranscript: `[assistant]\n${"word ".repeat(80)}`,
    };
    const r = formatSummary(data);
    expect(Math.max(...r.split("\n").map((line) => line.length))).toBeLessThanOrEqual(120);
  });
});

describe("capBrief", () => {
  it("counts the lines actually dropped, including the header snip", () => {
    // 200 lines, and the only section header inside the last-120 window sits at
    // index 10 of that window: 80 overflow + 10 snipped = 90 dropped.
    const lines = Array.from({ length: 199 }, (_, i) => `line ${i}`);
    lines[90] = "[user]";
    const capped = capBrief(lines.join("\n"));
    expect(capped).toContain("...(90 earlier lines omitted)");
    expect(capped).toContain("[user]\nline 91");
    expect(capped).not.toContain("line 90\n");
  });

  it("returns short briefs unchanged", () => {
    expect(capBrief("[user]\nhi")).toBe("[user]\nhi");
  });
});
