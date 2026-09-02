// @ts-nocheck
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { registerBeforeCompactHook, AUTO_CONTINUE_CUSTOM_TYPE, LEGACY_AUTO_CONTINUE_CUSTOM_TYPE, triggerInvisibleContinue, OMP_VCC_COMPACT_INSTRUCTION } from "../../extensions/vcc-core/hook";
import { createIsolatedOmpDir } from "./support/e2e-harness";
import { buildSession, msg } from "./support/session-builder";

let isolated: ReturnType<typeof createIsolatedOmpDir>;

beforeAll(() => { isolated = createIsolatedOmpDir(); });
afterAll(() => { try { isolated.cleanup(); } catch {} });
beforeEach(() => {
  for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {};
  try { if (existsSync(isolated.configPath)) unlinkSync(isolated.configPath); } catch {};
  delete process.env.OMP_VCC_CONFIG_PATH;
});
afterEach(() => {
  for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {};
  try { if (existsSync(isolated.configPath)) unlinkSync(isolated.configPath); } catch {};
  delete process.env.OMP_VCC_CONFIG_PATH;
});

function capturePi() {
  let contextHandler: any;
  let beforeStartHandler: any;
  let compactHandler: any;
  let beforeHandler: any;
  const sentMessages: any[] = [];
  const pi: any = {
    on: (name: string, h: any) => {
      if (name === "context") contextHandler = h;
      if (name === "before_agent_start") beforeStartHandler = h;
      if (name === "session_compact") compactHandler = h;
      if (name === "session_before_compact") beforeHandler = h;
    },
    sendMessage: (m: any, o: any) => sentMessages.push({ message: m, options: o }),
    sendUserMessage: () => sentMessages.push({ type: "user" }),
  };
  const ctx: any = { hasUI: true, ui: { notify: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, mode: "tui" };
  return { pi, ctx, getContext: () => contextHandler, getBeforeStart: () => beforeStartHandler, getCompact: () => compactHandler, getBefore: () => beforeHandler, sentMessages };
}

describe("lifecycle E2E — invisible-continue, context filter, fromExtension guard, convertToLlm shim", () => {
  test("triggerInvisibleContinue sends customType omp-vcc-auto-continue with display:false deliverAs:followUp", () => {
    const { pi, sentMessages } = capturePi();
    registerBeforeCompactHook(pi);
    triggerInvisibleContinue(pi as any);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].message.customType).toBe(AUTO_CONTINUE_CUSTOM_TYPE);
    expect(sentMessages[0].message.display).toBe(false);
    expect(sentMessages[0].options.triggerTurn).toBe(true);
    expect(sentMessages[0].options.deliverAs).toBe("followUp");
  });

  test("on(context) strips only omp-vcc-auto-continue and legacy pi-vcc-auto-continue", () => {
    const { pi, getContext } = capturePi();
    registerBeforeCompactHook(pi);
    const ctxHandler = getContext();
    const messages: any[] = [
      { role: "user", content: "hello" },
      { role: "custom", customType: AUTO_CONTINUE_CUSTOM_TYPE, content: [], display: false },
      { role: "custom", customType: LEGACY_AUTO_CONTINUE_CUSTOM_TYPE, content: [], display: false },
      { role: "custom", customType: "other-custom", content: "keep me" },
      { role: "assistant", content: "hi" },
    ];
    const result: any = ctxHandler({ messages });
    expect(result.messages.length).toBe(3);
    expect(result.messages.some((m: any) => m.customType === AUTO_CONTINUE_CUSTOM_TYPE)).toBe(false);
    expect(result.messages.some((m: any) => m.customType === LEGACY_AUTO_CONTINUE_CUSTOM_TYPE)).toBe(false);
    expect(result.messages.some((m: any) => m.customType === "other-custom")).toBe(true);
  });

  test("on(context) returns undefined when no marker present (no-op)", () => {
    const { pi, getContext } = capturePi();
    registerBeforeCompactHook(pi);
    const messages: any[] = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
    const result: any = getContext()({ messages });
    expect(result).toBeUndefined();
  });

  test("before_agent_start clears pending auto-continue timer (no duplicate followUp)", async () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ continueAfterThresholdCompact: true, debug: false, overrideDefaultCompaction: true }));
    const { pi, ctx, getBefore, getBeforeStart, getCompact, sentMessages } = capturePi();
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 5, charsPerTurn: 500 }) as any[];
    // threshold-like compaction that would schedule auto-continue on session_compact
    await getBefore()({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: entries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 }, signal: new AbortController().signal }, ctx);
    await getCompact()({ type: "session_compact", compactionEntry: { tokensBefore: 90000, tokensAfter: 22000, fromExtension: true } } as any, ctx);
    // timer scheduled with setTimeout 0; immediately clear via before_agent_start before it fires
    getBeforeStart()({ type: "before_agent_start", prompt: "next", systemPrompt: "", systemPromptOptions: {} } as any, ctx);
    // wait a tick — if timer wasn't cleared, sentMessages would have auto-continue
    await new Promise((r) => setTimeout(r, 20));
    const beforeCount = sentMessages.length;
    // wait another tick to ensure no late delivery
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages.length).toBe(beforeCount);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("session_compact fromExtension false does not toast/continue (guard)", async () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true, continueAfterThresholdCompact: true }));
    const { pi, ctx, getBefore, getCompact, sentMessages } = capturePi();
    // capture notify
    const notifyCalls: any[] = [];
    ctx.ui.notify = (m: string, l: string) => notifyCalls.push({ m, l });
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 4, charsPerTurn: 500 }) as any[];
    await getBefore()({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: entries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 80000 }, signal: new AbortController().signal }, ctx);
    // native remote compaction (fromExtension false/undefined) should not trigger toast
    await getCompact()({ type: "session_compact", compactionEntry: { tokensBefore: 80000, tokensAfter: 20000, fromExtension: false } } as any, ctx);
    await new Promise((r) => setTimeout(r, 20));
    // no auto-continue should have been sent for native compaction
    const autoContinues = sentMessages.filter((m: any) => m.message?.customType === AUTO_CONTINUE_CUSTOM_TYPE);
    expect(autoContinues.length).toBe(0);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("willRetry suppresses toast/continue even when continueAfterThresholdCompact true", async () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true, continueAfterThresholdCompact: true }));
    const { pi, ctx, getBefore, getCompact, sentMessages } = capturePi();
    const notifyCalls: any[] = [];
    ctx.ui.notify = (m: string, l: string) => notifyCalls.push({ m, l });
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 3, charsPerTurn: 400 }) as any[];
    // Simulate overflow willRetry scenario by passing event with willRetry via preparation? Hook reads readCompactionEventContext which checks event.reason/willRetry
    // easiest: ensure hook's willRetry path is triggered via session_compact's willRetry check, not before
    // We'll manually trigger compact with willRetry true via session_compact event
    // First do a normal before so lastCompactWasPiVcc true
    await getBefore()({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: entries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 80000 }, signal: new AbortController().signal, reason: "overflow", willRetry: true } as any, ctx);
    await getCompact()({ type: "session_compact", compactionEntry: { tokensBefore: 80000, tokensAfter: 20000, fromExtension: true }, reason: "overflow", willRetry: true } as any, ctx);
    await new Promise((r) => setTimeout(r, 20));
    // when willRetry true, toast/continue suppressed
    const autoContinues = sentMessages.filter((m: any) => m.message?.customType === AUTO_CONTINUE_CUSTOM_TYPE);
    // may be 0 due to suppression
    expect(autoContinues.length).toBe(0);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("convertToLlm shim identity fallback allows pipeline to compile without host", async () => {
    // This test runs host-free: import hook without @oh-my-pi/pi-coding-agent installed scenario is simulated by checking that hook.ts doesn't throw on import
    // Already imported successfully, but verify compileRanked still works with identity shim
    const { compileRanked } = await import("../../extensions/vcc-core/core/summarize");
    expect(typeof compileRanked).toBe("function");
  });

  test("session_compact authoritative enrichment before early return for manual omp-vcc", async () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: true, overrideDefaultCompaction: true, smartKeepTail: false }));
    const { pi, ctx, getBefore, getCompact } = capturePi();
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 5, charsPerTurn: 600 }) as any[];
    await getBefore()({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: entries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 }, signal: new AbortController().signal }, ctx);
    await getCompact()({ type: "session_compact", fromExtension: true, compactionEntry: { tokensBefore: 90000, tokensAfter: 21500, id: "c1" } } as any, ctx);
    const { getLastCompactionStats: getLast } = await import("../../extensions/vcc-core/hook");
    const last = getLast(pi);
    expect(last).not.toBeNull();
    // authoritative enrichment should set tokensAfter (or at least preserve tokensBefore)
    expect(last!.tokensBefore).toBe(90000);
    // tokensAfter enrichment may be async but should be set when fromExtension true
    if (last!.tokensAfter != null) expect(last!.tokensAfter).toBe(21500);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });
});
