// @ts-nocheck
// Step 7 regressions for the `context` handler.
//
// The optimisation builds its omission-id set before handing the projection to
// applyRetainedToolOutputProjection, which is correct only if the malformed-shape
// degradation survives. `projection` is read straight out of the persisted
// session file (`latest.details.retainedToolOutputProjection`) with no shape
// validation on this path, and applyRetainedToolOutputProjection used to absorb a
// non-array `omissions` by returning `messages` unchanged.
//
// An intermediate version called `.map()` unguarded, which threw. That is far
// worse than a single failed projection: a throw inside the `context` handler
// makes the host discard the handler's ENTIRE return value, so the invisible-
// continue marker filtering at the top of the handler and the append-chain
// projection are lost on every provider request for that session.
import { describe, test, expect } from "bun:test";
import { registerBeforeCompactHook } from "../extensions/vcc-core/hook";

const AUTO_CONTINUE = "omp-vcc-auto-continue";

function runContext(omissions: unknown) {
  const pi: any = { on: (n: string, h: any) => { pi[n] = h; }, sendMessage(){}, sendUserMessage(){} };
  registerBeforeCompactHook(pi);
  const entries: any[] = [
    { id: "m0", type: "message", message: { role: "user", content: "keep me" } },
    {
      id: "c1",
      type: "compaction",
      summary: "prior summary",
      details: {
        compactor: "omp-vcc",
        version: 2,
        sections: [],
        sourceMessageCount: 0,
        previousSummaryUsed: false,
        retainedToolOutputProjection: { version: 1, retainedTokens: 0, omittedTokens: 0, pendingCount: 0, omissions },
      },
    },
  ];
  const ctx: any = { sessionManager: { getEntries: () => entries, getBranch: () => entries }, ui: { notify(){} } };
  // Includes an invisible-continue marker so the handler's other job is observable.
  const result: any = pi["context"](
    { messages: [{ role: "custom", customType: AUTO_CONTINUE, content: "continue" }, { role: "user", content: "hi" }] },
    ctx,
  );
  return result;
}

describe("step 7: the context handler degrades gracefully on malformed projections", () => {
  test("a valid empty omission list still filters the auto-continue marker", () => {
    const result = runContext([]);
    expect(result).toBeDefined();
    expect(result.messages.some((m) => m.customType === AUTO_CONTINUE)).toBe(false);
  });

  for (const [name, value] of [
    ["a plain object", { bogus: 1 }],
    ["a number", 7],
    ["a string", "nope"],
    ["null", null],
  ] as Array<[string, unknown]>) {
    test(`omissions as ${name} does not throw and still filters markers`, () => {
      const result = runContext(value);
      expect(result).toBeDefined();
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.messages.some((m) => m.customType === AUTO_CONTINUE)).toBe(false);
    });
  }

  test("omissions containing non-object entries is tolerated", () => {
    const result = runContext([null, 5, "x", { entryId: "nope", marker: "m" }]);
    expect(result).toBeDefined();
    expect(result.messages.some((m) => m.customType === AUTO_CONTINUE)).toBe(false);
  });
});

describe("step 7: a large branch with nothing omitted is a no-op passthrough", () => {
  test("returns undefined and never rewrites the payload", () => {
    const pi: any = { on: (n: string, h: any) => { pi[n] = h; }, sendMessage(){}, sendUserMessage(){} };
    registerBeforeCompactHook(pi);
    const msgs = Array.from({ length: 500 }, (_, i) => ({
      id: `m${i}`,
      type: "message",
      message: { role: "user", content: `entry ${i}`.repeat(10) },
    }));
    const entries: any[] = [
      ...msgs,
      {
        id: "c1",
        type: "compaction",
        summary: "s",
        details: {
          compactor: "omp-vcc",
          version: 2,
          sections: [],
          sourceMessageCount: 0,
          previousSummaryUsed: false,
          retainedToolOutputProjection: { version: 1, retainedTokens: 0, omittedTokens: 0, pendingCount: 0, omissions: [] },
        },
      },
    ];
    const ctx: any = { sessionManager: { getEntries: () => entries, getBranch: () => entries }, ui: { notify(){} } };

    // The observable contract: with nothing to filter and no omissions to
    // re-apply, the handler is a PURE passthrough (undefined), so the provider
    // payload is the host's own array, unrewritten. This replaces a test that
    // counted JSON.stringify calls through a patched GLOBAL: that pinned an
    // implementation strategy rather than behaviour.
    const payload = { messages: [{ role: "user", content: "x" }] };
    expect(pi["context"](payload, ctx)).toBeUndefined();
  });
});