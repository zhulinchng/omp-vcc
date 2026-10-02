// @ts-nocheck
// Step 2 + Step 3 regressions, driven through the PRODUCTION entry points
// (`compile` / `compileSegment`). The existing suite missed both defects because
// tests/brief.test.ts builds NormalizedBlocks by hand and calls compileBrief
// directly, bypassing filterNoise — the exact stage that dropped sourceIndex.
//
// Step 2 (high): filterNoise rebuilt user blocks as `{ kind, text }`, dropping
// `sourceIndex`. brief.ts renders ` (#N)` from that field, so EVERY [user] line of
// EVERY compaction summary lost its vcc_recall drill-down pointer.
//
// Step 3 (high): brief.ts recognised tool lines by the "* " prefix. Assistant
// markdown bullets have the same shape, so a bullet list was read as tool output:
// the first bullet was deleted and replaced with a fabricated
// "1 earlier tool-call entries omitted" — with zero tool calls in the turn.
import { describe, test, expect } from "bun:test";
import { compile, compileSegment, compileRanked } from "../extensions/vcc-core/core/summarize";
import { buildBriefSections } from "../extensions/vcc-core/core/brief";
import { normalize } from "../extensions/vcc-core/core/normalize";

const userMsg = (content: string) => ({ role: "user", content });
const assistantText = (content: string) => ({ role: "assistant", content });

const base = (messages: unknown[]) => ({ messages, fileOps: { files: [], edits: [] } });

describe("step 2: user lines keep their (#N) pointer through filterNoise", () => {
  test("compile() keeps (#0) on a plain user turn", () => {
    const out = compile(base([userMsg("ship the fix")]));
    expect(out).toContain("ship the fix (#0)");
  });

  test("compile() keeps the pointer for a later user turn", () => {
    const out = compile(base([
      assistantText("working on it"),
      userMsg("Now add the retry path"),
    ]));
    expect(out).toContain("Now add the retry path (#1)");
  });

  test("compileSegment() keeps the pointer too", () => {
    const out = compileSegment(base([userMsg("Please refactor the auth module")]));
    expect(out).toContain("Please refactor the auth module (#0)");
  });

  test("a user turn with a harness system-reminder still keeps its pointer", () => {
    // filterNoise strips the XML wrapper AND rebuilds the block — the branch that
    // used to lose sourceIndex.
    const out = compile(base([
      userMsg("remove this\n<system-reminder>ignore me</system-reminder>"),
    ]));
    expect(out).toContain("remove this (#0)");
    expect(out).not.toContain("ignore me");
  });

  test("multiple user turns each carry their own distinct pointer", () => {
    const out = compile(base([
      userMsg("first ask"),
      assistantText("ok"),
      userMsg("second ask"),
      assistantText("ok"),
      userMsg("third ask"),
    ]));
    expect(out).toContain("first ask (#0)");
    expect(out).toContain("second ask (#2)");
    expect(out).toContain("third ask (#4)");
  });
});

describe("step 3: assistant markdown bullets are not tool calls", () => {
  const bullets = Array.from({ length: 9 }, (_, i) => `* item ${i + 1}`).join("\n");

  test("all nine bullets survive with zero tool calls", () => {
    const out = compile(base([
      assistantText(bullets),
    ]));
    for (let i = 1; i <= 9; i++) expect(out).toContain(`item ${i}`);
    expect(out).not.toContain("earlier tool-call entries omitted");
  });

  test("no fabricated tool-call marker when there were no tool calls", () => {
    const out = compile(base([assistantText(bullets)]));
    expect(out).not.toContain("tool-call entries omitted");
  });

  test("bullet lists do not displace real tool lines from the cap", () => {
    // 6 real tool calls + 9 bullets. Only tool lines may be capped.
    const calls = Array.from({ length: 6 }, (_, i) => ({
      role: "assistant",
      content: [{ type: "toolCall", id: `tc${i}`, name: "read", arguments: { path: `f${i}.ts` } }],
    }));
    const out = compile(base([...calls, assistantText(bullets)]));
    for (let i = 1; i <= 9; i++) expect(out).toContain(`item ${i}`);
    expect(out).not.toContain("earlier tool-call entries omitted");
  });

  test("the cap still fires for 10 real tool calls (no regression)", () => {
    const calls = Array.from({ length: 10 }, (_, i) => ({
      role: "assistant",
      content: [{ type: "toolCall", id: `tc${i}`, name: "read", arguments: { path: `f${i}.ts` } }],
    }));
    const out = compile(base(calls));
    expect(out).toContain("* (2 earlier tool-call entries omitted)");
  });

  test("the collapse of identical tool lines still works (no regression)", () => {
    const out = compile(base([
      { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: { path: "a.ts" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "b", name: "read", arguments: { path: "a.ts" } }] },
    ]));
    expect(out).toContain("x2");
  });

  test("compileRanked preserves bullets too", () => {
    const out = compileRanked(base([assistantText(bullets)]));
    expect(out).not.toContain("earlier tool-call entries omitted");
    for (let i = 1; i <= 9; i++) expect(out).toContain(`item ${i}`);
  });

  test("the omission marker is itself tracked as a tool line", () => {
    // Guards the index bookkeeping across both rebuild passes: the marker is
    // emitted by the cap loop and must be classified as a tool line, not leak
    // onto the following line's index.
    const calls = Array.from({ length: 10 }, (_, i) => ({
      role: "assistant",
      content: [{ type: "toolCall", id: `tc${i}`, name: "read", arguments: { path: `f${i}.ts` } }],
    }));
    const out = compile(base(calls));
    expect(out).toContain("* (2 earlier tool-call entries omitted)");

    const sections = buildBriefSections(normalize(calls) as any);
    const assistantSections = sections.filter((s) => s.header === "[assistant]");
    expect(assistantSections.length).toBeGreaterThan(0);
    for (const sec of assistantSections) {
      sec.lines.forEach((line, i) => {
        if (sec.toolLineIdx.has(i)) {
          expect(line.startsWith("* ")).toBe(true);
        }
      });
    }
    const markerIndex = assistantSections
      .flatMap((s) => s.lines.map((l, i) => ({ s, l, i })))
      .findIndex((x) => x.l.includes("earlier tool-call entries omitted"));
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const markerHolder = assistantSections
      .flatMap((s) => s.lines.map((l, i) => ({ s, l, i })))
      .find((x) => x.l.includes("earlier tool-call entries omitted"))!;
    expect(markerHolder.s.toolLineIdx.has(markerHolder.i)).toBe(true);
  });

});
