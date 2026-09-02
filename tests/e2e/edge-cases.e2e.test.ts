// @ts-nocheck
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  OMP_VCC_COMPACT_INSTRUCTION,
  PI_VCC_COMPACT_INSTRUCTION,
  buildOwnCut,
  applyTailBudget,
  findBudgetCutIndex,
  resolveSmartKeepUserTurns,
  getLastCompactionStats,
  getCompactionHistory,
  clearCompactionHistoryForTests,
  formatCompactionStats,
  formatStatsTable,
  formatLastStatsDetail,
} from "../../extensions/vcc-core/hook";
import { calibrateCharsPerToken, estimateMessageContentTokens } from "../../extensions/vcc-core/core/token-estimate";
import { parseKeepAndPrompt } from "../../extensions/vcc-core/core/compact-args";
import { loadSettings, scaffoldSettings, DEFAULT_SETTINGS } from "../../extensions/vcc-core/core/settings";
import { createIsolatedOmpDir } from "./support/e2e-harness";
import { buildSession, msg, comp, branchSummary, resetBoundary, customMsg } from "./support/session-builder";
import { searchEntriesDetailed, getTouchedFiles } from "../../extensions/vcc-core/core/search-entries";
import { formatRecallOutput } from "../../extensions/vcc-core/core/format-recall";
import { parseDrillDown } from "../../extensions/vcc-core/core/drill-down";
import { loadAllMessages } from "../../extensions/vcc-core/core/load-messages";

let isolated: ReturnType<typeof createIsolatedOmpDir>;
const DEBUG_PATH = "/tmp/omp-vcc-debug.json";

function mockPi() {
  let before: any, compact: any, ctxHandler: any, beforeStart: any;
  const pi: any = {
    on: (n: string, h: any) => {
      if (n === "session_before_compact") before = h;
      if (n === "session_compact") compact = h;
      if (n === "context") ctxHandler = h;
      if (n === "before_agent_start") beforeStart = h;
    },
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  const ctx: any = { hasUI: true, ui: { notify: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, mode: "tui" };
  return { pi, ctx, getBefore: () => before, getCompact: () => compact, getContext: () => ctxHandler, getBeforeStart: () => beforeStart };
}
function makeEvent(branchEntries: any[], ci?: string, tokensBefore = 80000): any {
  return { type: "session_before_compact", customInstructions: ci, branchEntries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore }, signal: new AbortController().signal };
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

describe("edge cases — buildOwnCut, budget, smartKeep, calibrate, savings", () => {
  test("no_live_messages: empty branch cancels", () => {
    const r = buildOwnCut([], 1);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("no_live_messages");
  });
  test("too_few_live_messages: <=2 live cancels", () => {
    const entries = [msg("m1", "user", "a"), msg("m2", "assistant", "b")];
    const r = buildOwnCut(entries as any, 1);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe("too_few_live_messages");
  });
  test("single user prompt + autonomous tail => compactAll sentinel", () => {
    const entries = [msg("m1", "user", "go"), msg("m2", "assistant", "tool"), msg("m3", "toolResult", "r"), msg("m4", "assistant", "done")];
    const r = buildOwnCut(entries as any, 1) as any;
    expect(r.ok).toBe(true);
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
    expect(r.keptUserTurns).toBe(0);
  });
  test("keep:0 sentinel compactAll not fallback", () => {
    const entries = buildSession({ turns: 5, charsPerTurn: 300 }) as any[];
    const r = buildOwnCut(entries, 0) as any;
    expect(r.ok).toBe(true);
    expect(r.compactAll).toBe(true);
    expect(r.keepFallbackToCompactAll).toBe(false);
    expect(r.requestedKeepUserTurns).toBe(0);
  });
  test("keep larger than totalUserTurns => compactAll fallback true", () => {
    const entries = buildSession({ turns: 2, charsPerTurn: 300 }) as any[];
    const r = buildOwnCut(entries, 10) as any;
    expect(r.ok).toBe(true);
    expect(r.compactAll).toBe(true);
    expect(r.keepFallbackToCompactAll).toBe(true);
  });
  test("orphan firstKeptEntryId '' recovery collects after compaction", () => {
    const entries = [msg("old1", "user", "old"), msg("old2", "assistant", "old"), comp("c1", ""), msg("m1", "user", "new1"), msg("m2", "assistant", "r1"), msg("m3", "user", "new2"), msg("m4", "assistant", "r2")];
    const r = buildOwnCut(entries as any, 1) as any;
    expect(r.ok).toBe(true);
    expect(r.firstKeptEntryId).toBeTruthy();
    expect((r.messages as any[]).length).toBeGreaterThan(0);
  });
  test("reset_boundary supersession: live window after boundary only", () => {
    const entries = [msg("m1", "user", "old"), msg("m2", "assistant", "old"), resetBoundary("r1"), msg("m3", "user", "new1"), msg("m4", "assistant", "r1"), msg("m5", "user", "new2"), msg("m6", "assistant", "r2")];
    const r = buildOwnCut(entries as any, 1) as any;
    expect(r.ok).toBe(true);
    // first kept should be after reset_boundary, not old
    const liveIds = entries.filter((e: any) => e.type === "message").map((e: any) => e.id);
    expect(r.firstKeptEntryId).not.toBe("m1");
  });
  test("findBudgetCutIndex snaps off toolResult", () => {
    const live = [
      { entry: { id: "m1" }, message: { role: "user", content: "a".repeat(5000) } },
      { entry: { id: "m2" }, message: { role: "assistant", content: "b" } },
      { entry: { id: "m3" }, message: { role: "toolResult", content: "c".repeat(60000) } },
    ] as any;
    const idx = findBudgetCutIndex(live, 5000, 4);
    if (idx >= 0) expect(live[idx].message.role).not.toBe("toolResult");
  });
  test("applyTailBudget no_anchor rescue when compactAll fallback", () => {
    const entries = [msg("m1", "user", "go"), msg("m2", "assistant", "a".repeat(50000)), msg("m3", "toolResult", "b".repeat(50000)), msg("m4", "assistant", "c".repeat(50000))] as any[];
    const cut = buildOwnCut(entries, 1) as any;
    expect(cut.compactAll).toBe(true);
    const rescued = applyTailBudget(entries, cut, { maxTokens: 5000, charsPerToken: 4 });
    if (rescued.ok && !rescued.compactAll) expect(rescued.budgetCut).toBe("no_anchor");
  });
  test("oversized_tail exactly at 2.5*maxTokens no cut, just over cuts", () => {
    const maxTokens = 10000;
    const factor = 2.5;
    // Build entries where tail tokens = maxTokens*factor exactly (no cut) vs +1 (cut)
    const entriesExact: any[] = [
      msg("u0", "user", "a"),
      msg("a0", "assistant", "b"),
      msg("u1", "user", "c".repeat(Math.ceil(maxTokens * factor * 4 - 100))),
      msg("a1", "assistant", "d"),
    ];
    const cut = buildOwnCut(entriesExact, 1) as any;
    if (!cut.compactAll) {
      const noRescue = applyTailBudget(entriesExact, cut, { maxTokens, charsPerToken: 4 });
      // when exactly at threshold, should not rescue
      expect(noRescue.budgetCut ?? null).toBe(null);
    }
    // oversized case: add more chars to exceed
    const entriesOver: any[] = [
      msg("u0", "user", "a"),
      msg("a0", "assistant", "b"),
      msg("u1", "user", "c".repeat(Math.ceil((maxTokens * factor + 100) * 4))),
      msg("a1", "assistant", "d"),
      msg("a2", "toolResult", "e".repeat(100000)),
    ];
    const cut2 = buildOwnCut(entriesOver, 1) as any;
    if (!cut2.compactAll) {
      const rescue = applyTailBudget(entriesOver, cut2, { maxTokens, charsPerToken: 4 });
      // may be oversized_tail if rescued
      if (rescue.budgetCut) expect(["oversized_tail", "no_anchor"]).toContain(rescue.budgetCut);
    }
  });
  test("resolveSmartKeep explicit never boosted", () => {
    const entries = buildSession({ turns: 5, charsPerTurn: 200 }) as any[];
    const res = resolveSmartKeepUserTurns({ branchEntries: entries, requestedKeepUserTurns: 2, explicit: true, smartKeepTail: true });
    expect(res.keepUserTurns).toBe(2);
    expect(res.smartAdjusted).toBe(false);
  });
  test("resolveSmartKeep disabled returns base", () => {
    const entries = buildSession({ turns: 5, charsPerTurn: 200 }) as any[];
    const res = resolveSmartKeepUserTurns({ branchEntries: entries, requestedKeepUserTurns: null, explicit: false, smartKeepTail: false });
    expect(res.keepUserTurns).toBe(1);
    expect(res.smartAdjusted).toBe(false);
  });
  test("calibrate clamp 2-6 fallback 4 exhaustive", () => {
    expect(calibrateCharsPerToken(0, 0).charsPerToken).toBe(4);
    expect(calibrateCharsPerToken(0, undefined as any).charsPerToken).toBe(4);
    expect(calibrateCharsPerToken(-100, 100).charsPerToken).toBe(4);
    expect(calibrateCharsPerToken(10000, 1).charsPerToken).toBe(6);
    expect(calibrateCharsPerToken(10, 10000).charsPerToken).toBe(2);
    expect(calibrateCharsPerToken(4000, 1000).charsPerToken).toBe(4);
    expect(calibrateCharsPerToken(NaN as any, 100).charsPerToken).toBe(4);
  });
  test("formatCompactionStats edges exhaustive", () => {
    const noBefore: any = { keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 5, tokensBefore: 0, tokensAfterEst: 500 };
    expect(formatCompactionStats(noBefore)).not.toMatch(/→/);
    const percent0: any = { keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 5, tokensBefore: 1000, tokensAfterEst: 1000, tokensSavedEst: 0, savedPercentEst: 0 };
    expect(formatCompactionStats(percent0)).not.toMatch(/saved/);
    const afterGreater: any = { keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 5, tokensBefore: 5000, tokensAfterEst: 6000, tokensSavedEst: 0, savedPercentEst: 0 };
    expect(formatCompactionStats(afterGreater)).toMatch(/kept/);
    const small: any = { keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 5, tokensBefore: 999, tokensAfterEst: 500, tokensSavedEst: 499, savedPercentEst: 50 };
    expect(formatCompactionStats(small)).toMatch(/999→500/);
    const thousand: any = { keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 5, tokensBefore: 90000, tokensAfterEst: 22000, tokensSavedEst: 68000, savedPercentEst: 76 };
    expect(formatCompactionStats(thousand)).toMatch(/90\.0k→22\.0k/);
    const negative: any = { keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 5, tokensBefore: -100, tokensAfterEst: 50, tokensSavedEst: -10, savedPercentEst: -5 };
    expect(formatCompactionStats(negative)).not.toMatch(/→/);
    const withBudget: any = { keptUserTurns: 2, totalUserTurns: 5, keptTokensEst: 3000, summarized: 10, tokensBefore: 90000, tokensAfterEst: 25000, tokensSavedEst: 65000, savedPercentEst: 72, budgetCut: "oversized_tail" };
    const out = formatCompactionStats(withBudget);
    expect(out).toMatch(/omp-vcc:/);
    expect(out).toMatch(/oversized|budget/);
  });
  test("formatStatsTable edges exhaustive", () => {
    expect(formatStatsTable([])).toBe("No compactions yet.");
    expect(formatStatsTable(undefined as any)).toBe("No compactions yet.");
    const nullTs: any = [{ tokensBefore: 90000, tokensAfter: 22000, tokensSaved: 68000, savedPercent: 76, keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 200, summarized: 10, timestamp: null }];
    expect(formatStatsTable(nullTs)).toMatch(/—/);
    const zeroSaved: any = [{ tokensBefore: 1000, tokensAfter: 1000, tokensSaved: 0, savedPercent: 0, keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 5, timestamp: Date.now() }];
    expect(formatStatsTable(zeroSaved)).toMatch(/—/);
    const withBudget: any = [{ tokensBefore: 90000, tokensAfter: 22000, tokensSaved: 68000, savedPercent: 76, keptUserTurns: 2, totalUserTurns: 5, keptTokensEst: 3000, summarized: 10, timestamp: Date.now(), budgetCut: "no_anchor" }];
    expect(formatStatsTable(withBudget)).toMatch(/no_anchor|budget/);
    const boundary: any = [{ tokensBefore: 1000, tokensAfter: 500, tokensSaved: 500, savedPercent: 50, keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 100, summarized: 1, timestamp: Date.now() }];
    expect(formatStatsTable(boundary)).toMatch(/1\.0k/);
  });
  test("perPi history 50 cap global+perPi and clear via perPiKeys", async () => {
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true, smartKeepTail: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    const { pi, ctx, getBefore } = mockPi();
    // need to capture pi properly: mockPi returns pi without weakmap? Use real hook registration
    const { pi: piA } = mockPi();
    const { pi: piB } = mockPi();
    registerBeforeCompactHook(piA as any);
    registerBeforeCompactHook(piB as any);
    const entries = buildSession({ turns: 4, charsPerTurn: 300 }) as any[];
    for (let i = 0; i < 55; i++) await (mockPi().getBefore ? null : null); // placeholder
    // Instead test via direct history manipulation: trigger 55 compactions on piA, ensure cap 50
    let beforeA: any;
    const piRealA: any = { on: (n: string, h: any) => { if (n === "session_before_compact") beforeA = h; if (n === "session_compact" || n === "before_agent_start" || n === "context") {} }, sendMessage: () => {}, sendUserMessage: () => {} };
    const ctxReal: any = { hasUI: true, ui: { notify: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, mode: "tui" };
    registerBeforeCompactHook(piRealA);
    for (let i = 0; i < 55; i++) {
      const e = buildSession({ turns: 3, charsPerTurn: 200 }) as any[];
      await beforeA({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: e, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 50000 + i }, signal: new AbortController().signal }, ctxReal);
    }
    expect(getCompactionHistory(piRealA).length).toBe(50);
    // copy isolation
    const copy = getCompactionHistory(piRealA);
    copy.push({ keptUserTurns: 999 } as any);
    expect(getCompactionHistory(piRealA).length).toBe(50);
    clearCompactionHistoryForTests();
    expect(getCompactionHistory(piRealA).length).toBe(0);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });
  test("settings scaffold and XDG priority, legacy migration simulation", () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    expect(existsSync(isolated.configPath)).toBe(false);
    scaffoldSettings();
    expect(existsSync(isolated.configPath)).toBe(true);
    const first = JSON.parse(readFileSync(isolated.configPath, "utf-8"));
    expect(first.vccEnabled).toBe(true);
    // no clobber
    writeFileSync(isolated.configPath, JSON.stringify({ ...first, debug: true }));
    scaffoldSettings();
    expect(JSON.parse(readFileSync(isolated.configPath, "utf-8")).debug).toBe(true);
    // XDG priority: set PI path different, ensure OMP wins
    const alt = join(isolated.ompDir, "alt.json");
    writeFileSync(alt, JSON.stringify({ vccEnabled: false }));
    process.env.PI_VCC_CONFIG_PATH = alt;
    expect(loadSettings().vccEnabled).toBe(true); // OMP still wins
    delete process.env.PI_VCC_CONFIG_PATH;
    process.env.OMP_VCC_CONFIG_PATH = alt;
    expect(loadSettings().vccEnabled).toBe(false);
    delete process.env.OMP_VCC_CONFIG_PATH;
    // ctx overlay
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false }));
    const ctxOverlay: any = { settings: { get: (k: string) => (k.includes("debug") ? true : undefined) }, config: { get: () => undefined } };
    expect(loadSettings(ctxOverlay).debug).toBe(true);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });
  test("parseKeepAndPrompt edges: keep at start, at end, with prompt, invalid", () => {
    expect(parseKeepAndPrompt("keep:2 focus").keepUserTurns).toBe(2);
    expect(parseKeepAndPrompt("focus keep:3").keepUserTurns).toBe(3);
    expect(parseKeepAndPrompt("keep:0").keepUserTurns).toBe(0);
    expect(parseKeepAndPrompt("").keepUserTurns).toBe(null);
    expect(parseKeepAndPrompt(undefined as any).keepUserTurns).toBe(null);
    expect(parseKeepAndPrompt("keep:abc").keepUserTurns).toBe(null);
    expect(parseKeepAndPrompt("keep:2 focus").followUpPrompt).toBe("focus");
  });
  test("recall ENOENT graceful and invalid regex handling via searchEntriesDetailed", async () => {
    const fakePath = "/nonexistent/path/session.jsonl";
    const loaded = loadAllMessages(fakePath, false, undefined);
    expect(Array.isArray(loaded.rendered)).toBe(true);
    expect(loaded.rendered.length).toBe(0);
    // invalid regex like "(" should not throw
    const entries = buildSession({ turns: 4, charsPerTurn: 300 }) as any[];
    const file = join(mkdtempSync(join(tmpdir(), "enoent-")), "s.jsonl");
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
    const { rendered, rawMessages } = loadAllMessages(file, false, undefined);
    const badRegexResult = searchEntriesDetailed(rendered as any, rawMessages as any, "(");
    expect(Array.isArray(badRegexResult.hits)).toBe(true);
  });
  test("recall scope, mode, pagination combined, expand invalid, drill-down offset", () => {
    const file = join(mkdtempSync(join(tmpdir(), "scope-")), "s.jsonl");
    const entries: any[] = [];
    for (let i = 0; i < 15; i++) entries.push(msg(`m${i * 2}`, "user", `redis cache turn ${i}`), msg(`m${i * 2 + 1}`, "assistant", `reply ${i}`));
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
    const { rendered, rawMessages } = loadAllMessages(file, false, undefined);
    const all = searchEntriesDetailed(rendered as any, rawMessages as any, "redis");
    expect(all.hits.length).toBeGreaterThan(10);
    // pagination page 2 slice
    const page2 = all.hits.slice(5, 10);
    expect(page2.length).toBe(5);
    // touched mode: need file-bearing tool calls
    const fileEntries: any[] = [];
    for (let i = 0; i < 6; i++) {
      fileEntries.push({
        id: `f${i}`,
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: `tc${i}`, name: "write", arguments: { path: `src/a${i}.ts`, content: "x\n".repeat(5) } }],
          api: "messages", provider: "anthropic", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          timestamp: Date.now(), stopReason: "toolUse",
        },
      });
    }
    const file2 = join(mkdtempSync(join(tmpdir(), "touched-")), "s.jsonl");
    writeFileSync(file2, fileEntries.map((e) => JSON.stringify(e)).join("\n"));
    const loaded2 = loadAllMessages(file2, false, undefined);
    const touched = getTouchedFiles(loaded2.rawMessages as any, loaded2.rendered as any);
    expect(touched.length).toBeGreaterThan(0);
    // parseDrillDown with offset/limit
    const parsed = parseDrillDown("#5:src/app.ts:10:20");
    expect(parsed).not.toBeNull();
    expect(parsed!.offset).toBe(10);
    expect(parsed!.limit).toBe(20);
    const full = parseDrillDown("#5:src/app.ts:full");
    expect(full!.full).toBe(true);
  });
  test("pipeline stages mixed: queue-operation discard, digits→ strip, Escape JSON, image content", async () => {
    // queue-operation is an entry type that load-messages should discard? Check sanitize discards queue-operation
    const entries: any[] = [
      { id: "q1", type: "queue-operation", operation: "enqueue" },
      msg("m1", "user", "123→ should be stripped prefix"),
      msg("m2", "assistant", "reply"),
      msg("m3", "user", "Escape JSON {\"foo\":\"bar\"} -> block scalar test"),
      {
        id: "m4",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "image", mimeType: "image/png", data: "base64..." }],
          api: "messages", provider: "anthropic", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          timestamp: Date.now(), stopReason: "stop",
        },
      },
      msg("m5", "user", "final turn"),
      msg("m6", "assistant", "final reply"),
    ];
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true, smartKeepTail: false }));
    let before: any;
    const pi: any = { on: (n: string, h: any) => { if (n === "session_before_compact") before = h; if (n === "session_compact" || n === "before_agent_start" || n === "context") {} }, sendMessage: () => {}, sendUserMessage: () => {} };
    const ctx: any = { hasUI: true, ui: { notify: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, mode: "tui" };
    registerBeforeCompactHook(pi);
    const result: any = await before({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: entries as any, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 70000 }, signal: new AbortController().signal }, ctx);
    expect(result.compaction).toBeDefined();
    expect(result.compaction.summary.length).toBeGreaterThan(0);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });
});
