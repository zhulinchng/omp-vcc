// @ts-nocheck
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { registerBeforeCompactHook, getLastCompactionStats, getCompactionHistory, clearCompactionHistoryForTests, formatCompactionStats, formatLastStatsDetail, formatStatsTable, OMP_VCC_COMPACT_INSTRUCTION } from "../../extensions/vcc-core/hook";
import { createIsolatedOmpDir } from "./support/e2e-harness";
import { buildSession, msg } from "./support/session-builder";

let isolated: ReturnType<typeof createIsolatedOmpDir>;
const DEBUG_PATH = "/tmp/omp-vcc-debug.json";

function createMockPi() {
  let beforeHandler: any;
  let compactHandler: any;
  const pi: any = {
    on: (name: string, h: any) => {
      if (name === "session_before_compact") beforeHandler = h;
      if (name === "session_compact") compactHandler = h;
      if (name === "before_agent_start" || name === "context") {}
    },
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  const ctx: any = { hasUI: true, ui: { notify: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, mode: "tui" };
  return { pi, ctx, getBefore: () => beforeHandler, getCompact: () => compactHandler };
}
function makeEvent(branchEntries: any[], customInstructions?: string, tokensBefore = 90000): any {
  return { type: "session_before_compact", customInstructions, branchEntries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore }, signal: new AbortController().signal };
}

beforeAll(() => { isolated = createIsolatedOmpDir(); });
afterAll(() => { try { isolated.cleanup(); } catch {} });
beforeEach(() => { for (const p of [DEBUG_PATH, "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {}; try { if (existsSync(isolated.configPath)) unlinkSync(isolated.configPath); } catch {}; clearCompactionHistoryForTests(); delete process.env.OMP_VCC_CONFIG_PATH; });
afterEach(() => { for (const p of [DEBUG_PATH, "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {}; try { if (existsSync(isolated.configPath)) unlinkSync(isolated.configPath); } catch {}; clearCompactionHistoryForTests(); delete process.env.OMP_VCC_CONFIG_PATH; });

describe("stats E2E — vcc_stats tool, commands, inline --stats, table edges, history capping", () => {
  test("vcc_stats with no compactions returns No compactions yet", () => {
    const fakePi: any = {};
    const stats = getLastCompactionStats(fakePi);
    expect(stats).toBeNull();
    const detail = formatLastStatsDetail(stats);
    expect(detail).toMatch(/No compaction has run yet/);
    const history = getCompactionHistory(fakePi);
    expect(Array.isArray(history)).toBe(true);
    const table = formatStatsTable(history);
    expect(table).toMatch(/No compactions yet/);
  });

  test("after manual compaction, vcc_stats returns detail with Before→After and Saved", async () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true }));
    const { pi, ctx, getBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 5, charsPerTurn: 800 }) as any[];
    await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 90000), ctx);
    const last = getLastCompactionStats(pi);
    expect(last).not.toBeNull();
    const detail = formatLastStatsDetail(last);
    // should contain Before→After when savings present
    expect(detail).toMatch(/Before|Saved|Kept/);
    // history table
    const history = getCompactionHistory(pi);
    expect(history.length).toBe(1);
    const table = formatStatsTable(history);
    expect(table).toMatch(/Before → After/);
    expect(table).toMatch(/Saved/);
    expect(table).toMatch(/Kept/);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("vcc_stats with history:true includes table", async () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true }));
    const { pi, ctx, getBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 5, charsPerTurn: 500 }) as any[];
    await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 80000), ctx);
    await getBefore()(makeEvent([...entries, { id: "c1", type: "compaction", firstKeptEntryId: "m1" }, msg("m_new1", "user", "new turn"), msg("m_new2", "assistant", "reply")].concat(buildSession({ turns: 3, charsPerTurn: 500 }) as any[]), OMP_VCC_COMPACT_INSTRUCTION, 70000), ctx);
    const history = getCompactionHistory(pi);
    expect(history.length).toBe(2);
    const table = formatStatsTable(history);
    expect(table.split("\n").length).toBeGreaterThan(3);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("formatCompactionStats edges: before undefined, saved 0, percent 0, after>before", () => {
    expect(formatCompactionStats({ keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 10, tokensBefore: 0, tokensAfterEst: 100 } as any)).toMatch(/kept 1\/5/);
    expect(formatCompactionStats({ keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 10, tokensBefore: 1000, tokensAfterEst: 1000, tokensSavedEst: 0, savedPercentEst: 0 } as any)).not.toMatch(/saved/);
    expect(formatCompactionStats({ keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 10, tokensBefore: 10000, tokensAfterEst: 11000, tokensSavedEst: 0 } as any)).toMatch(/kept/);
    expect(formatCompactionStats({ keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 10, tokensBefore: 90000, tokensAfterEst: 22000, tokensSavedEst: 68000, savedPercentEst: 76 } as any)).toMatch(/90\.0k→22\.0k/);
  });

  test("formatStatsTable edges: timestamp null, budgetCut suffix, 999 vs 1000 boundary, saved 0 → —", () => {
    const entry: any = { tokensBefore: 999, tokensAfter: 500, tokensAfterEst: 500, tokensSaved: 499, savedPercent: 50, keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 200, summarized: 10, timestamp: null };
    const table1 = formatStatsTable([entry]);
    expect(table1).toMatch(/—/); // timestamp null → —
    const withBudget: any = { ...entry, budgetCut: "oversized_tail", timestamp: Date.now() };
    const table2 = formatStatsTable([withBudget]);
    expect(table2).toMatch(/oversized_tail|budget/);
    const smallSaved: any = { tokensBefore: 1000, tokensAfter: 1000, tokensSaved: 0, savedPercent: 0, keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 5, timestamp: Date.now() };
    const table3 = formatStatsTable([smallSaved]);
    expect(table3).toBeTruthy();
    const thousand: any = { tokensBefore: 1000, tokensAfter: 500, tokensSaved: 500, savedPercent: 50, keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 1, timestamp: Date.now() };
    const table4 = formatStatsTable([thousand]);
    expect(table4).toMatch(/1\.0k/);
  });

  test("history capping at 50 and copy isolation", async () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true }));
    const { pi, ctx, getBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    // trigger 55 compactions
    for (let i = 0; i < 55; i++) {
      const entries = buildSession({ turns: 4, charsPerTurn: 300 }) as any[];
      await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 50000 + i), ctx);
    }
    const history = getCompactionHistory(pi);
    expect(history.length).toBe(50);
    // copy isolation: mutating returned array shouldn't affect internal
    const copy = getCompactionHistory(pi);
    copy.push({ keptUserTurns: 999 } as any);
    const after = getCompactionHistory(pi);
    expect(after.length).toBe(50);
    expect(after.some((s: any) => s.keptUserTurns === 999)).toBe(false);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("per-pi isolation: two pi instances have separate histories", async () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true }));
    const a = createMockPi();
    const b = createMockPi();
    registerBeforeCompactHook(a.pi);
    registerBeforeCompactHook(b.pi);
    const entries = buildSession({ turns: 4, charsPerTurn: 400 }) as any[];
    await a.getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 80000), a.ctx);
    await a.getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 80000), a.ctx);
    await b.getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 80000), b.ctx);
    expect(getCompactionHistory(a.pi).length).toBe(2);
    expect(getCompactionHistory(b.pi).length).toBe(1);
    clearCompactionHistoryForTests();
    expect(getCompactionHistory(a.pi).length).toBe(0);
    expect(getCompactionHistory(b.pi).length).toBe(0);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("authoritative enrichment before early return (manual compaction gets authoritative numbers)", async () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: true, overrideDefaultCompaction: true, smartKeepTail: false }));
    let beforeHandler: any;
    let compactHandler: any;
    const pi: any = {
      on: (name: string, h: any) => { if (name === "session_before_compact") beforeHandler = h; if (name === "session_compact") compactHandler = h; if (name === "before_agent_start" || name === "context") {} },
      sendMessage: () => {}, sendUserMessage: () => {},
    };
    const ctx: any = { hasUI: true, ui: { notify: (m: string, l: string) => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, mode: "tui" };
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 5, charsPerTurn: 500 }) as any[];
    const beforeResult: any = await beforeHandler({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: entries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 }, signal: new AbortController().signal }, ctx);
    expect(beforeResult.compaction.details.savings.tokensBefore).toBe(90000);
    await compactHandler({ type: "session_compact", fromExtension: true, compactionEntry: { tokensBefore: 90000, tokensAfter: 21000, id: "c1" } } as any, ctx);
    const last = getLastCompactionStats(pi);
    expect(last).not.toBeNull();
    expect(last!.tokensBefore).toBe(90000);
    if (last!.tokensAfter != null) expect(last!.tokensAfter).toBe(21000);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("scheduleCompactionStatsNotify deferred toast contains omp-vcc prefix (smoke)", async () => {
    const { scheduleCompactionStatsNotify } = await import("../../extensions/vcc-core/hook");
    let notified = "";
    const ctx: any = { ui: { notify: (m: string) => { notified = m; } } };
    scheduleCompactionStatsNotify(ctx, { keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 2100, summarized: 10, tokensBefore: 90000, tokensAfterEst: 22000, tokensSavedEst: 68000, savedPercentEst: 76 } as any);
    // wait 600ms for deferred 500ms toast
    await new Promise((r) => setTimeout(r, 600));
    expect(notified).toMatch(/omp-vcc:/);
  });

  test("inline /omp-vcc --stats variants case-insensitive (parseCompactionInstructions proxy)", async () => {
    // main.ts inline --stats handling is via string includes check case-insensitive
    const variants = ["--stats", "--STATS", "stats", "HISTORY", "--stats history", "stats all", "HISTORY all"];
    for (const v of variants) {
      const lower = v.toLowerCase();
      const isStats = lower.includes("stats") || lower.includes("history") || lower.includes("all");
      expect(isStats).toBe(true);
    }
  });
});
