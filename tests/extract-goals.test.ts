// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { extractGoals } from "../extensions/vcc-core/extract/goals";
import type { NormalizedBlock } from "../extensions/vcc-core/types";

describe("extractGoals", () => {
  it("returns empty for no blocks", () => {
    expect(extractGoals([])).toEqual([]);
  });

  it("returns empty when no user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "hello" },
    ];
    expect(extractGoals(blocks)).toEqual([]);
  });

  it("extracts first user message lines as goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug\nCheck auth flow" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toEqual(["Fix login bug", "Check auth flow"]);
  });

  it("takes up to 6 lines from first user block", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "fix the login bug\ncheck auth flow\nupdate the tests\nrefactor utils\nclean up" },
    ];
    expect(extractGoals(blocks)).toHaveLength(5);
  });

  it("ignores subsequent user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "first goal" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "second request" },
    ];
    expect(extractGoals(blocks)).toEqual(["first goal"]);
  });

  it("detects scope change with explicit pivot keywords", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "Actually, instead let's refactor the auth module" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toContain("Fix login bug");
    expect(goals).toContain("[Scope change]");
    expect(goals.some((g) => g.includes("refactor"))).toBe(true);
  });

  it("detects scope change from new task statements", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "done" },
      { kind: "user", text: "Now implement the user registration flow" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toContain("[Scope change]");
  });

  it("keeps latest scope change only", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug" },
      { kind: "assistant", text: "done" },
      { kind: "user", text: "Actually, fix the signup page instead" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "Change of plan, implement password reset" },
    ];
    const goals = extractGoals(blocks);
    const scopeIdx = goals.indexOf("[Scope change]");
    expect(goals[scopeIdx + 1]).toContain("password reset");
  });

  it("clips a first instruction longer than the goal cap instead of dropping it", () => {
    const long = `Implement the retry logic for the sync worker ${"detail ".repeat(40)}`;
    expect(long.length).toBeGreaterThan(200);
    const goals = extractGoals([{ kind: "user", text: long }]);
    expect(goals).toHaveLength(1);
    expect(goals[0].length).toBeLessThanOrEqual(200);
    expect(goals[0].startsWith("Implement the retry logic")).toBe(true);
  });

  it("keeps instructions that start with an acknowledgement", () => {
    // `ok\b.*` in NOISE_SHORT_RE used to swallow the whole line.
    const goals = extractGoals([{ kind: "user", text: "ok now implement the retry logic" }]);
    expect(goals.length).toBeGreaterThan(0);
    expect(goals.join(" ")).toContain("retry logic");

    // A bare acknowledgement from the FIRST user message is still noise, but a
    // later one is a scope change / task instruction and must not vanish.
    const later = extractGoals([
      { kind: "user", text: "Fix the auth module" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "ok now implement the retry logic" },
    ]);
    expect(later.join(" ")).toContain("retry logic");
  });

  it("still treats bare acknowledgements as noise", () => {
    for (const text of ["ok", "ok.", "Ok!", "yes", "thanks", "y"]) {
      expect(extractGoals([{ kind: "user", text }])).toEqual([]);
    }
  });

  it("skips noise short user messages as goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "ok" },
      { kind: "assistant", text: "hello" },
      { kind: "user", text: "Fix the authentication module" },
    ];
    const goals = extractGoals(blocks);
    expect(goals[0]).toContain("Fix the authentication");
    expect(goals.some((g) => g === "ok")).toBe(false);
  });
});
