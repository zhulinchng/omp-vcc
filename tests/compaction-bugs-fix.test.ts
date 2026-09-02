// @ts-nocheck
import { describe, test, expect, beforeEach } from "bun:test";
import {
  formatCompactionStats,
  formatStatsTable,
  formatLastStatsDetail,
  getLastCompactionStats,
  getCompactionHistory,
  clearCompactionHistoryForTests,
  registerBeforeCompactHook,
  registerVccStatsTool,
  registerVccStatsCommand,
} from "../extensions/vcc-core/hook";

describe("bug fix: format fallbacks for undefined fields (seen after /omp-vcc with old details)", () => {
  beforeEach(() => clearCompactionHistoryForTests());

  test("formatCompactionStats with undefined kept/summarized shows 0 not undefined", () => {
    const stats: any = {
      tokensBefore: 10000,
      tokensAfter: 2000,
      tokensSaved: 8000,
      savedPercent: 80,
    };
    const out = formatCompactionStats(stats);
    expect(out).not.toContain("undefined");
    expect(out).toContain("kept 0/0 turns");
    expect(out).toContain("~0 tok");
    expect(out).toContain("summarized 0");
  });

  test("formatCompactionStats budgetCut with undefined keptTokensEst", () => {
    const stats: any = {
      budgetCut: "no_anchor",
      summarized: 5,
      tokensBefore: 10000,
      tokensAfter: 2000,
    };
    const out = formatCompactionStats(stats);
    expect(out).not.toContain("undefined");
    expect(out).toContain("~0 tok");
  });

  test("formatStatsTable with undefined fields", () => {
    const history: any[] = [
      { timestamp: Date.now() },
      {
        tokensBefore: 5000,
        tokensAfter: 1000,
        keptTokensEst: undefined,
        keptUserTurns: undefined,
        totalUserTurns: undefined,
        summarized: undefined,
      },
    ];
    const table = formatStatsTable(history as any);
    expect(table).not.toContain("undefined");
    expect(table).toContain("0/0 turns");
    expect(table).toContain("~0 tok");
  });

  test("formatLastStatsDetail with undefined fields", () => {
    const stats: any = {
      tokensBefore: 10000,
      timestamp: Date.now(),
    };
    const detail = formatLastStatsDetail(stats);
    expect(detail).not.toContain("undefined");
    expect(detail).toContain("0 msgs");
    expect(detail).toContain("0/0 turns");
  });
});

describe("bug fix: getLastCompactionStats per-pi isolation (was global only)", () => {
  beforeEach(() => clearCompactionHistoryForTests());

  test("per-pi lastStats isolation", async () => {
    const handlersA = new Map();
    const handlersB = new Map();
    const makePi = (handlers) => ({
      on: (n, h) => handlers.set(n, h),
      registerTool: () => {},
      registerCommand: () => {},
      zod: {
        object: (o) => o,
        string: () => ({ optional: () => ({ describe: () => {} }) }),
        number: () => ({ optional: () => ({ describe: () => {} }) }),
        boolean: () => ({ optional: () => ({ describe: () => {} }) }),
        enum: () => ({ optional: () => ({ describe: () => {} }) }),
        array: () => ({ optional: () => ({ describe: () => {} }) }),
      },
    });
    const piA: any = makePi(handlersA);
    const piB: any = makePi(handlersB);
    registerBeforeCompactHook(piA);
    registerBeforeCompactHook(piB);

    const branch = [
      { id: "m1", type: "message", message: { role: "user", content: "u1" } },
      { id: "m2", type: "message", message: { role: "assistant", content: "a1" } },
      { id: "m3", type: "message", message: { role: "user", content: "u2" } },
      { id: "m4", type: "message", message: { role: "assistant", content: "a2" } },
      { id: "m5", type: "message", message: { role: "user", content: "u3" } },
      { id: "m6", type: "message", message: { role: "assistant", content: "a3" } },
    ];
    const ctx = { ui: { notify: () => {} } } as any;
    const beforeA = handlersA.get("session_before_compact");
    const beforeB = handlersB.get("session_before_compact");
    await beforeA(
      { customInstructions: "__omp_vcc__", branchEntries: branch, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 50000 } },
      ctx,
    );
    expect(getLastCompactionStats(piA)!.tokensBefore).toBe(50000);
    expect(getLastCompactionStats(piB)).toBeNull();
    await beforeB(
      { customInstructions: "__omp_vcc__", branchEntries: branch, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 } },
      ctx,
    );
    expect(getLastCompactionStats(piB)!.tokensBefore).toBe(90000);
    expect(getLastCompactionStats(piA)!.tokensBefore).toBe(50000);
    expect(getLastCompactionStats()!.tokensBefore).toBe(90000);
    expect(getCompactionHistory(piA).length).toBe(1);
    expect(getCompactionHistory(piB).length).toBe(1);
    expect(getCompactionHistory().length).toBe(2);
  });

  test("clearCompactionHistoryForTests clears per-pi lastStats", async () => {
    const handlers = new Map();
    const pi: any = {
      on: (n, h) => handlers.set(n, h),
      registerTool: () => {},
      registerCommand: () => {},
      zod: {
        object: (o) => o,
        string: () => ({ optional: () => ({ describe: () => {} }) }),
        number: () => ({ optional: () => ({ describe: () => {} }) }),
        boolean: () => ({ optional: () => ({ describe: () => {} }) }),
        enum: () => ({ optional: () => ({ describe: () => {} }) }),
        array: () => ({ optional: () => ({ describe: () => {} }) }),
      },
    };
    registerBeforeCompactHook(pi);
    const before = handlers.get("session_before_compact");
    const ctx = { ui: { notify: () => {} } } as any;
    const branch = [
      { id: "m1", type: "message", message: { role: "user", content: "u1" } },
      { id: "m2", type: "message", message: { role: "assistant", content: "a1" } },
      { id: "m3", type: "message", message: { role: "user", content: "u2" } },
      { id: "m4", type: "message", message: { role: "assistant", content: "a2" } },
      { id: "m5", type: "message", message: { role: "user", content: "u3" } },
      { id: "m6", type: "message", message: { role: "assistant", content: "a3" } },
    ];
    await before(
      { customInstructions: "__omp_vcc__", branchEntries: branch, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 10000 } },
      ctx,
    );
    expect(getLastCompactionStats(pi)).not.toBeNull();
    clearCompactionHistoryForTests();
    expect(getLastCompactionStats(pi)).toBeNull();
    expect(getCompactionHistory(pi).length).toBe(0);
    expect(getLastCompactionStats()).toBeNull();
  });
});

describe("bug fix: vcc_stats per-pi (was global last)", () => {
  beforeEach(() => clearCompactionHistoryForTests());

  test("vcc_stats tool returns per-pi history, not global cross", async () => {
    const handlersA = new Map();
    const handlersB = new Map();
    const makePi = (handlers) => ({
      on: (n, h) => handlers.set(n, h),
      registerTool: (t) => handlers.set(`tool:${t.name}`, t),
      registerCommand: () => {},
      zod: {
        object: (o) => o,
        string: () => ({ optional: () => ({ describe: () => {} }) }),
        number: () => ({ optional: () => ({ describe: () => {} }) }),
        boolean: () => ({ optional: () => ({ describe: () => {} }) }),
        enum: () => ({ optional: () => ({ describe: () => {} }) }),
        array: () => ({ optional: () => ({ describe: () => {} }) }),
      },
    });
    const piA: any = makePi(handlersA);
    const piB: any = makePi(handlersB);
    registerBeforeCompactHook(piA);
    registerBeforeCompactHook(piB);
    registerVccStatsTool(piA);
    registerVccStatsTool(piB);
    const branch = [
      { id: "m1", type: "message", message: { role: "user", content: "u1" } },
      { id: "m2", type: "message", message: { role: "assistant", content: "a1" } },
      { id: "m3", type: "message", message: { role: "user", content: "u2" } },
      { id: "m4", type: "message", message: { role: "assistant", content: "a2" } },
      { id: "m5", type: "message", message: { role: "user", content: "u3" } },
      { id: "m6", type: "message", message: { role: "assistant", content: "a3" } },
    ];
    const ctx = { ui: { notify: () => {} } } as any;
    const beforeA = handlersA.get("session_before_compact");
    const beforeB = handlersB.get("session_before_compact");
    await beforeA({ customInstructions: "__omp_vcc__", branchEntries: branch, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 10000 } }, ctx);
    await beforeA({ customInstructions: "__omp_vcc__", branchEntries: branch, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 20000 } }, ctx);
    await beforeB({ customInstructions: "__omp_vcc__", branchEntries: branch, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 90000 } }, ctx);
    const toolA = handlersA.get("tool:vcc_stats");
    const toolB = handlersB.get("tool:vcc_stats");
    const resA = await toolA.execute("id", {}, null, null, null);
    const resB = await toolB.execute("id", {}, null, null, null);
    expect(resA.content[0].text).toContain("History");
    expect(resB.content[0].text).not.toContain("10.0k");
    expect(resA.content[0].text).toContain("10.0k");
    expect(resA.content[0].text).toContain("20.0k");
  });

  test("vcc-stats command per-pi", async () => {
    const handlersA = new Map();
    const handlersB = new Map();
    let outA = "";
    let outB = "";
    const makePi = (handlers, getOut) => ({
      on: (n, h) => handlers.set(n, h),
      registerTool: () => {},
      registerCommand: (name, def) => handlers.set(`cmd:${name}`, def),
      zod: {
        object: (o) => o,
        string: () => ({ optional: () => ({ describe: () => {} }) }),
        number: () => ({ optional: () => ({ describe: () => {} }) }),
        boolean: () => ({ optional: () => ({ describe: () => {} }) }),
        enum: () => ({ optional: () => ({ describe: () => {} }) }),
        array: () => ({ optional: () => ({ describe: () => {} }) }),
      },
      sendMessage: (msg) => { if (getOut) getOut(msg.content); },
    });
    const piA: any = makePi(handlersA, (c) => (outA = c));
    const piB: any = makePi(handlersB, (c) => (outB = c));
    registerBeforeCompactHook(piA);
    registerBeforeCompactHook(piB);
    registerVccStatsCommand(piA);
    registerVccStatsCommand(piB);
    const branch = [
      { id: "m1", type: "message", message: { role: "user", content: "u1" } },
      { id: "m2", type: "message", message: { role: "assistant", content: "a1" } },
      { id: "m3", type: "message", message: { role: "user", content: "u2" } },
      { id: "m4", type: "message", message: { role: "assistant", content: "a2" } },
      { id: "m5", type: "message", message: { role: "user", content: "u3" } },
      { id: "m6", type: "message", message: { role: "assistant", content: "a3" } },
    ];
    const ctx = { ui: { notify: () => {} } } as any;
    const beforeA = handlersA.get("session_before_compact");
    const beforeB = handlersB.get("session_before_compact");
    await beforeA({ customInstructions: "__omp_vcc__", branchEntries: branch, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 11111 } }, ctx);
    await beforeB({ customInstructions: "__omp_vcc__", branchEntries: branch, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 99999 } }, ctx);
    const cmdA = handlersA.get("cmd:vcc-stats");
    const cmdB = handlersB.get("cmd:vcc-stats");
    await cmdA.handler("", { ui: { notify: () => {} } });
    await cmdB.handler("", { ui: { notify: () => {} } });
    expect(outA).toContain("11.1k");
    expect(outB).toContain("100.0k");
    expect(outA).not.toContain("100.0k");
    expect(outB).not.toContain("11.1k");
  });
});
