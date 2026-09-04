// @ts-nocheck
// User-interaction cancel/edge coverage: every path where the user (or the
// host on their behalf) meets a cancel, a failure notice, or a swallowed
// error across the main-factory commands (/omp-vcc, /pi-vcc, /vcc-recall,
// /pi-vcc-recall, /vcc-stats, vcc_stats), the vcc_recall tool inputs, and the
// hook's session_compact + before_compact cancel edges.
// Complements tests/dispatch-gaps.test.ts (happy paths) — nothing here
// overlaps it: each test needs a throw, a rejection, a missing function, a
// boundary value, or a divergent branch.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import extension from "../extensions/main.ts";
import {
  registerBeforeCompactHook,
  getLastCompactionStats,
  scheduleCompactionStatsNotify,
  OMP_VCC_COMPACT_INSTRUCTION,
} from "../extensions/vcc-core/hook";

// ── Factory harness (local builders; mirrors dispatch-gaps shape) ──
const chain: any = { optional: () => chain, describe: () => chain };
const mockZod: any = {
  object: (o: any) => o,
  boolean: () => chain,
  string: () => chain,
  array: (_a: any) => chain,
  number: () => chain,
  enum: (_a: any) => chain,
};

function makePi(opts: { sendUserMessage?: any } = {}) {
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const sent: Array<{ msg: any; opts: any }> = [];
  const userSent: any[] = [];
  const pi: any = {
    on: () => {},
    registerTool: (t: any) => tools.push(t),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    zod: mockZod,
    sendMessage: (msg: any, op: any) => sent.push({ msg, opts: op }),
    ...(opts.sendUserMessage === null ? {} : { sendUserMessage: opts.sendUserMessage ?? (async (c: any) => userSent.push(c)) }),
  };
  (extension as any)(pi);
  return { pi, tools, commands, sent, userSent };
}

let dirCount = 0;
const umsg = (id: string, content: string) => ({
  type: "message", id, message: { role: "user", content },
});
function makeSession(entries: any[]) {
  const dir = mkdtempSync(join(tmpdir(), `user-cancel-${dirCount++}-`));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  const ids = entries.map((e) => e.id);
  return { dir, file, ids };
}
const toolCtx = (file: string, branch: string[], all?: string[]) => ({
  sessionManager: {
    getSessionFile: () => file,
    getBranch: () => branch.map((id) => ({ id })),
    getEntries: () => (all ?? branch).map((id) => ({ id })),
  },
});
const cmdCtx = (file: string, ids: string[], notify: any[]) => ({
  sessionManager: {
    getSessionFile: () => file,
    getBranch: () => ids.map((id) => ({ id })),
    getEntries: () => ids.map((id) => ({ id })),
  },
  ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
});
async function toolText(tool: any, params: any, ctx: any) {
  const res = await tool.execute("tc", params, undefined, undefined, ctx);
  return res.content[0].text as string;
}

// ── Hook harness (isolated config) ──
let tmpDir: string;
let CONFIG_PATH: string;
let origOmp: string | undefined;
let origPi: string | undefined;
const T = Date.now();
const hmsg = (id: string, role: string, text = "content"): any => ({
  id, type: "message", message: { role, content: text, timestamp: T },
});
const fourMsgs = (): any[] => [
  hmsg("m1", "user", "goal one"), hmsg("m2", "assistant", "did one"),
  hmsg("m3", "user", "goal two"), hmsg("m4", "assistant", "did two"),
];
const beforeEvent = (entries: any[], customInstructions: any, tokensBefore = 90000, extra: any = {}) => ({
  type: "session_before_compact",
  customInstructions,
  branchEntries: entries,
  preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore },
  signal: new AbortController().signal,
  ...extra,
});
function makeHookPi(chainHint: boolean) {
  let beforeHandler: any;
  let compactHandler: any;
  const notifyCalls: any[] = [];
  const userMessages: any[] = [];
  const pi: any = {
    on: (n: string, h: any) => { if (n === "session_before_compact") beforeHandler = h; if (n === "session_compact") compactHandler = h; },
    sendMessage: () => {},
    sendUserMessage: async (c: any) => userMessages.push(c),
  };
  registerBeforeCompactHook(pi);
  const ctx: any = {
    settings: { get: () => undefined },
    config: { get: () => undefined },
    ui: { notify: (m: string, l: string) => notifyCalls.push({ msg: m, level: l }) },
  };
  return { pi, ctx, notifyCalls, userMessages, before: (e: any, c = ctx) => beforeHandler(e, c), compact: (e: any, c = ctx) => compactHandler(e, c) };
}
const setCfg = (extra: any = {}) => writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ vccEnabled: true, overrideDefaultCompaction: true, smartKeepTail: false, debug: false, continueAfterThresholdCompact: false, chainShakeHint: false, ...extra }),
);

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vcc-user-cancel-"));
  CONFIG_PATH = join(tmpDir, "config.json");
  origOmp = process.env.OMP_VCC_CONFIG_PATH;
  origPi = process.env.PI_VCC_CONFIG_PATH;
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
  setCfg();
});
afterAll(() => {
  if (origOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH; else process.env.OMP_VCC_CONFIG_PATH = origOmp;
  if (origPi === undefined) delete process.env.PI_VCC_CONFIG_PATH; else process.env.PI_VCC_CONFIG_PATH = origPi;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("user interaction: /omp-vcc failure and notify edges", () => {
  test("throwing pre-notify is swallowed and compact still runs", async () => {
    const { commands } = makePi();
    let compactCalled = false;
    await commands.get("omp-vcc").handler("", {
      compact: async () => { compactCalled = true; },
      ui: { notify: () => { throw new Error("ui down"); } },
    });
    expect(compactCalled).toBe(true);
  });

  test("non-Error compact throws surface via String(err)", async () => {
    for (const [thrown, text] of [["boom", "Compaction failed: boom"], [undefined, "Compaction failed: undefined"]] as any[]) {
      const { commands } = makePi();
      const notify: any[] = [];
      await commands.get("omp-vcc").handler("", {
        compact: async () => { throw thrown; },
        ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
      });
      expect(notify.some((n) => n.msg === text && n.level === "error")).toBe(true);
    }
  });

  test("missing sendUserMessage skips follow-up without crashing", async () => {
    const { commands, userSent } = makePi({ sendUserMessage: null });
    const notify: any[] = [];
    let compactCalled = false;
    await commands.get("omp-vcc").handler("fix auth", {
      compact: async () => { compactCalled = true; },
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(compactCalled).toBe(true);
    expect(userSent).toHaveLength(0);
    expect(notify.some((n) => n.msg.includes("Compacted with omp-vcc"))).toBe(true);
  });

  test("rejecting sendUserMessage is swallowed after the stats toast", async () => {
    const { commands, userSent } = makePi({
      sendUserMessage: async () => { throw new Error("gone"); },
    });
    const notify: any[] = [];
    await commands.get("omp-vcc").handler("fix auth", {
      compact: async () => {},
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(userSent).toHaveLength(0);
    expect(notify.some((n) => n.msg.includes("Compacted with omp-vcc"))).toBe(true);
  });

  test("/omp-vcc pre-notifies keep:0 with focus; /pi-vcc has no pre-notify", async () => {
    const { commands } = makePi();
    const ompNotify: any[] = [];
    const piNotify: any[] = [];
    let ompArg: any = null;
    await commands.get("omp-vcc").handler("keep:0 redo auth", {
      compact: async (arg: any) => { ompArg = arg; },
      ui: { notify: (msg: string, level?: string) => ompNotify.push({ msg, level }) },
    });
    expect(String(ompArg)).toContain("keep:0");
    expect(ompNotify[0].msg).toBe("omp-vcc: compacting with keep:0 + focus...");
    await commands.get("pi-vcc").handler("", {
      compact: async () => {},
      ui: { notify: (msg: string, level?: string) => piNotify.push({ msg, level }) },
    });
    expect(piNotify.map((n) => n.msg)).toEqual(["Compacted with pi-vcc (via omp-vcc)"]);
  });

  test("/pi-vcc Already compacted maps to nothing-to-compact", async () => {
    const { commands } = makePi();
    const notify: any[] = [];
    await commands.get("pi-vcc").handler("", {
      compact: async () => { throw new Error("Already compacted"); },
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(notify.some((n) => n.msg === "Nothing to compact" && n.level === "warning")).toBe(true);
  });
  test("/pi-vcc-recall out-of-range page guides with alias syntax", async () => {
    // Parity with /vcc-recall: a page past the end names the valid range and
    // the alias command (not a false "No matches"), using /pi-vcc-recall
    // syntax since that is what the user typed.
    const entries = Array.from({ length: 7 }, (_, i) => umsg(`m${i}`, `zebra_oor entry number ${i}`));
    const { dir, file, ids } = makeSession(entries);
    try {
      const { commands, sent } = makePi();
      const notify: any[] = [];
      await commands.get("pi-vcc-recall").handler("zebra_oor page:5", cmdCtx(file, ids, notify));
      expect(sent.length).toBe(1);
      expect(sent[0].msg.content).toContain("Page 5 is outside the available range 1-2");
      expect(sent[0].msg.content).toContain("7 matches");
      expect(sent[0].msg.content).not.toContain("No matches");
      expect(sent[0].msg.content).toContain("/pi-vcc-recall");
      expect(sent[0].msg.content).toContain("page:N");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("/pi-vcc-recall truncated out-of-range guidance does not repeat refine", async () => {
    // 60 raw matches capped to 50 → pages 1-10. Page 11 guidance must not
    // repeat the "refine your query" the truncation note already gave.
    const entries = Array.from({ length: 60 }, (_, i) => umsg(`m${i}`, `zebra_trunc entry number ${i}`));
    const { dir, file, ids } = makeSession(entries);
    try {
      const { commands, sent } = makePi();
      const notify: any[] = [];
      await commands.get("pi-vcc-recall").handler("zebra_trunc.*entry page:11", cmdCtx(file, ids, notify));
      expect(sent.length).toBe(1);
      expect(sent[0].msg.content).toContain("Page 11 is outside the available range 1-10");
      expect(sent[0].msg.content).toContain("/pi-vcc-recall");
      expect(sent[0].msg.content.match(/refine your query/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("/vcc-recall still notifies hit count when sendMessage throws", async () => {
    const entries = Array.from({ length: 7 }, (_, i) => umsg(`m${i}`, `zebra_hit entry number ${i}`));
    const { dir, file, ids } = makeSession(entries);
    try {
      const { commands, sent, pi } = makePi();
      pi.sendMessage = () => { throw new Error("display down"); };
      const notify: any[] = [];
      await commands.get("vcc-recall").handler("zebra_hit", cmdCtx(file, ids, notify));
      expect(sent.length).toBe(0);
      expect(notify.some((n) => n.msg === "vcc_recall: 7 hits")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("/vcc-recall page:0 clamps to page 1", async () => {
    const entries = Array.from({ length: 7 }, (_, i) => umsg(`m${i}`, `zebra_p0 entry number ${i}`));
    const { dir, file, ids } = makeSession(entries);
    try {
      const { commands, sent } = makePi();
      const notify: any[] = [];
      await commands.get("vcc-recall").handler("zebra_p0 page:0", cmdCtx(file, ids, notify));
      expect(sent[0].msg.content).toContain("Page 1/2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tool scope:active is treated as lineage", async () => {
    const { dir, file, ids } = makeSession([umsg("m0", "alpha one"), umsg("m1", "off lineage secret")]);
    try {
      const { tools } = makePi();
      const tool = tools.find((t) => t.name === "vcc_recall");
      const err = await toolText(tool, { query: "#1", scope: "active" }, toolCtx(file, ["m0"], ids));
      expect(err).toContain("Cannot expand indices outside active lineage: 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tool expand with non-integer index names it invalid", async () => {
    const { dir, file, ids } = makeSession([umsg("m0", "alpha one"), umsg("m1", "alpha two")]);
    try {
      const { tools } = makePi();
      const tool = tools.find((t) => t.name === "vcc_recall");
      const out = await toolText(tool, { expand: [1.5] }, toolCtx(file, ids));
      expect(out).toContain("Cannot expand indices");
      expect(out).toContain("1.5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tool whitespace-only query falls back to recent", async () => {
    const { dir, file, ids } = makeSession([umsg("m0", "first tail"), umsg("m1", "second tail")]);
    try {
      const { tools } = makePi();
      const tool = tools.find((t) => t.name === "vcc_recall");
      const out = await toolText(tool, { query: "   " }, toolCtx(file, ids));
      expect(out).toContain("second tail");
      expect(out).not.toContain("matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("user interaction: stats surface edges", () => {
  function makeFullPi() {
    const tools: any[] = [];
    const commands = new Map<string, any>();
    const handlers = new Map<string, any>();
    const sent: Array<{ msg: any; opts: any }> = [];
    const pi: any = {
      on: (n: string, h: any) => handlers.set(n, h),
      registerTool: (t: any) => tools.push(t),
      registerCommand: (name: string, def: any) => commands.set(name, def),
      zod: mockZod,
      sendMessage: (msg: any, opts: any) => sent.push({ msg, opts }),
      sendUserMessage: async () => {},
    };
    (extension as any)(pi);
    return { pi, tools, commands, handlers, sent };
  }

  test("/vcc-stats substring all triggers history; clean word shows detail", async () => {
    setCfg();
    const { pi, commands, handlers, sent } = makeFullPi();
    const before = handlers.get("session_before_compact");
    expect(before).toBeDefined();
    const hookCtx: any = {
      settings: { get: () => undefined },
      config: { get: () => undefined },
      ui: { notify: () => {} },
    };
    for (const pfx of ["s1", "s2"]) {
      const entries = [hmsg(`${pfx}1`, "user", "goal one"), hmsg(`${pfx}2`, "assistant", "did one"), hmsg(`${pfx}3`, "user", "goal two"), hmsg(`${pfx}4`, "assistant", "did two")];
      const r: any = await before(beforeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION), hookCtx);
      expect(r?.compaction).toBeDefined();
    }
    const notify: any[] = [];
    // "small" contains "all" -> history table; "latest" contains neither
    await commands.get("vcc-stats").handler("small", { ui: { notify: (m: string, l: string) => notify.push(m) } });
    expect(sent.length).toBe(1);
    expect(sent[0].msg.content.startsWith("| # |")).toBe(true);
    expect(sent[0].msg.content).toContain("Last compaction");
    expect(sent[0].msg.content).not.toContain("History (2 compactions):");
    sent.length = 0;
    await commands.get("vcc-stats").handler("latest", { ui: { notify: (m: string, l: string) => notify.push(m) } });
    expect(sent[0].msg.content).toContain("History (2 compactions):");
    expect(notify.some((m) => m.includes("2 compaction(s)"))).toBe(true);
  });

  test("scheduleCompactionStatsNotify swallows a throwing notify", async () => {
    scheduleCompactionStatsNotify({ ui: { notify: () => { throw new Error("toast down"); } } }, {
      summarized: 10, kept: 2, keptUserTurns: 1, totalUserTurns: 5, keptTokensEst: 2100,
      tokensBefore: 90000, tokensAfterEst: 22000, tokensSavedEst: 68000, savedPercentEst: 76,
    } as any);
    await new Promise((r) => setTimeout(r, 650));
  });

  test("vcc_stats tool with history:true and no history reports none yet", async () => {
    const { tools } = makePi();
    const tool = tools.find((t) => t.name === "vcc_stats");
    const res = await tool.execute("id", { history: true }, null, null, {});
    expect(res.content[0].text).toContain("No compactions yet");
  });
});

describe("user interaction: session_compact cancel and chain edges", () => {
  test("session_compact with no prior stats stays silent", async () => {
    setCfg();
    const h = makeHookPi(false);
    await h.compact({ type: "session_compact", fromExtension: true, compactionEntry: { id: "c1", tokensBefore: 90000, tokensAfter: 20000 } });
    expect(h.notifyCalls).toHaveLength(0);
    expect(h.userMessages).toHaveLength(0);
  });

  test("chainShake compact rejection is swallowed after one attempt", async () => {
    // Seed via the threshold proxy (no sentinel): sentinel compactions set
    // lastCompactWasPiVcc, which ends session_compact before the chain block.
    setCfg({ chainShakeHint: true });
    const h = makeHookPi(true);
    const r: any = await h.before(beforeEvent(fourMsgs(), undefined));
    expect(r?.compaction).toBeDefined();
    let shakeCalls = 0;
    await h.compact(
      { type: "session_compact", fromExtension: true, compactionEntry: { id: "c1", tokensBefore: 90000, tokensAfter: 20000 } },
      { ...h.ctx, compact: () => { shakeCalls++; return Promise.reject(new Error("shake down")); } },
    );
    await new Promise((r2) => setTimeout(r2, 20));
    expect(shakeCalls).toBe(1);
  });

  test("chainShake sync-throwing compact is swallowed", async () => {
    setCfg({ chainShakeHint: true });
    const h = makeHookPi(true);
    await h.before(beforeEvent(fourMsgs(), undefined));
    let shakeCalls = 0;
    await h.compact(
      { type: "session_compact", fromExtension: true, compactionEntry: { id: "c1", tokensBefore: 90000, tokensAfter: 20000 } },
      { ...h.ctx, compact: () => { shakeCalls++; throw new Error("sync down"); } },
    );
    expect(shakeCalls).toBe(1);
  });

  test("double session_compact chains shake only once (pending guard)", async () => {
    setCfg({ chainShakeHint: true });
    const h = makeHookPi(true);
    await h.before(beforeEvent(fourMsgs(), undefined));
    let shakeCalls = 0;
    const evt = { type: "session_compact", fromExtension: true, compactionEntry: { id: "c1", tokensBefore: 90000, tokensAfter: 20000 } };
    const ctx = { ...h.ctx, compact: () => { shakeCalls++; return Promise.resolve(); } };
    await h.compact(evt, ctx);
    await h.compact(evt, ctx);
    expect(shakeCalls).toBe(1);
  });

  test("session_compact delivers the pending follow-up prompt", async () => {
    setCfg();
    const h = makeHookPi(false);
    const r: any = await h.before(beforeEvent(fourMsgs(), "do the followup thing"));
    expect(r?.compaction).toBeDefined();
    await h.compact({ type: "session_compact", fromExtension: true, compactionEntry: { id: "c1", tokensBefore: 90000, tokensAfter: 20000 } });
    expect(h.userMessages).toEqual(["do the followup thing"]);
  });

  test("session_compact swallows a rejecting follow-up send", async () => {
    setCfg();
    const h = makeHookPi(false);
    h.pi.sendUserMessage = async () => { throw new Error("send down"); };
    await h.before(beforeEvent(fourMsgs(), "do the followup thing"));
    await h.compact({ type: "session_compact", fromExtension: true, compactionEntry: { id: "c1", tokensBefore: 90000, tokensAfter: 20000 } });
    expect(h.notifyCalls.length).toBeGreaterThanOrEqual(0);
  });
});

describe("user interaction: before_compact overflow-heuristic boundary", () => {
  const two = (): any[] => [hmsg("u0", "user", "hi"), hmsg("a0", "assistant", "hello")];

  test("tokensBefore at exactly 50000 cancels with the reason notice", async () => {
    setCfg();
    const h = makeHookPi(false);
    const result: any = await h.before(beforeEvent(two(), undefined, 50000));
    expect(result).toEqual({ cancel: true });
    expect(h.notifyCalls).toEqual([{ msg: "omp-vcc: Too few messages to compact", level: "warning" }]);
  });

  test("tokensBefore at 50001 defers to host (void)", async () => {
    setCfg();
    const h = makeHookPi(false);
    const result: any = await h.before(beforeEvent(two(), undefined, 50001));
    expect(result).toBeUndefined();
    expect(h.notifyCalls).toHaveLength(0);
  });

  test("throwing cancel notice still cancels", async () => {
    setCfg();
    const h = makeHookPi(false);
    h.ctx.ui.notify = () => { throw new Error("ui down"); };
    const result: any = await h.before(beforeEvent(two(), undefined, 50000));
    expect(result).toEqual({ cancel: true });
  });
});
