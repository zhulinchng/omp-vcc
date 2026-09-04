// @ts-nocheck
// E2E: omp-vcc command matrix + mixed-strategy compaction chains (host-free).
// Covers: /omp-vcc keep variants + /pi-vcc alias + /vcc-recall + /vcc-stats +
// error interleave; 3-pass VCC chain; VCC+snapcompact multi-attempt (mock-mode:
// compactMode bypass + synthetic comp() entry — snapcompact and VCC archive the
// same messagesToSummarize slice, so sequential entries are the only valid combo
// per docs/setup.md#combining-omp-vcc-with-shake-and-snapcompact); VCC +
// normal/handoff/shake/soft/remote; boundary interleaves.
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  OMP_VCC_COMPACT_INSTRUCTION,
  getLastCompactionStats,
  getCompactionHistory,
  clearCompactionHistoryForTests,
  formatCompactionStats,
  formatStatsTable,
} from "../../extensions/vcc-core/hook";
import { parseKeepAndPrompt } from "../../extensions/vcc-core/core/compact-args";
import createExtension from "../../extensions/main";
import { createIsolatedOmpDir, writeConfig as writeHarnessConfig } from "./support/e2e-harness";
import {
  buildSession,
  buildOrphanSession,
  buildRecallSession,
  buildTooFewSession,
  buildToolResultBoundarySession,
  msg,
  comp,
  resetBoundary,
} from "./support/session-builder";
import { loadAllMessages } from "../../extensions/vcc-core/core/load-messages";
import { searchEntriesDetailed, getTouchedFiles } from "../../extensions/vcc-core/core/search-entries";
import { formatRecallOutput, formatTouchedOutput } from "../../extensions/vcc-core/core/format-recall";

let isolated: ReturnType<typeof createIsolatedOmpDir>;
const DEBUG_PATH = "/tmp/omp-vcc-debug.json";
const DEBUG_LEGACY = "/tmp/pi-vcc-debug.json";

function writeConfig(cfg: Record<string, unknown>): void {
  writeHarnessConfig(isolated.configPath, cfg);
}

// Full pi capture: hook events + tool/command registrations + sent messages.
function captureFullPi() {
  let before: any, compact: any;
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const sent: any[] = [];
  const sentUser: any[] = [];
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const zodChain: any = { optional: () => zodChain, describe: () => zodChain };
  const zod: any = {
    object: (_o: unknown) => ({}),
    string: () => zodChain,
    number: () => zodChain,
    array: (_x: unknown) => zodChain,
    enum: (_x: unknown) => zodChain,
  };
  const pi: any = {
    on: (name: string, h: any) => {
      if (name === "session_before_compact") before = h;
      if (name === "session_compact") compact = h;
    },
    registerTool: (t: any) => { tools[t.name] = t; },
    registerCommand: (name: string, def: any) => { commands[name] = def; },
    sendMessage: (m: any) => { sent.push(m); },
    sendUserMessage: (m: any) => { sentUser.push(m); },
    zod,
  };
  const ctx: any = {
    hasUI: true,
    ui: { notify: (m: string, l: string) => notifyCalls.push({ msg: m, level: l }) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    mode: "tui",
  };
  return { pi, ctx, commands, tools, sent, sentUser, notifyCalls, getBefore: () => before, getCompact: () => compact };
}

function makeEvent(branchEntries: any[], customInstructions?: string, tokensBefore = 90000, extra: Record<string, unknown> = {}): any {
  const { preparation: prepExtra, ...rest } = extra as any;
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore, ...(prepExtra ?? {}) },
    signal: new AbortController().signal,
    ...rest,
  };
}

function writeTempSession(entries: any[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vcc-mix-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

beforeAll(() => { isolated = createIsolatedOmpDir(); });
afterAll(() => { try { isolated.cleanup(); } catch {} });
beforeEach(() => {
  for (const p of [DEBUG_PATH, DEBUG_LEGACY]) try { if (existsSync(p)) unlinkSync(p); } catch {};
  try { if (existsSync(isolated.configPath)) unlinkSync(isolated.configPath); } catch {};
  process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
  process.env.PI_VCC_CONFIG_PATH = isolated.configPath;
  clearCompactionHistoryForTests();
});
afterEach(() => {
  for (const p of [DEBUG_PATH, DEBUG_LEGACY]) try { if (existsSync(p)) unlinkSync(p); } catch {};
  try { if (existsSync(isolated.configPath)) unlinkSync(isolated.configPath); } catch {};
  delete process.env.OMP_VCC_CONFIG_PATH;
  delete process.env.PI_VCC_CONFIG_PATH;
  clearCompactionHistoryForTests();
});

// ── Suite A: command matrix ──
describe("mix-matrix — omp-vcc command matrix via real handlers", () => {
  test("A1: /omp-vcc default, keep:2+focus, /pi-vcc alias", async () => {
    writeConfig({ overrideDefaultCompaction: true, vccEnabled: true, smartKeepTail: false, debug: false });
    const cap = captureFullPi();
    createExtension(cap.pi);
    expect(cap.commands["omp-vcc"]).toBeDefined();
    expect(cap.commands["pi-vcc"]).toBeDefined();
    const before = cap.getBefore();
    expect(before).toBeDefined();

    const entries = buildSession({ turns: 5, charsPerTurn: 500 }) as any[];
    const runCompactWith = (live: any[]) => async (ci?: string) => {
      const r: any = await before(makeEvent(live, ci, 90000), cap.ctx);
      if (!r || !r.compaction) throw new Error("Compaction cancelled");
    };

    // /omp-vcc default
    const cmdCtx1: any = { ...cap.ctx, compact: runCompactWith(entries) };
    await cap.commands["omp-vcc"].handler("", cmdCtx1);
    expect(cap.notifyCalls[0].msg).toMatch(/compacting with keep:1/);
    const s1 = getLastCompactionStats(cap.pi)!;
    expect(s1).toBeDefined();
    expect(s1.keptUserTurns).toBe(1);
    expect(formatCompactionStats(s1)).toMatch(/omp-vcc:/);

    // /omp-vcc keep:2 + focus
    const parsed = parseKeepAndPrompt("keep:2 fix auth token refresh");
    expect(parsed.keepUserTurns).toBe(2);
    expect(parsed.keepUserTurnsExplicit).toBe(true);
    expect(parsed.followUpPrompt).toMatch(/fix auth token refresh/);
    let seenCi = "";
    const cmdCtx2: any = {
      ...cap.ctx,
      compact: async (ci?: string) => {
        seenCi = ci ?? "";
        return runCompactWith(entries)(ci);
      },
    };
    await cap.commands["omp-vcc"].handler("keep:2 fix auth token refresh", cmdCtx2);
    expect(seenCi).toMatch(/keep:2/);
    const s2 = getLastCompactionStats(cap.pi)!;
    expect(s2.requestedKeepUserTurns).toBe(2);
    expect(s2.keepUserTurnsExplicit).toBe(true);
    expect(s2.keptUserTurns).toBe(2);

    // /pi-vcc alias still handled when override:false (sentinel bypasses threshold gate)
    writeConfig({ overrideDefaultCompaction: false, vccEnabled: true, smartKeepTail: false, debug: false });
    const cmdCtx3: any = { ...cap.ctx, compact: runCompactWith(entries) };
    await cap.commands["pi-vcc"].handler("keep:1", cmdCtx3);
    const s3 = getLastCompactionStats(cap.pi)!;
    expect(s3).toBeDefined();
    expect(s3.keptUserTurns).toBe(1);
    expect(getCompactionHistory(cap.pi).length).toBe(3);
  });

  test("A2: /vcc-recall keyword, scope:all paging, out-of-range guidance, touched", async () => {
    writeConfig({ overrideDefaultCompaction: true, vccEnabled: true });
    const cap = captureFullPi();
    createExtension(cap.pi);
    expect(cap.commands["vcc-recall"]).toBeDefined();

    const entries = buildRecallSession() as any[];
    const file = writeTempSession(entries);
    const recallCtx: any = {
      ...cap.ctx,
      sessionManager: { getSessionFile: () => file, getBranch: () => [] },
    };
    // keyword via real handler
    await cap.commands["vcc-recall"].handler("redis cache", recallCtx);
    expect(cap.sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(cap.sent[cap.sent.length - 1])).toMatch(/redis cache/i);
    expect(cap.notifyCalls[cap.notifyCalls.length - 1].msg).toMatch(/vcc_recall:/);

    // scope:all page:1 via real handler preserves scope suffix
    await cap.commands["vcc-recall"].handler("hook|inject scope:all page:1", recallCtx);
    expect(JSON.stringify(cap.sent[cap.sent.length - 1])).toMatch(/scope: all/i);

    // out-of-range page guidance via real handler
    await cap.commands["vcc-recall"].handler("redis page:99 scope:all", recallCtx);
    expect(JSON.stringify(cap.sent[cap.sent.length - 1])).toMatch(/outside the available range/);

    // mode:touched aggregates files (tool-level parity inside the command mix)
    const touchedEntries: any[] = [];
    for (let i = 0; i < 5; i++) {
      touchedEntries.push(msg(`u${i}`, "user", `goal ${i}`));
      touchedEntries.push({
        id: `a${i}`,
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `tc${i}`, name: "write", arguments: { path: `src/file${i}.ts`, content: "line1\nline2" } }],
          api: "messages", provider: "anthropic", model: "test",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          timestamp: Date.now(), stopReason: "toolUse",
        },
      });
      touchedEntries.push(msg(`t${i}`, "toolResult", "ok"));
    }
    const loaded = loadAllMessages(writeTempSession(touchedEntries), false, undefined);
    const touched = getTouchedFiles(loaded.rawMessages as any, loaded.rendered as any);
    expect(touched.length).toBeGreaterThan(0);
    expect(formatTouchedOutput(touched, 1)).toMatch(/src\/file/);
    // keyword parity at helper level
    const loaded2 = loadAllMessages(file, false, undefined);
    const hits = searchEntriesDetailed(loaded2.rendered as any, loaded2.rawMessages as any, "redis cache");
    expect(hits.hits.length).toBeGreaterThan(0);
    expect(formatRecallOutput(hits.hits.slice(0, 5), "redis cache")).toMatch(/redis cache/i);
  });

  test("A3: /vcc-stats after compactions; too_few error then orphan recovery", async () => {
    writeConfig({ overrideDefaultCompaction: true, vccEnabled: true, smartKeepTail: false, debug: false });
    const cap = captureFullPi();
    createExtension(cap.pi);
    const before = cap.getBefore();
    const entries = buildSession({ turns: 5, charsPerTurn: 500 }) as any[];
    const runCompactWith = (live: any[], tokens = 90000) => async (ci?: string) => {
      const r: any = await before(makeEvent(live, ci, tokens), cap.ctx);
      if (!r || !r.compaction) throw new Error("Compaction cancelled");
    };
    await cap.commands["omp-vcc"].handler("", { ...cap.ctx, compact: runCompactWith(entries) });
    await cap.commands["omp-vcc"].handler("keep:2", { ...cap.ctx, compact: runCompactWith(entries) });
    await cap.commands["omp-vcc"].handler("keep:1", { ...cap.ctx, compact: runCompactWith(entries) });
    expect(getCompactionHistory(cap.pi).length).toBe(3);

    // /vcc-stats shows savings table
    const statsCtx: any = { ...cap.ctx, sessionManager: { getSessionFile: () => undefined } };
    await cap.commands["vcc-stats"].handler("", statsCtx);
    expect(JSON.stringify(cap.sent[cap.sent.length - 1])).toMatch(/Before → After/);
    expect(cap.notifyCalls[cap.notifyCalls.length - 1].msg).toMatch(/vcc_stats:/);
    expect(formatStatsTable(getCompactionHistory(cap.pi))).toMatch(/Before → After/);

    // error interleave: too_few cancels with warning (small tokensBefore avoids overflow-heuristic fallback)
    const few = buildTooFewSession() as any[];
    const fewCtx: any = { ...cap.ctx, compact: runCompactWith(few, 1000) };
    const nBefore = cap.notifyCalls.length;
    await cap.commands["omp-vcc"].handler("", fewCtx);
    expect(cap.notifyCalls.slice(nBefore).map((n) => n.msg).join("\n")).toMatch(/Nothing to compact/);
    expect(getCompactionHistory(cap.pi).length).toBe(3);

    // orphan "" recovery compacts on next attempt
    const orphans: any[] = [...few, comp("c1", ""), msg("uX", "user", "new after compactAll"), msg("aX", "assistant", "reply"), msg("uY", "user", "another"), msg("aY", "assistant", "another reply")];
    await cap.commands["omp-vcc"].handler("", { ...cap.ctx, compact: runCompactWith(orphans) });
    expect(getCompactionHistory(cap.pi).length).toBe(4);
    // isolated orphan session also recovers via hook directly
    const r: any = await before(makeEvent(buildOrphanSession() as any[], OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx);
    expect(r.compaction).toBeDefined();
  });
});

// ── Suite B: 3-pass chain ──
describe("mix-matrix — 3-pass VCC chain with growth and keep rotation", () => {
  test("B: keep:1 -> keep:2 -> keep:1 bounded merge, history 3", async () => {
    writeConfig({ overrideDefaultCompaction: true, vccEnabled: true, smartKeepTail: false, debug: false });
    const cap = captureFullPi();
    registerBeforeCompactHook(cap.pi);
    const before = cap.getBefore();

    const entries1 = buildSession({ turns: 5, charsPerTurn: 700 }) as any[];
    const r1: any = await before(makeEvent(entries1, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx);
    expect(r1.compaction).toBeDefined();
    expect(r1.compaction.summary.length).toBeGreaterThan(100);
    const kept1 = r1.compaction.firstKeptEntryId as string;
    expect(kept1).toBeTruthy();
    expect(getLastCompactionStats(cap.pi)!.keptUserTurns).toBe(1);

    const entries2: any[] = [...entries1, comp("c1", kept1)];
    for (let i = 0; i < 8; i++) {
      entries2.push(msg(`u2_${i}`, "user", "follow-up auth ".repeat(15)));
      entries2.push(msg(`a2_${i}`, "assistant", "reply ".repeat(15)));
    }
    const r2: any = await before({
      type: "session_before_compact",
      customInstructions: `${OMP_VCC_COMPACT_INSTRUCTION} keep:2`,
      branchEntries: entries2,
      preparation: { previousSummary: r1.compaction.summary, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 },
      signal: new AbortController().signal,
    }, cap.ctx);
    expect(r2.compaction).toBeDefined();
    expect(r2.compaction.details.version).toBe(2);
    expect(r2.compaction.firstKeptEntryId).not.toBe(kept1);
    expect(getLastCompactionStats(cap.pi)!.requestedKeepUserTurns).toBe(2);

    const kept2 = r2.compaction.firstKeptEntryId as string;
    const entries3: any[] = [...entries2, comp("c2", kept2)];
    for (let i = 0; i < 6; i++) {
      entries3.push(msg(`u3_${i}`, "user", "third pass follow-up ".repeat(12)));
      entries3.push(msg(`a3_${i}`, "assistant", "reply ".repeat(12)));
    }
    const r3: any = await before({
      type: "session_before_compact",
      customInstructions: OMP_VCC_COMPACT_INSTRUCTION,
      branchEntries: entries3,
      preparation: { previousSummary: r2.compaction.summary, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 },
      signal: new AbortController().signal,
    }, cap.ctx);
    expect(r3.compaction).toBeDefined();
    expect(getCompactionHistory(cap.pi).length).toBe(3);
    expect(r3.compaction.summary.length).toBeLessThan(r1.compaction.summary.length + r2.compaction.summary.length + 5000);
    // Recall hint survives chaining exactly once (no per-cycle duplication).
    const notes = r3.compaction.summary.split("Do not redo work already completed.").length - 1;
    expect(notes).toBe(1);
  });
});

// ── Suite C: VCC + snapcompact multi-attempt (mock-mode) ──
describe("mix-matrix — VCC + snapcompact multi-turn multi-attempt", () => {
  test("C1: VCC success -> explicit snapcompact void -> VCC again post-snap", async () => {
    writeConfig({ overrideDefaultCompaction: true, vccEnabled: true, smartKeepTail: false, debug: false });
    const cap = captureFullPi();
    registerBeforeCompactHook(cap.pi);
    const before = cap.getBefore();

    const entries1 = buildSession({ turns: 5, charsPerTurn: 500 }) as any[];
    const r1: any = await before(makeEvent(entries1, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx);
    expect(r1.compaction).toBeDefined();
    const kept1 = r1.compaction.firstKeptEntryId as string;

    // grow 10 turns, host takes explicit snapcompact (hook voids)
    const grown: any[] = [...entries1, comp("c1", kept1)];
    for (let i = 0; i < 10; i++) {
      grown.push(msg(`g_${i}`, "user", "snap turn content ".repeat(12)));
      grown.push(msg(`h_${i}`, "assistant", "reply ".repeat(12)));
    }
    expect(await before(makeEvent(grown, undefined, 90000, { compactMode: "snapcompact" }), cap.ctx)).toBeUndefined();
    // synthetic host snapcompact entry, then VCC again on identical post-snap history
    const postSnap: any[] = [...grown, comp("c-snap", kept1)];
    for (let i = 0; i < 4; i++) {
      postSnap.push(msg(`p_${i}`, "user", "post snap follow-up ".repeat(12)));
      postSnap.push(msg(`q_${i}`, "assistant", "reply ".repeat(12)));
    }
    const r3: any = await before(makeEvent(postSnap, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx);
    expect(r3.compaction).toBeDefined();
    const ids = postSnap.map((e: any) => e.id);
    expect(ids.indexOf(r3.compaction.firstKeptEntryId)).toBeGreaterThan(ids.indexOf("c-snap"));
    expect(getCompactionHistory(cap.pi).length).toBe(2);
  });

  test("C2: vision gate — threshold void on text-only, sentinel handled on identical entries", async () => {
    writeConfig({ overrideDefaultCompaction: false, vccEnabled: true, smartKeepTail: false, debug: false });
    const cap = captureFullPi();
    registerBeforeCompactHook(cap.pi);
    const before = cap.getBefore();
    const entries = buildSession({ turns: 5, charsPerTurn: 400 }) as any[];
    // host would walk methodOrder [remote, snapcompact, handoff, shake, soft] and skip
    // snapcompact on text-only model input; hook defers by returning void...
    expect(await before(makeEvent(entries, undefined, 90000), cap.ctx)).toBeUndefined();
    // ...but the identical entries with the VCC sentinel are handled
    expect((await before(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx))?.compaction).toBeDefined();
  });

  test("C3: overflow willRetry defers to host, retry succeeds, history counts VCC only", async () => {
    writeConfig({ overrideDefaultCompaction: true, vccEnabled: true, smartKeepTail: false, debug: false });
    const cap = captureFullPi();
    registerBeforeCompactHook(cap.pi);
    const before = cap.getBefore();
    const full = buildSession({ turns: 5, charsPerTurn: 500 }) as any[];
    const r1: any = await before(makeEvent(full, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx);
    expect(r1.compaction).toBeDefined();

    // overflow retry on too-few session falls through to host (void, not cancel)
    const few = buildTooFewSession() as any[];
    expect(await before(makeEvent(few, undefined, 90000, { reason: "overflow", willRetry: true }), cap.ctx)).toBeUndefined();
    // retry with full session succeeds on identical gate
    const grown: any[] = [...full, comp("c1", r1.compaction.firstKeptEntryId)];
    for (let i = 0; i < 5; i++) {
      grown.push(msg(`r_${i}`, "user", "retry follow-up ".repeat(12)));
      grown.push(msg(`s_${i}`, "assistant", "reply ".repeat(12)));
    }
    expect((await before(makeEvent(grown, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx))?.compaction).toBeDefined();
    expect(getCompactionHistory(cap.pi).length).toBe(2);
  });
});

// ── Suite D: VCC + normal/handoff/shake/soft/remote ──
describe("mix-matrix — VCC with normal, handoff, shake, soft, remote", () => {
  test("D1: override:false threshold void (host owns auto), sentinel handled", async () => {
    writeConfig({ overrideDefaultCompaction: false, vccEnabled: true, smartKeepTail: false });
    const cap = captureFullPi();
    registerBeforeCompactHook(cap.pi);
    const before = cap.getBefore();
    const entries = buildSession({ turns: 5 }) as any[];
    expect(await before(makeEvent(entries, undefined, 90000), cap.ctx)).toBeUndefined();
    expect((await before(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx))?.compaction).toBeDefined();
  });

  test("D2: explicit handoff/soft/remote/shake void with override:true, sentinel handled", async () => {
    writeConfig({ overrideDefaultCompaction: true, vccEnabled: true, smartKeepTail: false });
    const cap = captureFullPi();
    registerBeforeCompactHook(cap.pi);
    const before = cap.getBefore();
    const entries = buildSession({ turns: 5 }) as any[];
    for (const m of ["handoff", "soft", "remote", "shake"]) {
      expect(await before(makeEvent(entries, undefined, 90000, { compactMode: m }), cap.ctx)).toBeUndefined();
    }
    // same entries via sentinel are handled — void came from the gate, not bad fixtures
    expect((await before(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx))?.compaction).toBeDefined();
  });

  test("D3: additive VCC + shake chain on/off", async () => {
    for (const chain of [false, true]) {
      writeConfig({ overrideDefaultCompaction: true, vccEnabled: true, chainShakeHint: chain, continueAfterThresholdCompact: false });
      const cap = captureFullPi();
      registerBeforeCompactHook(cap.pi);
      const entries = buildSession({ turns: 6 }) as any[];
      const r: any = await cap.getBefore()(makeEvent(entries, undefined, 90000), cap.ctx);
      expect(r.compaction).toBeDefined();
      let shakeCalls = 0;
      let shakeArg: any = null;
      const chainCtx: any = {
        ...cap.ctx,
        compact: (arg: any) => { shakeCalls++; shakeArg = arg; return Promise.resolve(); },
        settings: { get: (k: string) => (k.includes("chainShakeHint") ? chain : undefined) },
        config: { get: () => undefined },
      };
      await cap.getCompact()({ fromExtension: true, compactionEntry: { id: "c1", tokensBefore: 90000, tokensAfter: 21000 } }, chainCtx);
      await new Promise((res) => setTimeout(res, 40));
      if (chain) {
        expect(shakeCalls).toBe(1);
        expect(shakeArg).toEqual({ mode: "shake" });
      } else {
        expect(shakeCalls).toBe(0);
      }
    }
  });

  test("D4: native fromExtension:false and willRetry overflow trigger nothing", async () => {
    writeConfig({ overrideDefaultCompaction: true, vccEnabled: true, chainShakeHint: true, continueAfterThresholdCompact: true });
    const cap = captureFullPi();
    registerBeforeCompactHook(cap.pi);
    const entries = buildSession({ turns: 6 }) as any[];
    const r: any = await cap.getBefore()(makeEvent(entries, undefined, 90000), cap.ctx);
    expect(r.compaction).toBeDefined();
    const notes: string[] = [];
    const guardCtx: any = {
      ...cap.ctx,
      ui: { notify: (m: string) => notes.push(m) },
      compact: () => { notes.push("compact-called"); return Promise.resolve(); },
      settings: { get: () => undefined },
      config: { get: () => undefined },
    };
    await cap.getCompact()({ fromExtension: false, compactionEntry: { id: "c1", tokensBefore: 90000, tokensAfter: 20000 } }, guardCtx);
    await cap.getCompact()({ fromExtension: true, willRetry: true, compactionEntry: { id: "c2", tokensBefore: 90000, tokensAfter: 80000 } }, guardCtx);
    await new Promise((res) => setTimeout(res, 40));
    expect(notes).toEqual([]);
  });
});

// ── Suite E: boundary interleaves ──
describe("mix-matrix — boundary interleaves inside chains", () => {
  test("E1: reset_boundary cut + toolResult tail snap inside 2-pass chain", async () => {
    writeConfig({ overrideDefaultCompaction: true, vccEnabled: true, smartKeepTail: false, debug: false });
    const cap = captureFullPi();
    registerBeforeCompactHook(cap.pi);
    const before = cap.getBefore();
    const entries1 = buildSession({ turns: 5, charsPerTurn: 500 }) as any[];
    const r1: any = await before(makeEvent(entries1, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx);
    expect(r1.compaction).toBeDefined();
    // reset_boundary after prior compaction supersedes it
    const entries2: any[] = [...entries1, comp("c1", r1.compaction.firstKeptEntryId), resetBoundary("r1")];
    for (let i = 0; i < 4; i++) {
      entries2.push(msg(`n_${i}`, "user", "post reset work ".repeat(12)));
      entries2.push(msg(`o_${i}`, "assistant", "reply ".repeat(12)));
    }
    const r2: any = await before(makeEvent(entries2, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx);
    expect(r2.compaction).toBeDefined();
    // toolResult-terminated live set snaps off the toolResult
    const tr = buildToolResultBoundarySession() as any[];
    const trailingId = (tr[tr.length - 1] as any).id;
    const r3: any = await before(makeEvent(tr, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx);
    expect(r3.compaction).toBeDefined();
    expect(r3.compaction.firstKeptEntryId).not.toBe(trailingId);
  });

  test("E2: debug second pass writes metrics snapshot without full-transcript leak", async () => {
    writeConfig({ overrideDefaultCompaction: true, vccEnabled: true, smartKeepTail: false, debug: true });
    const cap = captureFullPi();
    registerBeforeCompactHook(cap.pi);
    const before = cap.getBefore();
    const secret = `SECRET_${"z".repeat(2000)}_TAIL`;
    const entries1 = buildSession({ turns: 5, charsPerTurn: 500 }) as any[];
    entries1.push(msg("mx", "user", `marker ${secret}`));
    entries1.push(msg("my", "assistant", "noted"));
    const r1: any = await before(makeEvent(entries1, OMP_VCC_COMPACT_INSTRUCTION, 90000), cap.ctx);
    expect(r1.compaction).toBeDefined();
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const { readFileSync } = await import("fs");
    const snap = JSON.parse(readFileSync(DEBUG_PATH, "utf8"));
    expect(snap.usedOwnCut).toBe(true);
    expect(typeof snap.summaryPreview === "string" && snap.summaryPreview.length <= 500).toBe(true);
    expect(JSON.stringify(snap).includes(secret)).toBe(false);
  });
});
