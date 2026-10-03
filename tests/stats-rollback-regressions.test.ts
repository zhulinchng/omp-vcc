// @ts-nocheck
// Stats-rollback defects found by the hook review.
//
// 1. The phantom-stat rollback truncated with `statsHistory.length = <old length>`,
//    but setLastStats pushes AND shifts once the history is at its 50-entry cap,
//    so the length is already back to 50 and the assignment is a no-op: the
//    phantom entry survived AND the oldest real entry was gone. vcc_stats /
//    /vcc-stats render exactly this history.
// 2. `session_compact` wrote the committing session's authoritative numbers into
//    the process-global `lastStats` mirror, which points at whichever session
//    called setLastStats last (omp loads extensions in-process per subagent
//    session), stamping one session's savings onto another's stats object.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  getCompactionHistory,
  getLastCompactionStats,
  clearCompactionHistoryForTests,
  OMP_VCC_COMPACT_INSTRUCTION,
} from "../extensions/vcc-core/hook.ts";

let tmpDir: string;
let CONFIG_PATH: string;
let origOmp: string | undefined;
let origPi: string | undefined;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vcc-stats-rb-"));
  CONFIG_PATH = join(tmpDir, "config.json");
  origOmp = process.env.OMP_VCC_CONFIG_PATH;
  origPi = process.env.PI_VCC_CONFIG_PATH;
  writeFileSync(CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, continueAfterThresholdCompact: false }));
});

afterAll(() => {
  if (origOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = origOmp;
  if (origPi === undefined) delete process.env.PI_VCC_CONFIG_PATH;
  else process.env.PI_VCC_CONFIG_PATH = origPi;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
  clearCompactionHistoryForTests();
});

const T = Date.now();
const msg = (id: string, role: string, content: string) => ({ id, type: "message", message: { role, content, timestamp: T } });
const session = (content: string) => [
  msg("u0", "user", content),
  msg("a0", "assistant", "working"),
  msg("u1", "user", "more"),
  msg("a1", "assistant", "done"),
];
const makeCtx = () => ({
  settings: { get: () => undefined },
  config: { get: () => undefined },
  ui: { notify: () => {} },
  sessionManager: { getEntries: () => [], getBranch: () => [] },
});
const mockPi = () => {
  const pi: any = { on: (e: string, f: any) => { pi[e] = f; }, sendMessage: () => {}, sendUserMessage: () => {} };
  registerBeforeCompactHook(pi);
  return pi;
};

const startCompaction = (pi: any, content: string, ctx: any) =>
  pi["session_before_compact"]({
    type: "session_before_compact",
    branchEntries: session(content),
    preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 100_000 },
    customInstructions: OMP_VCC_COMPACT_INSTRUCTION,
    signal: new AbortController().signal,
  }, ctx);

const commit = (pi: any, res: any, ctx: any, tokensAfter = 25_000) =>
  pi["session_compact"]({
    type: "session_compact",
    fromExtension: true,
    compactionEntry: {
      id: "c1",
      tokensBefore: 100_000,
      tokensAfter,
      summary: res.compaction.summary,
      firstKeptEntryId: res.compaction.firstKeptEntryId,
      details: res.compaction.details,
    },
  }, ctx);

describe("phantom-stat rollback", () => {
  test("below the cap: a host-owned commit rolls the plugin's stats back", async () => {
    const pi = mockPi();
    const ctx = makeCtx();
    const res = await startCompaction(pi, "first", ctx);
    expect(res?.compaction).toBeDefined();
    const phantom = getLastCompactionStats(pi);
    expect(phantom).toBeTruthy();

    // The host commits its OWN compaction: the plugin's stats must not survive.
    await pi["session_compact"]({
      type: "session_compact",
      fromExtension: false,
      compactionEntry: { id: "host", summary: "HOST OWN", firstKeptEntryId: "z", details: { compactor: "core" } },
    }, ctx);

    expect(getLastCompactionStats(pi)).toBeNull();
    expect(getCompactionHistory(pi)).toHaveLength(0);
    expect(getCompactionHistory()).toHaveLength(0);
  });

  test("at the 50-entry cap the rollback restores the evicted oldest entry", async () => {
    const pi = mockPi();
    const ctx = makeCtx();
    for (let i = 0; i < 50; i++) {
      const res = await startCompaction(pi, `cycle ${i} ${"x".repeat(i)}`, ctx);
      await commit(pi, res, ctx);
    }
    const history = getCompactionHistory(pi);
    expect(history).toHaveLength(50);
    const oldest = history[0];
    const previous = getLastCompactionStats(pi);

    // A 51st attempt produces a compaction (pushes a phantom, evicts `oldest`)...
    const res = await startCompaction(pi, "51st attempt", ctx);
    expect(res?.compaction).toBeDefined();
    // ...then the host commits its own, so the plugin must roll back.
    await pi["session_compact"]({
      type: "session_compact",
      fromExtension: false,
      compactionEntry: { id: "host", summary: "HOST OWN", firstKeptEntryId: "z", details: { compactor: "core" } },
    }, ctx);

    const after = getCompactionHistory(pi);
    expect(after).toHaveLength(50);
    // The oldest real entry is back by identity, not silently evicted...
    expect(after[0]).toBe(oldest);
    // ...and the phantom is gone from both the history and the last-stats slot.
    expect(after.includes(previous)).toBe(true);
    expect(getLastCompactionStats(pi)).toBe(previous);
    expect(getCompactionHistory()).toHaveLength(50);
  });
});

describe("process-global stats mirror", () => {
  test("one session's authoritative savings never land on another session's stats", async () => {
    const A = mockPi();
    const B = mockPi();
    const ctx = makeCtx();

    const resA = await startCompaction(A, "session A", ctx);
    expect(resA?.compaction).toBeDefined();

    // B compacts afterwards, so the module-level `lastStats` mirror now points
    // at B's stats object rather than A's.
    const resB = await startCompaction(B, "session B", ctx);
    expect(resB?.compaction).toBeDefined();
    const bStats = getLastCompactionStats(B);
    expect(bStats).toBeTruthy();
    expect(bStats.tokensAfter).toBeUndefined();

    // A commits with authoritative numbers.
    await commit(A, resA, ctx, 25_000);

    // A's own stats are enriched; B's are untouched.
    expect(getLastCompactionStats(A).tokensAfter).toBe(25_000);
    expect(bStats.tokensAfter).toBeUndefined();
    expect(bStats.tokensSaved).toBeUndefined();
  });

  test("the single-session case still enriches the module-level mirror", async () => {
    const pi = mockPi();
    const ctx = makeCtx();
    const res = await startCompaction(pi, "only session", ctx);
    await commit(pi, res, ctx, 25_000);
    expect(getLastCompactionStats(pi).tokensAfter).toBe(25_000);
    expect(getLastCompactionStats().tokensAfter).toBe(25_000);
  });
});
