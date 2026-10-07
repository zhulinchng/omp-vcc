// @ts-nocheck
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  OMP_VCC_COMPACT_INSTRUCTION,
  PI_VCC_COMPACT_INSTRUCTION,
  getLastCompactionStats,
  clearCompactionHistoryForTests,
  getCompactionHistory,
  buildOwnCut,
  applyTailBudget,
  findBudgetCutIndex,
  OVERSIZED_TAIL_FACTOR,
  __setHostKindForTests,
} from "../extensions/vcc-core/hook";
import { calibrateCharsPerToken } from "../extensions/vcc-core/core/token-estimate";
import { loadSettings, DEFAULT_SETTINGS } from "../extensions/vcc-core/core/settings";

let tmpDir: string;
let CONFIG_PATH: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omp-vcc-combined-"));
  CONFIG_PATH = join(tmpDir, "config.json");
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  try { delete process.env.OMP_VCC_CONFIG_PATH; } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {}
  clearCompactionHistoryForTests();
});

function setConfig(cfg: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

function createMockPi() {
  let beforeHandler: any;
  let compactHandler: any;
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const ctxBase = {
    hasUI: true,
    ui: { notify: (m: string, l: string) => notifyCalls.push({ msg: m, level: l }) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    mode: "tui",
  };
  const pi: any = {
    on: (eventName: string, h: any) => {
      if (eventName === "session_before_compact") beforeHandler = h;
      if (eventName === "session_compact") compactHandler = h;
    },
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  return {
    pi,
    invokeBefore: (event: any, ctxOverride?: any) => beforeHandler(event, ctxOverride ?? ctxBase),
    invokeCompact: (event: any, ctxOverride?: any) => compactHandler(event, ctxOverride ?? ctxBase),
    notifyCalls,
    ctxBase,
  };
}

function makeEvent(branchEntries: any[], customInstructions?: string, eventContext: Record<string, unknown> = {}, tokensBefore = 90000): any {
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: [], edited: [] },
      tokensBefore,
    },
    signal: new AbortController().signal,
    ...eventContext,
  };
}

const msg = (id: string, role: string, content = "x") => ({ id, type: "message", message: { role, content } });
const comp = (id: string, firstKeptEntryId?: string) => ({ id, type: "compaction", firstKeptEntryId });
const resetBoundary = (id: string) => ({ id, type: "reset_boundary", timestamp: "2026-01-01T00:00:00.000Z" });

function buildSession(turns: number, charsPerTurn = 500): any[] {
  const entries: any[] = [];
  for (let i = 0; i < turns; i++) {
    const uid = `u${i}`;
    const aid = `a${i}`;
    entries.push(msg(uid, "user", "user prompt ".repeat(Math.ceil(charsPerTurn / 12))));
    entries.push(msg(aid, "assistant", "assistant response ".repeat(Math.ceil(charsPerTurn / 18))));
  }
  // add a final user turn to make cut at last user valid
  return entries;
}

describe("combined-compaction: explicit-mode bypass (hook.ts:733-743)", () => {
  beforeEach(() => {
    for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {}
    clearCompactionHistoryForTests();
  });

  test("override:true with explicit snapcompact mode bypasses VCC (returns void)", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession(5);
    const event = makeEvent(entries, undefined, { compactMode: "snapcompact" }, 90000);
    const result = await invokeBefore(event);
    expect(result).toBeUndefined();
  });

  test("override:true with explicit shake mode bypasses VCC", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession(5);
    const event = makeEvent(entries, undefined, { explicitMode: "shake" }, 90000);
    expect(await invokeBefore(event)).toBeUndefined();
  });

  test("override:true with explicit soft/remote/handoff also bypasses", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    for (const mode of ["soft", "remote", "handoff"]) {
      const { pi, invokeBefore } = createMockPi();
      registerBeforeCompactHook(pi);
      const entries = buildSession(5);
      const event = makeEvent(entries, undefined, { mode }, 90000);
      const result = await invokeBefore(event);
      expect(result).toBeUndefined();
    }
  });

  test("explicit mode does NOT bypass when sentinel present (VCC wins)", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession(5);
    // sentinel + explicitMode snapcompact — sentinel should win (VCC handles)
    const event = makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, { compactMode: "snapcompact" }, 90000);
    const result = await invokeBefore(event);
    expect(result).toBeDefined();
    expect(result.compaction).toBeDefined();
  });

  test("override:true without explicitMode still handles threshold proxy (no sentinel)", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession(5);
    const event = makeEvent(entries, undefined, {}, 90000);
    const result = await invokeBefore(event);
    expect(result).toBeDefined();
    expect(result.compaction).toBeDefined();
  });

  test("case-insensitive explicitMode bypass (SnapCompact)", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession(5);
    const event = makeEvent(entries, undefined, { compactMode: "SnapCompact" }, 90000);
    expect(await invokeBefore(event)).toBeUndefined();
  });
});

describe("combined-compaction: override gate and sequential fallback", () => {
  beforeEach(() => {
    clearCompactionHistoryForTests();
  });

  test("override:false defers threshold proxy to host (void)", async () => {
    setConfig({ overrideDefaultCompaction: false, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession(5);
    const event = makeEvent(entries, undefined, {}, 90000);
    expect(await invokeBefore(event)).toBeUndefined();
  });

  test("override:false still handles sentinel (sequential VCC -> host)", async () => {
    setConfig({ overrideDefaultCompaction: false, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession(5);
    const event = makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, {}, 90000);
    const result = await invokeBefore(event);
    expect(result?.compaction).toBeDefined();
  });

  test("vccEnabled:false blocks even sentinel unless explicit? — actually blocks all when false", async () => {
    setConfig({ vccEnabled: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession(5);
    const sentinelEvent = makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, {}, 90000);
    expect(await invokeBefore(sentinelEvent)).toBeUndefined();
    const thresholdEvent = makeEvent(entries, undefined, {}, 90000);
    expect(await invokeBefore(thresholdEvent)).toBeUndefined();
  });

  test("sentinel alias __pi_vcc__ also handled when override:false", async () => {
    setConfig({ overrideDefaultCompaction: false, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession(5);
    const event = makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION, {}, 90000);
    expect((await invokeBefore(event))?.compaction).toBeDefined();
  });

  test("after VCC, sequential snapcompact on new slice: second compaction succeeds", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries1 = buildSession(5);
    const r1: any = await invokeBefore(makeEvent(entries1, OMP_VCC_COMPACT_INSTRUCTION, {}, 90000));
    expect(r1.compaction).toBeDefined();
    const firstKept = r1.compaction.firstKeptEntryId as string;
    // simulate history: entries1 + compaction entry + 10 more turns
    const entries2: any[] = [...entries1, comp("c1", firstKept)];
    for (let i = 0; i < 10; i++) {
      entries2.push(msg(`u2_${i}`, "user", "follow-up ".repeat(20)));
      entries2.push(msg(`a2_${i}`, "assistant", "reply ".repeat(20)));
    }
    // second VCC would also handle, but we test that cut is still valid (not Nothing to compact)
    const r2: any = await invokeBefore(makeEvent(entries2, OMP_VCC_COMPACT_INSTRUCTION, {}, 90000));
    expect(r2.compaction).toBeDefined();
    expect(r2.compaction.firstKeptEntryId).not.toBe(firstKept);
  });
});

describe("combined-compaction: edge cases preserved", () => {
  beforeEach(() => clearCompactionHistoryForTests());

  test("empty branch -> cancel no_live_messages (or fallbackToCore heuristic)", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
    const result: any = await invokeBefore(makeEvent([], undefined, {}, 1000));
    // when tokensBefore small (1000 < 50k) and no sentinel, hook cancels with {cancel:true}
    expect(result?.cancel).toBe(true);
    expect(notifyCalls.some((c) => /few|live/i.test(c.msg))).toBe(true);
  });

  test("too_few_live_messages (≤2) cancels", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("u0", "user", "hi"), msg("a0", "assistant", "hello")];
    const result: any = await invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, {}, 1000));
    // Even with sentinel, too_few should cancel (unless fallbackToCore overflow)
    expect(result?.cancel).toBe(true);
  });

  test("autonomous no user message -> compactAll sentinel", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true, smartKeepTail: false });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("a0", "assistant", "thinking"), msg("t0", "toolResult", "output")];
    // buildOwnCut for autonomous will compactAll when keep:0 sentinel? For normal keep:1 but no user, buildOwnCut returns ok with firstKeptEntryId=""? Test via hook: it should return compaction with kept 0? Let's assert at least not throw
    const result: any = await invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION + " keep:0", {}, 1000));
    // keep:0 autonomous => compactAll path should succeed
    if (result?.compaction) {
      expect(result.compaction.firstKeptEntryId).toBe("");
    } else {
      // or cancel if too_few, both are valid handling
      expect(result?.cancel).toBe(true);
    }
  });

  test("reset_boundary supersedes prior compaction", () => {
    const base = buildSession(3);
    const entries = [...base, comp("c1", "u0"), resetBoundary("r1"), msg("u10", "user", "after reset"), msg("a10", "assistant", "after"), msg("u11", "user", "more"), msg("a11", "assistant", "more2"), msg("u12", "user", "even more"), msg("a12", "assistant", "even more2")];
    const cut = buildOwnCut(entries as any, 1);
    expect(cut.ok).toBe(true);
    if (cut.ok) expect(cut.firstKeptEntryId).toBe("u12");
  });

  test("toolResult boundary snap: findBudgetCutIndex never lands on toolResult", () => {
    const live: any[] = [
      { id: "u0", type: "message", message: { role: "user", content: "hi" } },
      { id: "a0", type: "message", message: { role: "assistant", content: "ok" } },
      { id: "t0", type: "message", message: { role: "toolResult", content: "x".repeat(5000) } },
      { id: "u1", type: "message", message: { role: "user", content: "next" } },
      { id: "t1", type: "message", message: { role: "toolResult", content: "y".repeat(5000) } },
    ];
    const idx = findBudgetCutIndex(live as any, 1000, 4);
    if (idx >= 0) {
      expect(live[idx].message.role).not.toBe("toolResult");
    }
  });

  test("keep:0 sentinel orphan recovery on next compaction", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries1 = buildSession(5);
    const r1: any = await invokeBefore(makeEvent(entries1, OMP_VCC_COMPACT_INSTRUCTION + " keep:0", {}, 90000));
    expect(r1.compaction.firstKeptEntryId).toBe("");
    const entries2: any[] = [...entries1, comp("c1", ""), msg("uX", "user", "new after compactAll"), msg("aX", "assistant", "reply"), msg("uY", "user", "another"), msg("aY", "assistant", "another reply")];
    // next compaction should not be too_few due to orphan "" recovery — should produce compaction
    const r2: any = await invokeBefore(makeEvent(entries2, OMP_VCC_COMPACT_INSTRUCTION, {}, 90000));
    expect(r2.compaction).toBeDefined();
  });

  test("applyTailBudget rescues only past maxTokens x OVERSIZED_TAIL_FACTOR", () => {
    // The tail is [small last user turn, giant assistant reply]. That is the
    // ONLY shape where the rescue is reachable: with a single giant tail
    // message `findBudgetCutIndex` crosses exactly AT the user boundary, and
    // `idx <= tailStart` returns the cut unchanged.
    const base = buildSession(5);
    const head = base.slice(0, -2);
    const tailWith = (chars: number) => [
      ...head,
      msg("u_last", "user", "prompt"),
      msg("a_last", "assistant", "x".repeat(chars)),
    ];

    const MAX_TOKENS = 10_000;
    const CPT = 4;
    // Derived, not pinned: retuning the factor must move this boundary.
    const boundaryChars = Math.floor(MAX_TOKENS * OVERSIZED_TAIL_FACTOR * CPT);

    const under: any[] = tailWith(boundaryChars - 1000);
    const underCut = buildOwnCut(under as any, 1);
    expect(underCut.ok).toBe(true);
    if (underCut.ok) {
      const res = applyTailBudget(under as any, underCut, { maxTokens: MAX_TOKENS });
      expect(res.ok).toBe(true);
      expect(res.budgetCut).toBeUndefined();
      expect(res.firstKeptEntryId).toBe("u_last");
      expect(res.keptUserTurns).toBe(1);
    }

    const over: any[] = tailWith(boundaryChars + 4);
    const overCut = buildOwnCut(over as any, 1);
    expect(overCut.ok).toBe(true);
    if (overCut.ok) {
      const res = applyTailBudget(over as any, overCut, { maxTokens: MAX_TOKENS });
      expect(res.ok).toBe(true);
      expect(res.budgetCut).toBe("oversized_tail");
      // The rescue re-cuts to the token budget, so the giant reply is
      // summarized away rather than kept.
      expect(res.firstKeptEntryId).toBe("a_last");
      expect(res.keptUserTurns).toBe(0);
      expect(res.compactAll).toBe(false);
    }
  });

  test("calibrate fallback 4 and clamp 2-6", () => {
    expect(calibrateCharsPerToken(0, 0).charsPerToken).toBe(4);
    expect(calibrateCharsPerToken(1000, 1).charsPerToken).toBeLessThanOrEqual(6);
    expect(calibrateCharsPerToken(1, 1000).charsPerToken).toBeGreaterThanOrEqual(2);
    expect(calibrateCharsPerToken(4000, 1000).charsPerToken).toBe(4);
  });

  test("negative and undefined tokensBefore handled", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession(5);
    const ev1 = makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, {}, -100);
    const r1: any = await invokeBefore(ev1);
    expect(r1.compaction).toBeDefined();
    const ev2 = makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, {}, undefined as any);
    const r2: any = await invokeBefore(ev2);
    expect(r2.compaction).toBeDefined();
  });
});

describe("combined-compaction: no eager post-VCC compaction", () => {
  beforeEach(() => clearCompactionHistoryForTests());

  test("session_compact never calls ctx.compact after a VCC compaction", async () => {
    // The host exposes no shake mode (COMPACT_MODES = soft|remote|snapcompact),
    // so an eager ctx.compact({mode:"shake"}) would silently run the configured
    // methodOrder (a second, possibly billed, native compaction). The hook must
    // not call compact at all; tail elision comes from
    // retainedToolOutputMaxTokens plus the host's own dead-end rescue.
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true, continueAfterThresholdCompact: false });
    const pi: any = { on: (n: string, h: any) => { (pi as any)[n] = h; }, sendMessage: () => {}, sendUserMessage: () => {} };
    registerBeforeCompactHook(pi);
    const beforeHandler = (pi as any)["session_before_compact"];
    const compactHandler = (pi as any)["session_compact"];
    const seeded: any = await beforeHandler(makeEvent(buildSession(6), undefined, {}, 90000), {
      settings: { get: () => undefined }, config: { get: () => undefined }, ui: { notify: () => {} },
    });
    expect(seeded.compaction).toBeDefined();
    let compactCalls = 0;
    const ctx: any = {
      settings: { get: () => undefined },
      config: { get: () => undefined },
      ui: { notify: () => {} },
      getSystemPrompt: () => ["prompt"],
      compact: () => { compactCalls++; return Promise.resolve(); },
    };
    await compactHandler({ fromExtension: true, compactionEntry: { id: "c1", tokensBefore: 90000, tokensAfter: 21000 } }, ctx);
    await compactHandler({ fromExtension: true, compactionEntry: { id: "c2", tokensBefore: 90000, tokensAfter: 21000 } }, ctx);
    await new Promise((r) => setTimeout(r, 30));
    expect(compactCalls).toBe(0);
  });

  test("a modeless compaction is still handled by VCC (no in-flight-chain yield)", async () => {
    setConfig({ overrideDefaultCompaction: true, vccEnabled: true, continueAfterThresholdCompact: false });
    const pi: any = { on: (n: string, h: any) => { (pi as any)[n] = h; }, sendMessage: () => {}, sendUserMessage: () => {} };
    registerBeforeCompactHook(pi);
    const beforeHandler = (pi as any)["session_before_compact"];
    const compactHandler = (pi as any)["session_compact"];
    const plainCtx: any = { settings: { get: () => undefined }, config: { get: () => undefined }, ui: { notify: () => {} } };
    const seeded: any = await beforeHandler(makeEvent(buildSession(6), undefined, {}, 90000), plainCtx);
    expect(seeded?.compaction).toBeDefined();
    await compactHandler({ fromExtension: true, compactionEntry: { id: "c1", tokensBefore: 90000, tokensAfter: 21000 } }, plainCtx);
    const again: any = await beforeHandler(makeEvent(buildSession(6), undefined, {}, 90000), plainCtx);
    expect(again?.compaction).toBeDefined();
  });
});
