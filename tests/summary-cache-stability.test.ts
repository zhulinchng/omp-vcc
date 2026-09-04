// @ts-nocheck
// Prompt-cache stability: the summary becomes the new conversation prefix
// (system, summary, kept tail), so provider prefix-caching bills it at the
// read rate on every later turn — but only while its bytes stay identical.
// Caching is a prefix match: any byte difference at position N invalidates
// everything after it. These pin what omp-vcc controls: deterministic bytes
// for identical input, no per-request volatile data, and append-mostly growth
// (stable head, new content at the tail) across re-compactions.
import { describe, test, expect } from "bun:test";
import { compileRanked } from "../extensions/vcc-core/core/summarize";

const msgsA = [
  { role: "user", content: "Goal: migrate auth to OAuth2 without new dependencies." },
  { role: "assistant", content: [{ type: "text", text: "Starting with the login route." }, { type: "toolCall", id: "t1", name: "read", arguments: { path: "src/auth.ts" } }] },
  { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "route code here" }] },
];
const msgsB = [
  { role: "user", content: "Also rotate refresh tokens hourly." },
  { role: "assistant", content: [{ type: "text", text: "Wiring rotation now." }, { type: "toolCall", id: "t2", name: "edit", arguments: { path: "src/session.ts" } }] },
];

describe("summary cache stability", () => {
  test("identical input compiles to byte-identical output", () => {
    // No timestamps, randomness, or map-ordering nondeterminism anywhere in
    // the compile path: same bytes in, same bytes out, every time.
    expect(compileRanked({ messages: msgsA })).toBe(compileRanked({ messages: msgsA }));
  });

  test("summary carries no per-request volatile data", () => {
    // A timestamp/UUID baked into the summary would invalidate the cached
    // prefix on every request. Fixed input must produce none.
    const s = compileRanked({ messages: msgsA });
    expect(s).not.toMatch(/20\d\d-\d\d-\d\d[T ]\d\d:/);
    expect(s).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  });

  test("re-compaction preserves the head verbatim (append-mostly growth)", () => {
    // New content lands at the tail (brief append + merged sections), so the
    // cached head survives across compactions instead of shifting.
    const s1 = compileRanked({ messages: msgsA });
    const s2 = compileRanked({ messages: [...msgsA, ...msgsB], previousSummary: s1 });
    expect(s2.startsWith("[Session Goal]\n")).toBe(true);
    const goalLine = s1.split("\n").find((l) => l.includes("OAuth2"))!;
    expect(goalLine.length).toBeGreaterThan(0);
    expect(s2).toContain(goalLine);
    expect(s2).toContain("rotate refresh tokens");
  });
});
