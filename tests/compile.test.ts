// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { compile } from "../extensions/vcc-core/core/summarize";
import {
  userMsg,
  assistantText,
  assistantWithToolCall,
  toolResult,
} from "./fixtures";

describe("compile", () => {
  it("returns empty string for no messages", () => {
    expect(compile({ messages: [] })).toBe("");
  });

  it("produces hybrid output with header + brief transcript", () => {
    const r = compile({
      messages: [
        userMsg("Fix login bug"),
        assistantWithToolCall("Read", { path: "auth.ts" }),
        assistantText("Found the issue.\n1. Fix validation"),
      ],
    });
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("Fix login bug");
    expect(r).toContain("---");
    expect(r).toContain("[user]\nFix login bug");
    expect(r).toContain('* Read "auth.ts"');
    expect(r).toContain("Found the issue.");
  });

  it("merges previous summary goals", () => {
    const r = compile({
      messages: [userMsg("New task")],
      previousSummary: "[Session Goal]\n- Original goal\n\n---\n\n[user]\nOriginal goal",
    });
    expect(r).toContain("- Original goal");
    expect(r).toContain("- New task");
  });

  it("appends brief transcript on merge", () => {
    const previousSummary = [
      "[Session Goal]\n- Original goal",
      "---",
      "[user]\nOriginal goal\n\n[assistant]\n* Read \"old.ts\"",
    ].join("\n\n");
    const r = compile({
      previousSummary,
      messages: [
        userMsg("Next step"),
        assistantWithToolCall("Read", { path: "new.ts" }),
      ],
    });
    expect(r).toContain('* Read "old.ts"');
    expect(r).toContain('* Read "new.ts"');
    expect(r).toContain("Next step");
  });

  // Outstanding Context used to be "fresh only": returning `fresh`
  // unconditionally deleted every unresolved blocker as soon as the retained
  // window scrolled past it, so the model was told nothing was outstanding.
  it("outstanding context prefers fresh blockers over previous ones", () => {
    const previousSummary = "[Outstanding Context]\n- old blocker\n\n---\n\n[user]\nhi";
    const r = compile({
      previousSummary,
      messages: [userMsg("continue"), assistantText("Still broken: the parser loses keys.")],
    });
    const sectionBody = r.split("[Outstanding Context]")[1]?.split("\n\n---")[0] ?? "";
    expect(sectionBody).toContain("parser loses keys");
    // Fresh replaces prev instead of stacking, so the section cannot grow per cycle.
    expect(sectionBody).not.toContain("old blocker");
  });

  it("outstanding context carries the previous blockers when the window shows none", () => {
    const previousSummary = "[Outstanding Context]\n- old blocker\n\n---\n\n[user]\nhi";
    const r = compile({
      previousSummary,
      messages: [userMsg("continue")],
    });
    expect(r).toContain("old blocker");
  });

  it("session goal keeps the original goal when the cap evicts old lines", () => {
    const goalLines = Array.from({ length: 8 }, (_, i) => `- goal ${i}`).join("\n");
    const previousSummary = `[Session Goal]\n${goalLines}\n\n---\n\n[user]\noriginal ask`;
    const r = compile({ previousSummary, messages: [userMsg("also handle retries")] });
    const goals = r.split("[Session Goal]")[1]?.split("\n\n")[0] ?? "";
    // The first goal is the session's original task: a FIFO tail cut used to
    // evict it as soon as a long session accumulated scope changes.
    expect(goals).toContain("goal 0");
    expect(goals).toContain("also handle retries");
  });

  it("keeps text that follows a quoted recall note in the previous summary", () => {
    const note = "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.";
    const previousSummary = [
      "[Session Goal]\n- original",
      "---",
      `[assistant]\nThe summary footer reads: ${note}`,
      "IMPORTANT tail marker",
    ].join("\n\n");
    const r = compile({ previousSummary, messages: [userMsg("go on")] });
    // Stripping from the FIRST occurrence anywhere truncated the whole tail.
    expect(r).toContain("IMPORTANT tail marker");
  });

  it("caps long brief transcript with rolling window", () => {
    // Build a very long previous transcript
    const longTranscript = Array.from({ length: 200 }, (_, i) =>
      `[user]\nmessage ${i}`
    ).join("\n\n");
    const previousSummary = `[Session Goal]\n- goal\n\n---\n\n${longTranscript}`;
    const r = compile({
      previousSummary,
      messages: [userMsg("latest")],
    });
    expect(r).toContain("earlier lines omitted");
    expect(r).toContain("latest");
  });

  it("wraps final output body; recall note appended verbatim once", () => {
    const r = compile({
      messages: [userMsg("check final summary wrapping")],
    });
    // The recall note is appended after wrapping (single 127-char line) so it
    // survives the next cycle's strip instead of compounding.
    const lines = r.split("\n");
    const body = lines.slice(0, -2);
    expect(r).toContain("vcc_recall");
    expect(Math.max(...body.map((line) => line.length))).toBeLessThanOrEqual(120);
    expect(r.trimEnd().endsWith("Do not redo work already completed.")).toBe(true);
  });
  it("long single tokens hard-break within width with a continuation marker", () => {
    const r = compile({
      messages: [userMsg(`check ${"z".repeat(150)}`)],
    });
    const lines = r.split("\n");
    const body = lines.slice(0, -2);
    expect(Math.max(...body.map((line) => line.length))).toBeLessThanOrEqual(120);
    expect(body.some((line) => line.endsWith("\\"))).toBe(true);
  });
});

describe("compile fileOps wiring", () => {
  it("renders hook-provided file ops in the summary", () => {
    // Guards the seam: CompileInput.fileOps -> buildSections -> extractFiles.
    // Without it the hook's authoritative read/modified sets are silently dropped.
    const out = compile({
      messages: [userMsg("check the config")],
      fileOps: { readFiles: ["src/only-from-hook.ts"], modifiedFiles: ["src/changed-by-hook.ts"] },
    });
    expect(out).toContain("only-from-hook.ts");
    expect(out).toContain("changed-by-hook.ts");
  });
});
