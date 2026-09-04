// @ts-nocheck
// joinBounded byte-equivalence: the bounded calibration sampler must produce
// exactly `parts.join("\n").slice(0, bound)` without materializing the join.
import { describe, test, expect } from "bun:test";
import { joinBounded } from "../extensions/vcc-core/hook.ts";

// Deterministic PRNG (mulberry-ish LCG) — fixed seed, no flakiness.
const rand = (() => {
  let s = 0x9e3779b9;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
})();

describe("joinBounded", () => {
  test("matches join+slice on randomized parts and bounds", () => {
    const alphabet = ["a", "auth", "", "x".repeat(5000), "héllo wörld ✓", "\n", "line1\nline2", "z".repeat(9000)];
    for (let trial = 0; trial < 50; trial++) {
      const n = Math.floor(rand() * 8);
      const parts = Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]);
      for (const bound of [0, 1, 7, 7999, 8000, 8001, 20000]) {
        expect(joinBounded(parts, bound)).toBe(parts.join("\n").slice(0, bound));
      }
    }
  });

  test("empty input and exact-boundary cuts", () => {
    expect(joinBounded([], 8000)).toBe("");
    expect(joinBounded(["ab", "cd"], 5)).toBe("ab\ncd");
    expect(joinBounded(["ab", "cd"], 4)).toBe("ab\nc");
    expect(joinBounded(["ab", "cd"], 3)).toBe("ab\n");
    expect(joinBounded(["ab", "cd"], 2)).toBe("ab");
    expect(joinBounded(["", "", ""], 10)).toBe("\n\n");
  });

  test("never builds the full string for huge parts", () => {
    // A 2MB single part: naive join would allocate 2MB+; bounded join keeps
    // only the bound. Observable via exact-length result (allocation itself
    // isn't observable, but truncation correctness at scale is).
    const big = "q".repeat(2_000_000);
    const out = joinBounded(["head", big, "tail-never-reached"], 8000);
    expect(out).toBe(["head", big, "tail-never-reached"].join("\n").slice(0, 8000));
    expect(out.length).toBe(8000);
  });
});
