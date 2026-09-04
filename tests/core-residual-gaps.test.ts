// @ts-nocheck
// Residual gap coverage for core modules: each test pins one uncovered branch
// (verified against current file content). No overlap with existing suites —
// sibling workers own preferences/dispatch/drill-down; content.test.ts never
// exercises clip/clipSentence/snippet/firstLine; no test touches shortPath
// or summarizeToolArgs. Recall/command gap tests run through the factory
// (the single production registrar).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, unlinkSync } from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname } from "path";
import { clip, clipSentence, firstLine, extractToolCallArgsText, snippet } from "../extensions/vcc-core/core/content.ts";
import { compile } from "../extensions/vcc-core/core/summarize.ts";
import { searchEntries, searchEntriesDetailed } from "../extensions/vcc-core/core/search-entries.ts";
import { scaffoldSettings, DEFAULT_SETTINGS } from "../extensions/vcc-core/core/settings.ts";
import { extractPath, summarizeToolArgs } from "../extensions/vcc-core/core/tool-args.ts";
import { compileBrief } from "../extensions/vcc-core/core/brief.ts";
import { shortPath } from "../extensions/vcc-core/core/format-recall.ts";
import {
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
} from "../extensions/vcc-core/hook.ts";
import extension from "../extensions/main.ts";
import { userMsg } from "./fixtures.ts";
import { makeMockApi, makeMockCtx } from "./helpers.ts";

const chain: any = { optional: () => chain, describe: () => chain };
const mockZod: any = {
  object: (o: any) => o,
  boolean: () => chain,
  string: () => chain,
  array: (_a: any) => chain,
  number: () => chain,
  enum: (_a: any) => chain,
};
const makeFactoryPi = (capture: { tool?: any; commands?: Map<string, any>; sent?: any[] }) => {
  const commands = new Map<string, any>();
  const sent: any[] = [];
  (extension as any)({
    on: () => {},
    registerTool: (t: any) => { if (t.name === "vcc_recall") capture.tool = t; },
    registerCommand: (name: string, def: any) => commands.set(name, def),
    zod: mockZod,
    sendMessage: (m: any, o: any) => sent.push({ m, o }),
    sendUserMessage: async () => {},
  });
  capture.commands = commands;
  capture.sent = sent;
};

let CFG_DIR: string;
let CONFIG_PATH: string;
let savedOmp: string | undefined;
let savedPi: string | undefined;
const DEBUG_PATH = "/tmp/omp-vcc-debug.json";
const DEBUG_LEGACY = "/tmp/pi-vcc-debug.json";

beforeAll(() => {
  CFG_DIR = mkdtempSync(join(tmpdir(), "core-residual-gaps-"));
  CONFIG_PATH = join(CFG_DIR, "config.json");
  savedOmp = process.env.OMP_VCC_CONFIG_PATH;
  savedPi = process.env.PI_VCC_CONFIG_PATH;
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  if (savedOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = savedOmp;
  if (savedPi === undefined) delete process.env.PI_VCC_CONFIG_PATH;
  else process.env.PI_VCC_CONFIG_PATH = savedPi;
  try { rmSync(CFG_DIR, { recursive: true, force: true }); } catch {}
  for (const p of [DEBUG_PATH, DEBUG_LEGACY]) try { if (existsSync(p)) unlinkSync(p); } catch {}
});

const setConfig = (cfg: Record<string, unknown>) => {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
};

// ── content.ts ──────────────────────────────────────────────────────────────

describe("content residual gaps", () => {
  it("clip hard-cuts spaceless text at max (no word boundary in range)", () => {
    // content.ts clip: lastIndexOf(" ") misses (cut=-1 ≤ max*0.6) → end=max.
    expect(clip("x".repeat(300), 200)).toBe("x".repeat(200));
  });

  it("clip never splits a surrogate pair at the cut point", () => {
    // content.ts clip: charCodeAt(end-1) is a high surrogate → end--.
    // Without the guard slice(0,199) would end in a lone surrogate.
    const text = "a".repeat(198) + "😀" + "b".repeat(50);
    expect(clip(text, 199)).toBe("a".repeat(198));
  });

  it("clipSentence ends at the last in-window sentence boundary", () => {
    // content.ts clipSentence: match [max*0.5, max] → cut after punctuation.
    expect(clipSentence("Alpha first sentence here. Beta second follows along.", 30))
      .toBe("Alpha first sentence here.");
  });

  it("clipSentence ignores a too-early boundary and falls back to word clip", () => {
    // content.ts clipSentence: end(3) < max*0.5 → falls through to clip().
    const text = "Hi. " + "word ".repeat(60);
    const r = clipSentence(text, 200);
    expect(r.length).toBeGreaterThan(10);
    expect(r).toBe(clip(text, 200));
  });

  it("clipSentence without any terminator equals word clip", () => {
    // content.ts clipSentence: no matches → return clip(text, max).
    const text = "word ".repeat(60);
    expect(clipSentence(text, 200)).toBe(clip(text, 200));
  });

  it("firstLine returns the head line clipped to max", () => {
    // content.ts firstLine: split + clip delegation.
    expect(firstLine("hello world\nsecond line", 5)).toBe("hello");
    expect(firstLine("", 200)).toBe("");
  });

  it("extractToolCallArgsText joins array-of-string values", () => {
    // content.ts extractToolCallArgsText: string items inside arrays (not just
    // top-level strings or array-of-objects, which content.test.ts covers).
    expect(extractToolCallArgsText({ tags: ["alpha", "beta"], limit: 3 })).toBe("alpha\nbeta");
  });

  it("snippet returns null on miss and ellipsizes only cut sides", () => {
    // content.ts snippet: idx===-1 → null; prefix/suffix depend on clipping.
    expect(snippet("hello world", "zzz")).toBeNull();
    const atStart = snippet(`needle in a haystack ${"x".repeat(200)}`, "needle")!;
    expect(atStart.startsWith("needle")).toBe(true);
    expect(atStart.endsWith("...")).toBe(true);
    const atEnd = snippet(`${"y".repeat(200)} needle`, "needle")!;
    expect(atEnd.startsWith("...")).toBe(true);
    expect(atEnd.endsWith("needle")).toBe(true);
    const mid = snippet(`${"y".repeat(200)} needle ${"x".repeat(200)}`, "needle")!;
    expect(mid.startsWith("...")).toBe(true);
    expect(mid.endsWith("...")).toBe(true);
    expect(mid).toContain("needle");
  });
});

// ── summarize.ts ────────────────────────────────────────────────────────────

describe("summarize residual gaps", () => {
  it("compile rejoins backslash-wrapped goal lines without a space", () => {
    // summarize.ts joinContinuations: prev ends with "\\" → hard-break rejoin.
    // A space-joined result would prove the wrong branch ran.
    const prev = "[Session Goal]\n- alpha beta gamma\\\n  delta-line\n\n---\n\n[user]\nold goal here";
    const out = compile({ messages: [userMsg("fresh task")], previousSummary: prev });
    expect(out).toContain("- alpha beta gammadelta-line");
    expect(out).not.toContain("gamma delta-line");
  });

  it("compile drops a malformed '(in' file head but keeps valid paths", () => {
    // summarize.ts mergeFileLines/parseHead: "(in" without "): " → null → ignored.
    const prev = "[Files And Changes]\n- Modified (in /broken-prefix\n- Modified: src/keep.ts\n\n---\n\n[user]\nold";
    const out = compile({ messages: [userMsg("do work")], previousSummary: prev });
    expect(out).toContain("keep.ts");
    expect(out).not.toContain("broken-prefix");
  });
});

// ── search-entries.ts ───────────────────────────────────────────────────────

describe("search-entries residual gaps", () => {
  const rendered = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ index: i, role: "user", summary: `entry ${i}` }));

  it("treats an unbounded {n,} nested quantifier as a literal", () => {
    // search-entries.ts quantifierAt: "{2,}" parses unbounded → nested → literal.
    const e = rendered(1);
    const withLiteral = [userMsg("first entry mentions (a{2,})+ literally")];
    expect(searchEntries(e, withLiteral, "(a{2,})+")).toHaveLength(1);
    expect(searchEntries(e, [userMsg("unrelated text here")], "(a{2,})+")).toHaveLength(0);
  });

  it("treats an unclosed { as a literal instead of throwing", () => {
    // search-entries.ts quantifierAt: no "}" → body "" → invalid regex → escaped literal.
    const e = rendered(1);
    expect(searchEntries(e, [userMsg("price foo{2 bar")], "foo{2")).toHaveLength(1);
  });

  it("aborts loudly with guidance when the query exceeds its time budget", () => {
    // search-entries.ts startBudget: Date.now() past deadline → throw (never silent).
    const realNow = Date.now;
    let calls = 0;
    Date.now = () => (calls++ === 0 ? 1_000_000 : Number.POSITIVE_INFINITY);
    try {
      expect(() => searchEntriesDetailed(rendered(1), [userMsg("budget probe text")], "budget.*probe"))
        .toThrow(/Search aborted/);
      calls = 0;
      try {
        searchEntriesDetailed(rendered(1), [userMsg("budget probe text")], "budget.*probe");
      } catch (err: any) {
        expect(err.message).toContain("Simplify");
      }
    } finally {
      Date.now = realNow;
    }
  });
});

// ── settings.ts ─────────────────────────────────────────────────────────────

describe("settings residual gaps", () => {
  it("scaffoldSettings migrates a legacy pi config into the new path", () => {
    // settings.ts scaffoldSettings: missing primary + legacy present → merged write.
    // Reads the real legacy path but only ever writes to the tmp OMP path.
    const legacy = join(homedir(), ".pi", "agent", "pi-vcc-config.json");
    const hadLegacy = existsSync(legacy);
    const prevLegacy = hadLegacy ? readFileSync(legacy, "utf-8") : null;
    const dir = mkdtempSync(join(tmpdir(), "core-residual-scaffold-"));
    const target = join(dir, "config.json");
    const oOmp = process.env.OMP_VCC_CONFIG_PATH;
    const oPi = process.env.PI_VCC_CONFIG_PATH;
    try {
      if (!hadLegacy) {
        mkdirSync(dirname(legacy), { recursive: true });
        writeFileSync(legacy, JSON.stringify({ debug: true }));
      }
      const legacyContent = JSON.parse(readFileSync(legacy, "utf-8"));
      process.env.OMP_VCC_CONFIG_PATH = target;
      process.env.PI_VCC_CONFIG_PATH = join(dir, "missing-pi.json");
      scaffoldSettings();
      const created = JSON.parse(readFileSync(target, "utf-8"));
      expect(created).toMatchObject({ ...DEFAULT_SETTINGS, ...legacyContent });
      // Legacy source is read-only: never modified by the migration.
      expect(readFileSync(legacy, "utf-8")).toBe(hadLegacy ? prevLegacy : JSON.stringify({ debug: true }));
    } finally {
      process.env.OMP_VCC_CONFIG_PATH = oOmp!;
      process.env.PI_VCC_CONFIG_PATH = oPi!;
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      if (!hadLegacy) try { unlinkSync(legacy); } catch {}
    }
  });
});

// ── tool-args.ts ────────────────────────────────────────────────────────────

describe("tool-args residual gaps", () => {
  it("summarizeToolArgs prefers path, then command, then query, then key list", () => {
    // tool-args.ts summarizeToolArgs: command/query branches (no test covers them).
    expect(summarizeToolArgs({ path: "a.ts", command: "c" })).toBe("path=a.ts");
    expect(summarizeToolArgs({ command: "npm test" })).toBe("command=npm test");
    expect(summarizeToolArgs({ query: "auth bug" })).toBe("query=auth bug");
    expect(summarizeToolArgs({ limit: 5 })).toBe("limit");
  });

  it("extractPath ignores non-string values and reads filePath aliases", () => {
    // tool-args.ts extractPath: typeof guard → null edge.
    expect(extractPath({ path: 42 } as any)).toBeNull();
    expect(extractPath({ filePath: "x/y.ts" })).toBe("x/y.ts");
    expect(extractPath({})).toBeNull();
  });
});

// ── brief.ts ────────────────────────────────────────────────────────────────

describe("brief residual gaps", () => {
  const toolCall = (name: string, args: Record<string, unknown>): any => ({ kind: "tool_call", name, args });

  it("strips stacked pipe tails iteratively", () => {
    // brief.ts stripPipeTail: the loop must run twice (c = stripped re-enters).
    const r = compileBrief([toolCall("bash", { command: "ls -la | sort | head -5" })]);
    expect(r).toContain('* bash "ls -la"');
    expect(r).not.toContain("sort");
    expect(r).not.toContain("head");
  });

  it("caps an overlong bash command at BASH_CAP with an ellipsis", () => {
    // brief.ts compressBash: cmd longer than 240 chars → slice + "...".
    const long = "x".repeat(300);
    const r = compileBrief([toolCall("bash", { command: long })]);
    expect(r).toContain("...");
    expect(r).not.toContain(long);
  });

  it("renders query tools and bare tools without path or query", () => {
    // brief.ts toolOneLiner: query branch and the bare `* name` fallback.
    const r = compileBrief([
      toolCall("Grep", { query: "something about auth tokens" }),
      toolCall("Mystery", { count: 3 }),
    ]);
    expect(r).toContain('* Grep "something about auth tokens"');
    expect(r).toContain("* Mystery");
  });
});

// ── format-recall.ts ────────────────────────────────────────────────────────

describe("format-recall residual gaps", () => {
  it("shortPath relativizes cwd paths and truncates long foreign paths", () => {
    // format-recall.ts shortPath: cwd prefix → "./rel"; >3 parts → ".../last3".
    expect(shortPath(join(process.cwd(), "src", "a.ts"))).toBe("./src/a.ts");
    expect(shortPath("/a/b/c/d/e.ts")).toBe(".../c/d/e.ts");
    expect(shortPath("a/b")).toBe("a/b");
  });
});

// ── hook.ts ─────────────────────────────────────────────────────────────────

const hmsg = (id: string, role: "user" | "assistant", content: any = "x") => ({
  id,
  type: "message",
  message: { role, content },
});
const hcomp = (id: string, firstKeptEntryId?: string) => ({ id, type: "compaction", firstKeptEntryId });

const makeEvent = (branchEntries: any[], customInstructions?: string, tokensBefore = 5000) => ({
  type: "session_before_compact",
  customInstructions,
  branchEntries,
  preparation: {
    previousSummary: undefined,
    fileOps: { read: [], written: [], edited: [] },
    tokensBefore,
  },
  signal: new AbortController().signal,
});

describe("hook residual gaps", () => {
  it("debug snapshot renders image/unknown part previews", () => {
    // hook.ts previewContent: [image:mime] passthrough, unknown-type fallback,
    // and "" for non-string/non-array content (kept tail never normalized).
    for (const p of [DEBUG_PATH, DEBUG_LEGACY]) try { if (existsSync(p)) unlinkSync(p); } catch {}
    setConfig({ vccEnabled: true, overrideDefaultCompaction: true, smartKeepTail: false, debug: true, chainShakeHint: false, continueAfterThresholdCompact: false });
    const pi = makeMockApi();
    registerBeforeCompactHook(pi as any);
    const before = (pi as any).__handlers.get("session_before_compact");
    const entries = [
      hmsg("m1", "user", "first goal"),
      hmsg("m2", "assistant", "first reply"),
      hmsg("m3", "user", "second goal"),
      hmsg("m4", "assistant", "second reply"),
      hmsg("m5", "user", [{ type: "image", mimeType: "image/png" }, { type: "mystery", note: "x" }, null]),
      hmsg("m6", "assistant", 42),
    ];
    const ctx = makeMockCtx({ ui: { notify: () => {}, setWidget: () => {}, setHeader: () => {} } });
    const result = before(makeEvent(entries), ctx);
    expect(result.compaction).toBeDefined();
    const data = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    const previews = (data.cutWindow as any[]).map((e) => e.preview);
    expect(previews.some((p) => typeof p === "string" && p.includes("[image:image/png]"))).toBe(true);
    expect(previews.some((p) => typeof p === "string" && p.includes("[mystery]"))).toBe(true);
    expect(previews.some((p) => typeof p === "string" && p.includes("[unknown]"))).toBe(true);
    expect(previews).toContain("");
    for (const p of [DEBUG_PATH, DEBUG_LEGACY]) try { if (existsSync(p)) unlinkSync(p); } catch {}
  });

  it("too-few with a reset_boundary after compaction cancels via the reset diagnostic", () => {
    // hook.ts !ownCut.ok fallback: resetIdx > lastCompIdx → reset-superseded roles.
    setConfig({ vccEnabled: true, overrideDefaultCompaction: true, debug: false });
    const pi = makeMockApi();
    registerBeforeCompactHook(pi as any);
    const before = (pi as any).__handlers.get("session_before_compact");
    const notified: Array<{ message: string; type: string }> = [];
    const ctx = makeMockCtx({ ui: { notify: (message: string, type: string) => notified.push({ message, type }), setWidget: () => {}, setHeader: () => {} } });
    const entries = [
      hcomp("c1", "m1"),
      hmsg("m1", "user", "old"),
      { id: "r1", type: "reset_boundary" },
      hmsg("m2", "user", "fresh after clear"),
    ];
    expect(before(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION), ctx)).toEqual({ cancel: true });
    expect(notified.some((n) => n.message.includes("Too few"))).toBe(true);
  });

  it("too-few with an orphan compaction cancels via the orphan diagnostic", () => {
    // hook.ts !ownCut.ok fallback: prior compaction + dangling kept id → orphan roles.
    // (buildOrphanSession-style fixtures have 4+ live messages and take the ok path.)
    setConfig({ vccEnabled: true, overrideDefaultCompaction: true, debug: false });
    const pi = makeMockApi();
    registerBeforeCompactHook(pi as any);
    const before = (pi as any).__handlers.get("session_before_compact");
    const notified: Array<{ message: string; type: string }> = [];
    const ctx = makeMockCtx({ ui: { notify: (message: string, type: string) => notified.push({ message, type }), setWidget: () => {}, setHeader: () => {} } });
    const entries = [
      hmsg("m0", "user", "stale"),
      hcomp("c1", "gone-id"),
      hmsg("m1", "user", "fresh"),
    ];
    expect(before(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION), ctx)).toEqual({ cancel: true });
    expect(notified.some((n) => n.message.includes("Too few"))).toBe(true);
  });

  it("session_compact chain shake supports a synchronous ctx.compact", async () => {
    // hook.ts chain-shake: non-promise compact result takes the sync setTimeout
    // branch — calling .catch on it would throw and break the compact handler.
    setConfig({ vccEnabled: true, overrideDefaultCompaction: true, smartKeepTail: false, debug: false, chainShakeHint: true, continueAfterThresholdCompact: false });
    const pi = makeMockApi();
    registerBeforeCompactHook(pi as any);
    const before = (pi as any).__handlers.get("session_before_compact");
    const onCompact = (pi as any).__handlers.get("session_compact");
    const entries = [
      hmsg("m1", "user", "goal one here"),
      hmsg("m2", "assistant", "reply one here"),
      hmsg("m3", "user", "goal two here"),
      hmsg("m4", "assistant", "reply two here"),
      hmsg("m5", "user", "goal three here"),
      hmsg("m6", "assistant", "reply three here"),
    ];
    const baseCtx = makeMockCtx({ ui: { notify: () => {}, setWidget: () => {}, setHeader: () => {} } });
    const r = before(makeEvent(entries, undefined, 90000), baseCtx);
    expect(r.compaction).toBeDefined();
    const shakeCalls: any[] = [];
    const ctx = makeMockCtx({
      ui: { notify: () => {}, setWidget: () => {}, setHeader: () => {} },
      compact: function (opts: any) { shakeCalls.push(opts); },
    });
    await onCompact({ fromExtension: true, compactionEntry: { tokensBefore: 90000, tokensAfter: 21500, id: "c1" } }, ctx);
    expect(shakeCalls).toEqual([{ mode: "shake" }]);
  });

  it("factory builds a vcc_recall zod schema with the five parameters", () => {
    // Factory requires pi.zod; the shape carries all five parameters.
    const capture: { tool?: any } = {};
    makeFactoryPi(capture);
    expect(capture.tool.name).toBe("vcc_recall");
    expect(Object.keys(capture.tool.parameters).sort()).toEqual(["expand", "mode", "page", "query", "scope"]);
  });

  it("recall tool refuses entry refs outside the active lineage", async () => {
    // Factory execute: lineage guard for #N.
    const dir = mkdtempSync(join(tmpdir(), "core-residual-recall-"));
    try {
      const file = join(dir, "session.jsonl");
      const ids = ["m0", "m1", "m2", "m3", "m4"];
      writeFileSync(file, ids.map((id) => JSON.stringify({ type: "message", id, message: { role: "user", content: `message ${id}` } })).join("\n") + "\n", "utf8");
      const capture: { tool?: any } = {};
      makeFactoryPi(capture);
      const tool = capture.tool;
      const res = await tool.execute("tc", { query: "#3", scope: "lineage" }, undefined, undefined, {
        sessionManager: { getSessionFile: () => file, getBranch: () => [{ id: "m0" }] },
      });
      const text = res.content[0].text as string;
      expect(text).toContain("Cannot expand indices outside active lineage: 3");
      expect(text).toContain("scope:'all'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recall tool prefixes scope:all on the no-query recent path", async () => {
    // Factory execute: no-query fallback with scope all.
    const dir = mkdtempSync(join(tmpdir(), "core-residual-recall-"));
    try {
      const file = join(dir, "session.jsonl");
      const ids = ["m0", "m1"];
      writeFileSync(file, ids.map((id) => JSON.stringify({ type: "message", id, message: { role: "user", content: `tail ${id}` } })).join("\n") + "\n", "utf8");
      const capture: { tool?: any } = {};
      makeFactoryPi(capture);
      const tool = capture.tool;
      const res = await tool.execute("tc", { scope: "all" }, undefined, undefined, {
        sessionManager: { getSessionFile: () => file, getBranch: () => ids.map((id) => ({ id })) },
      });
      const text = res.content[0].text as string;
      expect(text.startsWith("Scope: all")).toBe(true);
      expect(text).toContain("tail m1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recall alias command with empty args sends recent entries", async () => {
    // Factory /pi-vcc-recall: !query → recent.
    const dir = mkdtempSync(join(tmpdir(), "core-residual-recall-cmd-"));
    try {
      const file = join(dir, "session.jsonl");
      const ids = ["m0", "m1", "m2"];
      writeFileSync(file, ids.map((id) => JSON.stringify({ type: "message", id, message: { role: "user", content: `hello recent ${id}` } })).join("\n") + "\n", "utf8");
      const capture: { commands?: Map<string, any>; sent?: any[] } = {};
      makeFactoryPi(capture);
      const handler = capture.commands!.get("pi-vcc-recall").handler;
      const sent = capture.sent!;
      const ctx = makeMockCtx({
        sessionManager: { getSessionFile: () => file, getBranch: () => ids.map((id) => ({ id })), getEntries: () => ids.map((id) => ({ id })) },
        ui: { notify: () => {}, setWidget: () => {}, setHeader: () => {} },
      });
      await handler("", ctx);
      expect(sent).toHaveLength(1);
      expect(sent[0].m.customType).toBe("vcc-recall");
      expect(sent[0].m.content).toContain("hello recent m2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recall alias command with only page:N sends recent entries", async () => {
    // Factory /pi-vcc-recall: page stripped → empty query → recent.
    const dir = mkdtempSync(join(tmpdir(), "core-residual-recall-cmd-"));
    try {
      const file = join(dir, "session.jsonl");
      const ids = ["m0", "m1"];
      writeFileSync(file, ids.map((id) => JSON.stringify({ type: "message", id, message: { role: "user", content: `page recent ${id}` } })).join("\n") + "\n", "utf8");
      const capture: { commands?: Map<string, any>; sent?: any[] } = {};
      makeFactoryPi(capture);
      const handler = capture.commands!.get("pi-vcc-recall").handler;
      const sent = capture.sent!;
      const ctx = makeMockCtx({
        sessionManager: { getSessionFile: () => file, getBranch: () => ids.map((id) => ({ id })), getEntries: () => ids.map((id) => ({ id })) },
        ui: { notify: () => {}, setWidget: () => {}, setHeader: () => {} },
      });
      await handler("page:2", ctx);
      expect(sent).toHaveLength(1);
      expect(sent[0].m.content).toContain("page recent m1");
      expect(sent[0].m.content).not.toContain("No matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
