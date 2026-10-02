// @ts-nocheck
// Step 8 regression: the ranked path (compileRanked — the production default)
// never applied capBrief, and when the fresh brief met or exceeded
// BRIEF_MAX_LINES the previous-cycle brief was dropped by
// `capBriefToLineBudget(text, 0) → ""` with NO omission marker. A 200-line prior
// brief therefore vanished and the model was handed a summary that looked
// complete but had lost an entire compaction cycle.
//
// capBrief always emits an omission notice (format.ts:56-57); this pins that the
// merge path now does too.
import { describe, test, expect } from "bun:test";
import { compileRanked } from "../extensions/vcc-core/core/summarize";
import { BRIEF_MAX_LINES } from "../extensions/vcc-core/core/format";

// A previous-cycle brief long enough that the fresh brief alone exhausts the
// line budget.
const previousBrief = (lines: number) => {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(`[assistant] * Read "prior${i}.ts" (#${i})`);
  return `[Session Goal]\n- prior goal ${"z".repeat(200)}\n\n---\n\n${out.join("\n")}`;
};

// A fresh brief whose line count alone fills BRIEF_MAX_LINES.
const freshMessages = (lines: number) => {
  const msgs: unknown[] = [];
  for (let i = 0; i < lines; i++) {
    msgs.push({ role: "user", content: `fresh request ${i} ${"q".repeat(300)}` });
    msgs.push({ role: "assistant", content: `fresh answer ${i}` });
  }
  return msgs;
};

describe("step 8: previous-cycle brief is never silently dropped", () => {
  test("the omission notice reports the REAL number of prior lines lost", () => {
    // A previous change re-capped the merged string with capBrief, which
    // recomputed the count against the already-truncated blob: a real
    // "...(200 earlier lines omitted)" was reported as "...(4 earlier lines
    // omitted)". The count must be measured against the real previous brief.
    for (const pairs of [20, 30, 40, 50]) {
      const out = compileRanked({
        messages: freshMessages(pairs),
        previousSummary: previousBrief(200),
        fileOps: { files: [], edits: [] },
      });
      const match = out.match(/\.\.\.\((\d+) earlier lines omitted\)/);
      expect(match).not.toBeNull();
      const omitted = Number.parseInt(match![1], 10);
      // 200 prior brief lines total; the notice can never claim fewer than
      // what actually disappeared.
      expect(omitted).toBeGreaterThan(150);
      expect(out).toContain("prior goal");
    }
  });

  test("the previous brief gets its reserved share of the line budget", () => {
    // The previous half is trimmed so that notice + blank + separator + fresh
    // stays inside BRIEF_MAX_LINES.
    const out = compileRanked({
      messages: freshMessages(5),
      previousSummary: previousBrief(200),
      fileOps: { files: [], edits: [] },
    });
    expect(out).toContain("earlier lines omitted");
    const keptPrior = (out.match(/prior\d+\.ts/g) ?? []).length;
    expect(keptPrior).toBeGreaterThan(0);
    expect(keptPrior).toBeLessThan(200);
  });

  test("a prior brief that fits is merged verbatim (no regression)", () => {
    const prev = previousBrief(3);
    const out = compileRanked({
      messages: freshMessages(2),
      previousSummary: prev,
      fileOps: { files: [], edits: [] },
    });
    expect(out).toContain("prior0.ts");
    expect(out).toContain("prior2.ts");
    expect(out).not.toContain("earlier lines omitted");
  });

  test("empty previous brief adds no spurious notice (no regression)", () => {
    const out = compileRanked({
      messages: freshMessages(2),
      previousSummary: undefined,
      fileOps: { files: [], edits: [] },
    });
    expect(out).not.toContain("earlier lines omitted");
  });
});
