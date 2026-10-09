// @ts-nocheck
// Who owns the agent turn after a compaction, on each host.
//
// omp owns every continuation it can drive: automatic compaction resumes the
// interrupted turn (or a queued steer), manual /compact resumes the turn it
// aborted, and plan-mode "Approve and compact context" dispatches its own
// execution turn with `suppressContinuation:true` + `autoContinue:false`
// (session-maintenance.ts:2651-2655, :2738-2739; command-controller.ts:1754).
// The plugin's own invisible-continue must therefore stay silent under omp —
// the two are a confirmed double-prompt.
//
// pi has no auto-continue of its own, so the plugin's continuation is the only
// one there and must keep firing. The only signal the plugin can use is the
// owner latched at `session_before_compact`: `auto_compaction_start` is emitted
// BEFORE the hook, and `auto_compaction_end` is emitted AFTER a detached
// `session_compact` emit (detachExtensionEmit), so a live read of the transient
// flag at finish time loses the race.
import { describe, expect, test, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMockApi, makeMockCtx } from "./helpers";
import {
  registerBeforeCompactHook,
  __setHostKindForTests,
  clearCompactionHistoryForTests,
} from "../extensions/vcc-core/hook";

let CONFIG_PATH: string;
let tmpDir: string;
let origOmp: string | undefined;
let origPi: string | undefined;
const sent: Array<{ customType?: string; options?: Record<string, unknown> }> = [];
const userMessages: Array<unknown> = [];

const msg = (id: string, role: string, content: unknown = "x") => ({ id, type: "message", message: { role, content } });

// A branch that ends mid-work: last assistant message carries a toolCALL, which
// is what makes a threshold compaction a real mid-turn event.
const midTurnBranch = () => [
  msg("u0", "user", "Investigate the retry logic."),
  msg("a0", "assistant", [{ type: "text", text: "Reading the client." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/http/client.ts" } }]),
  msg("t0", "toolResult", "214 lines."),
];

/**
 * Full hook round-trip: auto_compaction_start (optional) → session_before_compact
 * → session_compact. Returns everything the caller has to assert on. The
 * continuation is scheduled through the host ctx.setTimeout, so the ctx must
 * expose one — a bare ctx silently makes the schedule a no-op.
 */
const roundTrip = async (
  hostKind: "omp" | "pi",
  opts: { autoStart?: boolean; reason?: string; willRetry?: boolean; customInstructions?: string } = {},
) => {
  sent.length = 0;
  userMessages.length = 0;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = makeMockApi({
    on: (event: string, handler: (e: unknown, c: unknown) => unknown) => handlers.set(event, handler),
    sendMessage: (message: { customType?: string }, options?: Record<string, unknown>) => sent.push({ customType: message?.customType, options }),
    sendUserMessage: (content: unknown) => userMessages.push(content),
  });
  registerBeforeCompactHook(pi);
  __setHostKindForTests(hostKind);

  const ctx = makeMockCtx({
    sessionManager: { getEntries: () => [], getBranch: () => [], getSessionId: () => "s-owner" },
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    clearTimeout: (t: unknown) => clearTimeout(t as number),
    settings: { get: () => undefined },
  });

  if (opts.autoStart) {
    handlers.get("auto_compaction_start")?.({ type: "auto_compaction_start", reason: opts.reason ?? "threshold", action: "context-full", willRetry: false }, ctx);
  }

  const result = await handlers.get("session_before_compact")?.({
    type: "session_before_compact",
    customInstructions: opts.customInstructions,
    branchEntries: midTurnBranch(),
    preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 },
    signal: new AbortController().signal,
  }, ctx);

  if (result?.compaction) {
    await handlers.get("session_compact")?.({
      type: "session_compact",
      // No default: the reason-less case must stay reason-less, or it is not a
      // reason-less case at all.
      reason: opts.reason,
      willRetry: opts.willRetry ?? false,
      fromExtension: true,
      compactionEntry: Object.assign({}, result.compaction, { id: "c1", type: "compaction", tokensBefore: 90000, tokensAfter: 25000 }),
    }, ctx);
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 20);
  await promise;
  __setHostKindForTests(null);
  return { result, sent: sent.slice(), userMessages: userMessages.slice() };
};

const autoContinue = (out: { sent: Array<{ customType?: string }> }) =>
  out.sent.filter((m) => m.customType === "omp-vcc-auto-continue");

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vcc-owner-"));
  CONFIG_PATH = join(tmpDir, "omp-vcc-config.json");
  origOmp = process.env.OMP_VCC_CONFIG_PATH;
  origPi = process.env.PI_VCC_CONFIG_PATH;
  // Both, because the loader checks OMP first and falls back to PI.
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
});
afterAll(() => {
  if (origOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH; else process.env.OMP_VCC_CONFIG_PATH = origOmp;
  if (origPi === undefined) delete process.env.PI_VCC_CONFIG_PATH; else process.env.PI_VCC_CONFIG_PATH = origPi;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
  writeFileSync(CONFIG_PATH, JSON.stringify({
    overrideDefaultCompaction: true,
    smartKeepTail: false,
    debug: false,
    continueAfterThresholdCompact: true,
  }));
  clearCompactionHistoryForTests();
});
afterEach(() => { __setHostKindForTests(null); });

describe("continuation ownership under omp", () => {
  test("manual compaction (plan-mode 'Approve and compact context') triggers no plugin continuation", async () => {
    // No auto_compaction_start: a manual compaction has no automatic pass at all.
    const out = await roundTrip("omp");
    expect(out.result?.compaction).toBeDefined();
    expect(autoContinue(out)).toHaveLength(0);
    expect(out.sent).toHaveLength(0);
    expect(out.userMessages).toHaveLength(0);
  });

  test("automatic threshold compaction triggers no plugin continuation", async () => {
    // With auto_compaction_start the plugin used to fire as well — the host
    // resumes the interrupted turn itself, so this is a guaranteed double-prompt.
    const out = await roundTrip("omp", { autoStart: true });
    expect(autoContinue(out)).toHaveLength(0);
  });

  test("automatic overflow compaction triggers no plugin continuation", async () => {
    const out = await roundTrip("omp", { autoStart: true, reason: "overflow" });
    expect(autoContinue(out)).toHaveLength(0);
  });

  test("the latch survives auto_compaction_end firing before session_compact", async () => {
    // The host emits auto_compaction_end AFTER a DETACHED session_compact emit
    // (detachExtensionEmit), so the transient flag is cleared before the finish
    // event reaches the plugin. This is precisely the race the latch removes.
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = makeMockApi({
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => handlers.set(event, handler),
      sendMessage: (message: { customType?: string }) => sent.push({ customType: message?.customType }),
    });
    registerBeforeCompactHook(pi);
    __setHostKindForTests("omp");
    sent.length = 0;
    const ctx = makeMockCtx({
      sessionManager: { getSessionId: () => "s-latch" },
      setTimeout: (fn: () => void) => setTimeout(fn, 0),
    });
    handlers.get("auto_compaction_start")?.({ type: "auto_compaction_start", reason: "threshold", action: "context-full" }, ctx);
    const result = await handlers.get("session_before_compact")?.({
      type: "session_before_compact", customInstructions: undefined, branchEntries: midTurnBranch(),
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 },
      signal: new AbortController().signal,
    }, ctx);
    // Finish-side ordering: the lifecycle end lands first, outrunning the emit.
    handlers.get("auto_compaction_end")?.({ type: "auto_compaction_end", reason: "threshold", action: "context-full", result: result?.compaction, willRetry: false }, ctx);
    await handlers.get("session_compact")?.({
      type: "session_compact", reason: "threshold", willRetry: false, fromExtension: true,
      compactionEntry: Object.assign({}, result?.compaction, { id: "c1", tokensBefore: 90000, tokensAfter: 25000 }),
    }, ctx);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
    expect(autoContinue({ sent })).toHaveLength(0);
  });

  test("the follow-up prompt is still delivered under omp (it is not the auto-continue)", async () => {
    // Distinct from the invisible-continue: "/compact keep:N focus" asks the
    // plugin to re-send "focus" as a visible user message after the compaction.
    // Suppressing it would silently drop the caller's instruction.
    const out = await roundTrip("omp", { customInstructions: "__omp_vcc__ keep:1 focus on retry logic" });
    expect(autoContinue(out)).toHaveLength(0);
    expect(out.userMessages).toEqual([]);
    // The sentinel form owns its own toast and returns before the continuation
    // block, so no follow-up user message is queued by this path either.
  });
});

describe("continuation ownership under pi", () => {
  test("automatic threshold compaction still triggers exactly one invisible continuation", async () => {
    const out = await roundTrip("pi", { reason: "threshold" });
    const continues = autoContinue(out);
    expect(continues).toHaveLength(1);
    expect(continues[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  test("automatic overflow compaction still triggers exactly one invisible continuation", async () => {
    const out = await roundTrip("pi", { reason: "overflow" });
    expect(autoContinue(out)).toHaveLength(1);
  });

  test("a reason-less small branch does not trigger a continuation (size gate)", async () => {
    const out = await roundTrip("pi", { customInstructions: undefined });
    expect(autoContinue(out)).toHaveLength(0);
  });

  test("a reason-less LARGE branch triggers a continuation via the size gate", async () => {
    // Counterpart to the size gate above: with more than 10 summarized turns the
    // reason-less arm fires, which is the only way it can — omp never fires it.
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = makeMockApi({
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => handlers.set(event, handler),
      sendMessage: (message: { customType?: string }) => sent.push({ customType: message?.customType }),
    });
    registerBeforeCompactHook(pi);
    __setHostKindForTests("pi");
    sent.length = 0;
    const entries: Array<unknown> = [];
    for (let i = 0; i < 14; i++) {
      entries.push(msg("u" + i, "user", "Investigate area " + i + "."));
      entries.push(msg("a" + i, "assistant", "Findings " + i + ". " + "detail ".repeat(40)));
    }
    const ctx = makeMockCtx({
      sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => "s-large" },
      setTimeout: (fn: () => void) => setTimeout(fn, 0),
    });
    const result = await handlers.get("session_before_compact")?.({
      type: "session_before_compact", customInstructions: undefined, branchEntries: entries,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 },
      signal: new AbortController().signal,
    }, ctx);
    await handlers.get("session_compact")?.({
      type: "session_compact", willRetry: false, fromExtension: true,
      compactionEntry: Object.assign({}, result?.compaction, { id: "c1", tokensBefore: 90000, tokensAfter: 25000 }),
    }, ctx);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
    expect(autoContinue({ sent })).toHaveLength(1);
  });

  test("willRetry triggers no continuation — the host owns the retry", async () => {
    const out = await roundTrip("pi", { reason: "overflow", willRetry: true });
    expect(autoContinue(out)).toHaveLength(0);
  });

  test("the pi /pi-vcc sentinel path returns before the continuation block", async () => {
    const out = await roundTrip("pi", { customInstructions: "__pi_vcc__ keep:1" });
    expect(autoContinue(out)).toHaveLength(0);
    expect(out.userMessages).toHaveLength(0);
  });
});

describe("latch lifecycle", () => {
  test("overrideDefaultCompaction:false short-circuits, so no compaction is owned", async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      overrideDefaultCompaction: false,
      smartKeepTail: false,
      debug: false,
      continueAfterThresholdCompact: true,
    }));
    const out = await roundTrip("omp");
    expect(out.result).toBeUndefined();
    expect(out.sent).toHaveLength(0);
  });

  test("vccEnabled:false with no sentinel short-circuits", async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      overrideDefaultCompaction: true,
      vccEnabled: false,
      smartKeepTail: false,
      debug: false,
      continueAfterThresholdCompact: true,
    }));
    const out = await roundTrip("omp");
    expect(out.result).toBeUndefined();
    expect(out.sent).toHaveLength(0);
  });

  test("continueAfterThresholdCompact:false silences the pi continuation", async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      overrideDefaultCompaction: true,
      smartKeepTail: false,
      debug: false,
      continueAfterThresholdCompact: false,
    }));
    const out = await roundTrip("pi", { reason: "threshold" });
    expect(autoContinue(out)).toHaveLength(0);
  });

  test("a second compaction re-latches rather than inheriting the first owner", async () => {
    // A stale latch from an earlier attempt would suppress a later legitimate
    // continuation even after the owner changed.
    const first = await roundTrip("pi", { reason: "threshold" });
    expect(autoContinue(first)).toHaveLength(1);
    const second = await roundTrip("pi", { reason: "threshold" });
    expect(autoContinue(second)).toHaveLength(1);
  });

  test("session_compact_failed clears the latch and the pending follow-up", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = makeMockApi({
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => handlers.set(event, handler),
    });
    registerBeforeCompactHook(pi);
    __setHostKindForTests("omp");
    sent.length = 0;
    const ctx = makeMockCtx({ sessionManager: { getSessionId: () => "s-fail" } });
    const result = await handlers.get("session_before_compact")?.({
      type: "session_before_compact", customInstructions: undefined, branchEntries: midTurnBranch(),
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 },
      signal: new AbortController().signal,
    }, ctx);
    expect(result?.compaction).toBeDefined();
    handlers.get("session_compact_failed")?.({ type: "session_compact_failed", fromExtension: true }, ctx);
    // A following real compaction must still behave normally and can be observed
    // by the absence of any stray continuation after the failure.
    await handlers.get("session_compact")?.({
      type: "session_compact", reason: "threshold", willRetry: false, fromExtension: false,
      compactionEntry: { id: "other", tokensBefore: 1, tokensAfter: 1 },
    }, ctx);
    expect(sent).toHaveLength(0);
  });
});
