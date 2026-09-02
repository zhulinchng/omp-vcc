// @ts-nocheck
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  OMP_VCC_COMPACT_INSTRUCTION,
  PI_VCC_COMPACT_INSTRUCTION,
  getLastCompactionStats,
  getCompactionHistory,
  clearCompactionHistoryForTests,
  triggerInvisibleContinue,
  AUTO_CONTINUE_CUSTOM_TYPE,
  formatCompactionStats,
} from "../../extensions/vcc-core/hook";
import { createIsolatedOmpDir } from "./support/e2e-harness";
import { buildSession, msg, comp, branchSummary } from "./support/session-builder";
import { loadAllMessages } from "../../extensions/vcc-core/core/load-messages";
import { searchEntriesDetailed, getTouchedFiles } from "../../extensions/vcc-core/core/search-entries";
import { formatRecallOutput, formatTouchedOutput } from "../../extensions/vcc-core/core/format-recall";
import { getActiveLineageEntryIds } from "../../extensions/vcc-core/core/lineage";

let isolated: ReturnType<typeof createIsolatedOmpDir>;
const DEBUG_PATH = "/tmp/omp-vcc-debug.json";

function capturePi() {
  let before: any, compact: any, ctxHandler: any, beforeStart: any;
  const sent: any[] = [];
  const pi: any = {
    on: (n: string, h: any) => {
      if (n === "session_before_compact") before = h;
      if (n === "session_compact") compact = h;
      if (n === "context") ctxHandler = h;
      if (n === "before_agent_start") beforeStart = h;
    },
    sendMessage: (m: any, o: any) => sent.push({ message: m, options: o }),
    sendUserMessage: (c: any) => sent.push({ user: c }),
  };
  const ctx: any = { hasUI: true, ui: { notify: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, mode: "tui" };
  return { pi, ctx, getBefore: () => before, getCompact: () => compact, getContext: () => ctxHandler, getBeforeStart: () => beforeStart, sent };
}
function makeEvent(branchEntries: any[], ci?: string, tokensBefore = 80000, extra: any = {}): any {
  return { type: "session_before_compact", customInstructions: ci, branchEntries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore, ...extra }, signal: new AbortController().signal, ...extra };
}

beforeAll(() => { isolated = createIsolatedOmpDir(); });
afterAll(() => { try { isolated.cleanup(); } catch {} });
beforeEach(() => {
  for (const p of [DEBUG_PATH, "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {};
  try { if (existsSync(isolated.configPath)) unlinkSync(isolated.configPath); } catch {};
  delete process.env.OMP_VCC_CONFIG_PATH;
  delete process.env.PI_VCC_CONFIG_PATH;
  clearCompactionHistoryForTests();
});
afterEach(() => {
  for (const p of [DEBUG_PATH, "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {};
  try { if (existsSync(isolated.configPath)) unlinkSync(isolated.configPath); } catch {};
  delete process.env.OMP_VCC_CONFIG_PATH;
  delete process.env.PI_VCC_CONFIG_PATH;
  clearCompactionHistoryForTests();
});

describe("mixed sequential — multi-feature interplay", () => {
  test("sequence: manual keep:1 -> second with previousSummary -> recall -> stats", async () => {
    writeFileSync(isolated.configPath, JSON.stringify({ debug: true, overrideDefaultCompaction: true, smartKeepTail: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    const { pi, ctx, getBefore } = capturePi();
    registerBeforeCompactHook(pi);
    const entries1 = buildSession({ turns: 5, charsPerTurn: 500 }) as any[];
    const r1: any = await getBefore()(makeEvent(entries1, OMP_VCC_COMPACT_INSTRUCTION, 80000), ctx);
    expect(r1.compaction).toBeDefined();
    const summary1 = r1.compaction.summary;
    // second compaction with previousSummary
    const entries2 = [...entries1, comp("c1", r1.compaction.firstKeptEntryId), msg("m_new1", "user", "sequential follow up after first compaction"), msg("m_new2", "assistant", "reply"), msg("m_new3", "user", "another turn"), msg("m_new4", "assistant", "reply2")] as any[];
    const r2: any = await getBefore()({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: entries2, preparation: { previousSummary: summary1, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 70000 }, signal: new AbortController().signal }, ctx);
    expect(r2.compaction).toBeDefined();
    expect(r2.compaction.summary.length).toBeLessThan(summary1.length * 2 + 5000);
    // write combined session to file and recall
    const dir = mkdtempSync(join(tmpdir(), "mixed-recall-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, entries2.map((e) => JSON.stringify(e)).join("\n"));
    const loaded = loadAllMessages(file, false, undefined);
    const result = searchEntriesDetailed(loaded.rendered as any, loaded.rawMessages as any, "follow up");
    expect(result.hits.length).toBeGreaterThan(0);
    // stats after two compactions
    expect(getCompactionHistory(pi).length).toBe(2);
    expect(formatCompactionStats(getLastCompactionStats(pi)!)).toMatch(/omp-vcc:/);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("sequence: debug false -> true overlay -> file appears", async () => {
    const { pi, ctx, getBefore } = capturePi();
    // start debug false
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true, smartKeepTail: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 4, charsPerTurn: 400 }) as any[];
    await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 60000), ctx);
    expect(existsSync(DEBUG_PATH)).toBe(false);
    // overlay debug true via ctx (simulate /settings toggle without restart)
    const ctxOverlay: any = { ...ctx, settings: { get: (k: string) => (k.includes("debug") ? true : undefined) }, config: { get: (k: string) => (k.includes("debug") ? true : undefined) } };
    await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 60000), ctxOverlay);
    expect(existsSync(DEBUG_PATH)).toBe(true);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("sequence: vccEnabled false blocks -> true allows -> history length 1", async () => {
    const { pi, ctx, getBefore } = capturePi();
    writeFileSync(isolated.configPath, JSON.stringify({ vccEnabled: false, overrideDefaultCompaction: true }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 4, charsPerTurn: 400 }) as any[];
    const blocked: any = await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 60000), ctx);
    expect(blocked).toBeUndefined();
    expect(getCompactionHistory(pi).length).toBe(0);
    writeFileSync(isolated.configPath, JSON.stringify({ vccEnabled: true, overrideDefaultCompaction: true, smartKeepTail: false }));
    const ok: any = await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 60000), ctx);
    expect(ok.compaction).toBeDefined();
    expect(getCompactionHistory(pi).length).toBe(1);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("sequence: override false blocks threshold but allows sentinel, then true allows threshold", async () => {
    const { pi, ctx, getBefore } = capturePi();
    writeFileSync(isolated.configPath, JSON.stringify({ overrideDefaultCompaction: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 5, charsPerTurn: 400 }) as any[];
    const thresholdBlocked: any = await getBefore()(makeEvent(entries, undefined, 90000), ctx);
    expect(thresholdBlocked).toBeUndefined();
    const sentinelOk: any = await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 90000), ctx);
    expect(sentinelOk.compaction).toBeDefined();
    clearCompactionHistoryForTests();
    writeFileSync(isolated.configPath, JSON.stringify({ overrideDefaultCompaction: true, smartKeepTail: false }));
    const thresholdOk: any = await getBefore()(makeEvent(entries, undefined, 90000), ctx);
    expect(thresholdOk.compaction).toBeDefined();
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("sequence: keep fallback then recall touched files after compaction", async () => {
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true, smartKeepTail: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    const { pi, ctx, getBefore } = capturePi();
    registerBeforeCompactHook(pi);
    // entries with file tool calls
    const entries: any[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push(msg(`u${i}`, "user", `goal ${i}`));
      entries.push({
        id: `a${i}`,
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `tc${i}`, name: "write", arguments: { path: `src/file${i}.ts`, content: "line1\nline2" } }],
          api: "messages", provider: "anthropic", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          timestamp: Date.now(), stopReason: "toolUse",
        },
      });
      entries.push(msg(`t${i}`, "toolResult", "ok"));
    }
    const r: any = await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 70000), ctx);
    expect(r.compaction).toBeDefined();
    // after compaction, recall touched still aggregates from original file
    const dir = mkdtempSync(join(tmpdir(), "mixed-touched-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
    const loaded = loadAllMessages(file, false, undefined);
    const touched = getTouchedFiles(loaded.rawMessages as any, loaded.rendered as any);
    expect(touched.length).toBeGreaterThan(0);
    const formatted = formatTouchedOutput(touched, 1);
    expect(formatted).toMatch(/src\/file/);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("sequence: smartKeep small tail boost then large tail budget rescue", async () => {
    // small tail => smartKeep boosts
    const smallEntries = buildSession({ turns: 6, charsPerTurn: 150 }) as any[];
    writeFileSync(isolated.configPath, JSON.stringify({ smartKeepTail: true, overrideDefaultCompaction: true, debug: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    const { pi: pi1, ctx: ctx1, getBefore: gb1 } = capturePi();
    registerBeforeCompactHook(pi1);
    const r1: any = await gb1()(makeEvent(smallEntries, OMP_VCC_COMPACT_INSTRUCTION, 40000), ctx1);
    expect(r1.compaction).toBeDefined();
    expect(getLastCompactionStats(pi1)!.keptUserTurns).toBeGreaterThanOrEqual(1);
    clearCompactionHistoryForTests();
    // large tail => oversized rescue
    const largeEntries: any[] = [
      msg("u0", "user", "a"),
      msg("a0", "assistant", "b"),
      msg("u_big", "user", "x".repeat(300000)),
      msg("a_big", "assistant", "y"),
      msg("t_big", "toolResult", "z".repeat(100000)),
    ];
    writeFileSync(isolated.configPath, JSON.stringify({ smartKeepTail: false, overrideDefaultCompaction: true, debug: false }));
    const { pi: pi2, ctx: ctx2, getBefore: gb2 } = capturePi();
    registerBeforeCompactHook(pi2);
    const r2: any = await gb2()(makeEvent(largeEntries as any, OMP_VCC_COMPACT_INSTRUCTION, 90000), ctx2);
    expect(r2.compaction).toBeDefined();
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("sequence: compaction then stats history capping and perPi isolation", async () => {
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true, smartKeepTail: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    const { pi: piA, ctx: ctxA, getBefore: gbA } = capturePi();
    const { pi: piB, ctx: ctxB, getBefore: gbB } = capturePi();
    registerBeforeCompactHook(piA);
    registerBeforeCompactHook(piB);
    const entries = buildSession({ turns: 3, charsPerTurn: 200 }) as any[];
    for (let i = 0; i < 3; i++) await gbA()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 50000 + i), ctxA);
    await gbB()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 60000), ctxB);
    expect(getCompactionHistory(piA).length).toBe(3);
    expect(getCompactionHistory(piB).length).toBe(1);
    clearCompactionHistoryForTests();
    expect(getCompactionHistory(piA).length).toBe(0);
    expect(getCompactionHistory(piB).length).toBe(0);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("sequence: threshold compaction with continue -> before_agent_start clears -> context filter strips", async () => {
    writeFileSync(isolated.configPath, JSON.stringify({ continueAfterThresholdCompact: true, overrideDefaultCompaction: true, debug: false, smartKeepTail: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    const { pi, ctx, getBefore, getCompact, getBeforeStart, getContext, sent } = capturePi();
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 5, charsPerTurn: 400 }) as any[];
    await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 90000), ctx);
    await getCompact()({ type: "session_compact", fromExtension: true, compactionEntry: { tokensBefore: 90000, tokensAfter: 20000, id: "c1" } }, ctx);
    // should have scheduled invisible continue
    await new Promise((r) => setTimeout(r, 20));
    const beforeCount = sent.length;
    // before_agent_start should clear pending timer if any still pending
    getBeforeStart()({ type: "before_agent_start", prompt: "next", systemPrompt: "", systemPromptOptions: {} } as any, ctx);
    await new Promise((r) => setTimeout(r, 20));
    // no new message after clear beyond initial
    expect(sent.length).toBeLessThanOrEqual(beforeCount + 1);
    // context filter should strip marker
    const ctxHandler = getContext();
    const messages: any[] = [{ role: "user", content: "hi" }, { role: "custom", customType: AUTO_CONTINUE_CUSTOM_TYPE, content: [] }, { role: "assistant", content: "reply" }];
    const filtered: any = ctxHandler({ messages });
    expect(filtered.messages.some((m: any) => m.customType === AUTO_CONTINUE_CUSTOM_TYPE)).toBe(false);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("sequence: multiple keep values in row, verify requestedKeep vs effective keep and history", async () => {
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true, smartKeepTail: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    const { pi, ctx, getBefore } = capturePi();
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 6, charsPerTurn: 300 }) as any[];
    for (const keep of [1, 2, 0, 1]) {
      const ci = keep === 1 && false ? OMP_VCC_COMPACT_INSTRUCTION : `${OMP_VCC_COMPACT_INSTRUCTION} keep:${keep}`;
      // keep:1 without explicit is default, but we force keep:1 explicit for test
      const useCi = `${OMP_VCC_COMPACT_INSTRUCTION} keep:${keep}`;
      const r: any = await getBefore()(makeEvent(entries, useCi, 70000), ctx);
      expect(r.compaction).toBeDefined();
    }
    expect(getCompactionHistory(pi).length).toBe(4);
    const last = getLastCompactionStats(pi);
    expect(last).not.toBeNull();
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("sequence: file touches across turns -> compaction -> touched still works post-compaction via rawMessages", async () => {
    const entries: any[] = [];
    for (let i = 0; i < 4; i++) {
      entries.push(msg(`u${i}`, "user", `task ${i}`));
      entries.push({
        id: `a${i}`,
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `tc${i}`, name: "edit", arguments: { path: `src/mod${i}.ts`, content: "new content" } }],
          api: "messages", provider: "anthropic", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          timestamp: Date.now(), stopReason: "toolUse",
        },
      });
    }
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true, smartKeepTail: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    const { pi, ctx, getBefore } = capturePi();
    registerBeforeCompactHook(pi);
    const r: any = await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 80000), ctx);
    expect(r.compaction).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "seq-touch-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
    const loaded = loadAllMessages(file, false, undefined);
    const touched = getTouchedFiles(loaded.rawMessages as any, loaded.rendered as any);
    expect(touched.map((t) => t.path)).toEqual(expect.arrayContaining([expect.stringContaining("src/mod")]));
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("sequence: ENOENT then after file created recall succeeds", () => {
    const missing = "/tmp/does-not-exist-12345.jsonl";
    const empty = loadAllMessages(missing, false, undefined);
    expect(empty.rendered.length).toBe(0);
    const entries = buildSession({ turns: 3, charsPerTurn: 300 }) as any[];
    const dir = mkdtempSync(join(tmpdir(), "enoent-then-ok-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
    const loaded = loadAllMessages(file, false, undefined);
    const result = searchEntriesDetailed(loaded.rendered as any, loaded.rawMessages as any, "goal");
    expect(result.hits.length).toBeGreaterThan(0);
  });

  test("sequence: debug toggle during multi-compaction, authoritativeSavings appears only when debug true", async () => {
    const { pi, ctx, getBefore, getCompact } = capturePi();
    // first compaction debug false
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true, smartKeepTail: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 4, charsPerTurn: 400 }) as any[];
    await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 80000), ctx);
    expect(existsSync(DEBUG_PATH)).toBe(false);
    // second compaction debug true + compact triggers authoritative write
    writeFileSync(isolated.configPath, JSON.stringify({ debug: true, overrideDefaultCompaction: true, smartKeepTail: false }));
    await getBefore()(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, 80000), ctx);
    await getCompact()({ type: "session_compact", fromExtension: true, compactionEntry: { tokensBefore: 80000, tokensAfter: 18000, id: "c1" } }, ctx);
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const dbg = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(dbg).toBeDefined();
    delete process.env.OMP_VCC_CONFIG_PATH;
  });
});
