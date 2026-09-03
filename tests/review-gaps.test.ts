// @ts-nocheck
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildOwnCut, registerBeforeCompactHook, getLastCompactionStats } from "../extensions/vcc-core/hook";
import { loadAllMessages } from "../extensions/vcc-core/core/load-messages";
import { loadSettings } from "../extensions/vcc-core/core/settings";
import extension from "../extensions/main.ts";

let tmpDir: string;
let CONFIG_PATH: string;
const DEBUG_PATH = "/tmp/omp-vcc-debug.json";
const DEBUG_PI = "/tmp/pi-vcc-debug.json";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "review-gaps-"));
  CONFIG_PATH = join(tmpDir, "config.json");
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
});
afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  delete process.env.OMP_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
  if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  if (existsSync(DEBUG_PI)) unlinkSync(DEBUG_PI);
});
beforeEach(() => {
  if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  if (existsSync(DEBUG_PI)) unlinkSync(DEBUG_PI);
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
});
afterEach(() => {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  if (existsSync(DEBUG_PI)) unlinkSync(DEBUG_PI);
});

const msg = (id: string, role: string, content = "x") => ({ id, type: "message", message: { role, content: [{ type: "text", text: content }] } });
const comp = (id: string, firstKeptEntryId = "m1") => ({ id, type: "compaction", firstKeptEntryId });
const reset = (id: string) => ({ id, type: "reset_boundary" });

function createMockPi() {
  let beforeHandler: any, compactHandler: any, ctx: any;
  const notifyCalls: any[] = [];
  const userMessages: any[] = [];
  const customMessages: any[] = [];
  ctx = { hasUI: true, ui: { notify: (msg: string, level: string) => notifyCalls.push({ msg, level }) } };
  const pi: any = {
    on: (ev: string, h: any) => {
      if (ev === "session_before_compact") beforeHandler = h;
      if (ev === "session_compact") compactHandler = h;
    },
    sendUserMessage: (c: any) => userMessages.push(c),
    sendMessage: (m: any, o: any) => customMessages.push({ message: m, options: o }),
    registerTool: () => {},
    registerCommand: () => {},
    zod: { object: (o: any) => o, string: () => ({ optional: () => ({ describe: () => ({}) }), describe: () => ({}) }), array: () => ({ optional: () => ({}) }), number: () => ({ optional: () => ({}) }), enum: () => ({ optional: () => ({}) }) } as any,
  };
  return { pi, ctx, invokeBefore: (e: any) => beforeHandler(e, ctx), invokeCompact: (e: any) => compactHandler(e, ctx), notifyCalls, userMessages, customMessages };
}
function makeEvent(branchEntries: any[], customInstructions?: string, ctx: any = {}) {
  return { type: "session_before_compact", customInstructions, branchEntries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000, ...ctx.preparation }, signal: new AbortController().signal, ...ctx };
}
function setConfig(cfg: any) { writeFileSync(CONFIG_PATH, JSON.stringify(cfg)); }

describe("review gaps: reset_boundary", () => {
  test("pre-clear history not resurrected into summary", () => {
    const branch = [msg("m1", "user", "old"), msg("m2", "assistant", "old2"), reset("r1"), msg("m3", "user", "new1"), msg("m4", "assistant", "new2"), msg("m5", "user", "new3")];
    const cut = buildOwnCut(branch, 1);
    expect(cut.ok).toBe(true);
    if (cut.ok && !cut.compactAll) {
      const texts = cut.messages.map((m: any) => m.content[0].text);
      expect(texts).not.toContain("old");
      expect(texts).toEqual(["new1", "new2"]);
      expect(cut.firstKeptEntryId).toBe("m5");
    }
  });
  test("reset after compaction supersedes it", () => {
    const branch = [msg("a1", "user", "old1"), msg("a2", "assistant", "old2"), comp("c1", "a2"), msg("b1", "user", "keep1"), reset("r1"), msg("c1m", "user", "new1"), msg("c2m", "assistant", "new2"), msg("c3m", "user", "new3")];
    const cut = buildOwnCut(branch, 1);
    expect(cut.ok).toBe(true);
    if (cut.ok && !cut.compactAll) {
      const texts = cut.messages.map((m: any) => m.content[0].text);
      expect(texts).not.toContain("old1");
      expect(texts).not.toContain("keep1");
      expect(texts).toEqual(["new1", "new2"]);
    }
  });
  test("reset before compaction is ignored (superseded)", () => {
    const branch = [msg("a1", "user", "old"), reset("r1"), msg("b1", "user", "mid"), comp("c1", "b1"), msg("c1m", "user", "after1"), msg("c2m", "assistant", "after2"), msg("c3m", "user", "after3")];
    const cut = buildOwnCut(branch, 1);
    expect(cut.ok).toBe(true);
    if (cut.ok && !cut.compactAll) {
      const texts = cut.messages.map((m: any) => m.content[0].text);
      expect(texts).toContain("mid");
      expect(texts).not.toContain("old");
    }
  });
  test("multiple resets: latest after compaction wins", () => {
    const branch = [msg("m1", "user", "a"), reset("r1"), msg("m2", "user", "b"), reset("r2"), msg("m3", "user", "c"), msg("m4", "assistant", "d"), msg("m5", "user", "e")];
    const cut = buildOwnCut(branch, 1);
    expect(cut.ok).toBe(true);
    if (cut.ok && !cut.compactAll) {
      const texts = cut.messages.map((m: any) => m.content[0].text);
      expect(texts).not.toContain("a");
      expect(texts).not.toContain("b");
      expect(texts).toContain("c");
    }
  });
  test("keep:0 after reset compacts all live after reset only", () => {
    const branch = [msg("m1", "user", "old"), reset("r1"), msg("m2", "user", "u1"), msg("m3", "assistant", "a1"), msg("m4", "user", "u2")];
    const cut = buildOwnCut(branch, 0);
    expect(cut.ok).toBe(true);
    if (cut.ok) {
      expect(cut.compactAll).toBe(true);
      expect(cut.messages.length).toBe(3);
      const texts = cut.messages.map((m: any) => m.content[0].text);
      expect(texts).not.toContain("old");
    }
  });
});

describe("review gaps: loadMessages ENOENT", () => {
  test("missing file returns empty gracefully", () => {
    const res = loadAllMessages("/tmp/does-not-exist-omp-vcc-enoent.jsonl", false);
    expect(res.rendered).toEqual([]);
    expect(res.rawMessages).toEqual([]);
  });
  test("missing file with lineage filter also returns empty", () => {
    const res = loadAllMessages("/tmp/does-not-exist-omp-vcc-enoent2.jsonl", true, new Set(["m1"]));
    expect(res.rendered).toEqual([]);
  });
  test("vcc_recall tool does not throw on missing session file", () => {
    const res = loadAllMessages("/tmp/nonexistent-session.jsonl", false);
    expect(res.rendered.length).toBe(0);
  });
});

describe("review gaps: approval tier", () => {
  test("vcc_recall registers with approval read", () => {
    const captured: any[] = [];
    const z: any = () => ({ optional: () => ({ describe: () => z(), optional: () => z() }), describe: () => z() });
    const mockZod: any = { object: z, string: z, number: z, array: z, enum: z };
    const mockPi: any = {
      zod: mockZod,
      registerTool: (def: any) => captured.push(def),
      registerCommand: () => {},
      on: () => {},
    };
    (extension as any)(mockPi);
    const tool = captured.find((t) => t.name === "vcc_recall");
    expect(tool).toBeDefined();
    expect(tool.approval).toBe("read");
  });
});

describe("review gaps: manifest overlay", () => {
  test("loadSettings overlays ctx.settings", () => {
    setConfig({ vccEnabled: true, overrideDefaultCompaction: true, smartKeepTail: true, continueAfterThresholdCompact: true, debug: false });
    const withCtx = loadSettings({ settings: { get: (k: string) => k === "plugins.@zhulinchng/omp-vcc.debug" ? true : undefined } } as any);
    expect(withCtx.debug).toBe(true);
    const withoutCtx = loadSettings();
    expect(withoutCtx.debug).toBe(false);
  });
  test("loadSettings without ctx returns file", () => {
    setConfig({ vccEnabled: false });
    const s = loadSettings();
    expect(s.vccEnabled).toBe(false);
  });
});

describe("review gaps: fallback heuristic", () => {
  test("small manual /compact with too_few and undefined reason cancels (no fallback)", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    const res = invokeBefore(makeEvent(entries, undefined, { preparation: { tokensBefore: 1000 } }));
    expect(res).toEqual({ cancel: true });
  });
  test("large overflow heuristic with undefined reason falls back (no cancel)", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    const res = invokeBefore(makeEvent(entries, undefined, { preparation: { tokensBefore: 80000 } }));
    expect(res).toBeUndefined();
  });
  test("explicit overflow with willRetry always falls back regardless of size", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    const res = invokeBefore(makeEvent(entries, undefined, { reason: "overflow", willRetry: true, preparation: { tokensBefore: 1000 } }));
    expect(res).toBeUndefined();
  });
});

describe("review gaps: cross-session isolation", () => {
  test("per-pi state isolated for follow-up prompt", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const a = createMockPi();
    const b = createMockPi();
    registerBeforeCompactHook(a.pi);
    registerBeforeCompactHook(b.pi);
    const entriesA = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    const entriesB = [msg("n1", "user"), msg("n2", "assistant"), msg("n3", "user"), msg("n4", "assistant")];
    const resA = a.invokeBefore({ type: "session_before_compact", customInstructions: "__omp_vcc__ keep:1", branchEntries: entriesA, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 }, signal: new AbortController().signal });
    expect(resA.compaction).toBeDefined();
    // keep:2 with 2 users keeps the whole tail; with no previous summary there
    // is nothing new to summarize -> cancel, session intact.
    const resB = b.invokeBefore({ type: "session_before_compact", customInstructions: "__omp_vcc__ keep:2", branchEntries: entriesB, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 }, signal: new AbortController().signal });
    expect(resB.compaction).toBeUndefined();
    expect(resB.cancel).toBe(true);
    expect(b.notifyCalls.some((n: any) => n.msg.includes("Nothing new to compact"))).toBe(true);
    // Isolation intact: B's cancel did not corrupt A's compaction.
    expect(resA.compaction.firstKeptEntryId).toBe("m3");
  });

  test("explicit keep-all with a previous summary keeps the tail", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const b = createMockPi();
    registerBeforeCompactHook(b.pi);
    const entriesB = [msg("n1", "user"), msg("n2", "assistant"), msg("n3", "user"), msg("n4", "assistant")];
    const resB = b.invokeBefore({ type: "session_before_compact", customInstructions: "__omp_vcc__ keep:2", branchEntries: entriesB, preparation: { previousSummary: "[Session Goal]\n- Old goal\n\n---\n\nold brief", fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 }, signal: new AbortController().signal });
    expect(resB.compaction).toBeDefined();
    expect(resB.compaction.firstKeptEntryId).toBe("n1");
    expect(resB.compaction.summary).toContain("Old goal");
  });
});
