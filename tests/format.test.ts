// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { capBrief, formatSummary, wrapLongLines } from "../extensions/vcc-core/core/format";
import type { SectionData } from "../extensions/vcc-core/sections";

/** A lone surrogate anywhere in the output means a pair was split. */
const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

describe("wrapLongLines: hard breaks never split a surrogate pair", () => {
  // 120 cols, so any unbroken run past the budget takes the hard-break branch.
  const line = (unit: string, n: number) => unit.repeat(n);

  it("keeps emoji pairs intact across every wrap position", () => {
    for (const n of [31, 40, 41, 42, 60, 61, 80]) {
      const text = line("😀", n);
      const wrapped = wrapLongLines(text, 120);
      expect(hasLoneSurrogate(wrapped)).toBe(false);
      expect(wrapped.split("\n").every((l) => l.length <= 120)).toBe(true);
    }
  });

  it("keeps supplementary-plane CJK pairs intact across every wrap position", () => {
    // U+20000 is outside the BMP, so it IS a surrogate pair — unlike U+6F22.
    for (const n of [40, 41, 80, 121]) {
      const wrapped = wrapLongLines("\u{20000}".repeat(n), 120);
      expect(hasLoneSurrogate(wrapped)).toBe(false);
    }
  });

  it("keeps a mixed ASCII/emoji run intact", () => {
    const wrapped = wrapLongLines(`path=${"a😀".repeat(70)}`, 120);
    expect(hasLoneSurrogate(wrapped)).toBe(false);
  });

  it("still advances when the budget is barely wider than one pair", () => {
    // Budget 22 puts the pre-fix cut at index 21 — the high half of the 11th
    // pair — so this case is only safe with the surrogate guard.
    const wrapped = wrapLongLines(line("😀", 15), 22);
    expect(hasLoneSurrogate(wrapped)).toBe(false);
    expect(wrapped.split("\n").length).toBeGreaterThan(1);
    expect(wrapped.split("\n").every((l) => l.length <= 22)).toBe(true);
  });

  it("leaves an already-short line untouched", () => {
    expect(wrapLongLines("😀 short", 120)).toBe("😀 short");
  });
});

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
