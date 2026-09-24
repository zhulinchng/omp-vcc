// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  APPEND_SEGMENT_CUSTOM_TYPE,
  APPEND_TRAILING_CUSTOM_TYPE,
  buildAppendOnlyDetails,
  collectActiveSegments,
  compactionThresholds,
  decideAppendMode,
  projectAppendOnlyContext,
} from "../extensions/vcc-core/core/compaction-chain.ts";
import {
  buildRetainedToolOutputProjection,
  applyRetainedToolOutputProjection,
} from "../extensions/vcc-core/core/tool-output-budget.ts";
import { formatRecallOutput } from "../extensions/vcc-core/core/format-recall.ts";
import { searchEntriesDetailed } from "../extensions/vcc-core/core/search-entries.ts";
import { expandEntryFile } from "../extensions/vcc-core/core/drill-down.ts";
import { scanSessionEntries } from "../extensions/vcc-core/core/session-lines.ts";
import { loadAllMessages } from "../extensions/vcc-core/core/load-messages.ts";
import {
  clearCompactionHistoryForTests,
  getCompactionHistory,
  registerBeforeCompactHook,
  __setConvertToLlmForTests,
  __convertSelectedMessagesForTests,
  PI_VCC_COMPACT_INSTRUCTION,
  OMP_VCC_COMPACT_INSTRUCTION,
} from "../extensions/vcc-core/hook.ts";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadSettingsWithPluginOverlay,
  loadSettingsWithSources,
  scaffoldSettings,
} from "../extensions/vcc-core/core/settings.ts";
import extension from "../extensions/main.ts";

const mockChain: any = { optional: () => mockChain, describe: () => mockChain };
const mockZod: any = {
  object: (shape: any) => shape,
  boolean: () => mockChain,
  string: () => mockChain,
  array: () => mockChain,
  number: () => mockChain,
  enum: () => mockChain,
  optional: (value: any) => value,
};

const message = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  type: "message",
  message: { role, content, ...extra },
});

const compaction = (id: string, summary: string, firstKeptEntryId: string, details: unknown) => ({
  id,
  type: "compaction",
  summary,
  firstKeptEntryId,
  details,
});

const basePreparation = (overrides: Record<string, unknown> = {}) => ({
  previousSummary: undefined,
  fileOps: { read: [], written: [], edited: [] },
  tokensBefore: 60_000,
  settings: {},
  ...overrides,
});

const makePi = () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const sent: any[] = [];
  const pi: any = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    sendMessage: (value: any) => sent.push(value),
    sendUserMessage: (value: any) => sent.push({ user: value }),
    __handlers: handlers,
    __sent: sent,
  };
  registerBeforeCompactHook(pi);
  return pi;
};

const makeCtx = (overrides: Record<string, unknown> = {}) => ({
  sessionManager: {
    getSessionId: () => "session-a",
    getEntries: () => [],
    getBranch: () => [],
  },
  ui: { notify: () => {} },
  ...overrides,
});

const makeEvent = (entries: any[], overrides: Record<string, unknown> = {}) => {
  const { preparation, ...rest } = overrides;
  return {
    branchEntries: entries,
    preparation: basePreparation(preparation as any),
    customInstructions: undefined,
    signal: new AbortController().signal,
    ...rest,
  };
};

let root: string;
let configPath: string;
let previousConfig: string | undefined;
let previousPi: string | undefined;
let previousAgentDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omp-vcc-audit-"));
  configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ showPreCompactionMessage: false, compactionSummaryMode: "append" }));
  previousConfig = process.env.OMP_VCC_CONFIG_PATH;
  previousPi = process.env.PI_VCC_CONFIG_PATH;
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.OMP_VCC_CONFIG_PATH = configPath;
  delete process.env.PI_VCC_CONFIG_PATH;
  process.env.PI_CODING_AGENT_DIR = root;
});

afterEach(() => {
  clearCompactionHistoryForTests();
  __setConvertToLlmForTests(null);
  if (previousConfig === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = previousConfig;
  if (previousPi === undefined) delete process.env.PI_VCC_CONFIG_PATH;
  else process.env.PI_VCC_CONFIG_PATH = previousPi;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

describe("audit regressions: settings and host contracts", () => {
  test("normalizes malformed booleans and invalid enum/number values", () => {
    writeFileSync(configPath, JSON.stringify({
      vccEnabled: 0,
      debug: "false",
      debugLog: "false",
      compactionSummaryMode: "bogus",
      retainedToolOutputMaxTokens: -1,
      recallResponseMaxChars: Number.POSITIVE_INFINITY,
    }));
    const settings = loadSettings();
    expect(settings.vccEnabled).toBe(DEFAULT_SETTINGS.vccEnabled);
    expect(settings.debug).toBe(DEFAULT_SETTINGS.debug);
    expect(settings.debugLog).toBe(DEFAULT_SETTINGS.debugLog);
    expect(settings.compactionSummaryMode).toBe(DEFAULT_SETTINGS.compactionSummaryMode);
    expect(settings.retainedToolOutputMaxTokens).toBe(DEFAULT_SETTINGS.retainedToolOutputMaxTokens);
    expect(settings.recallResponseMaxChars).toBe(DEFAULT_SETTINGS.recallResponseMaxChars);
  });

  test("invalid config warning is once per stable session manager", () => {
    const invalid = join(root, "invalid.json");
    writeFileSync(invalid, "{broken");
    process.env.OMP_VCC_CONFIG_PATH = invalid;
    const notices: string[] = [];
    const manager = { getSessionId: () => "session-a" };
    const ctx1 = { sessionManager: manager, ui: { notify: (message: string) => notices.push(message) } };
    const ctx2 = { sessionManager: manager, ui: { notify: (message: string) => notices.push(message) } };
    loadSettings(ctx1);
    loadSettings(ctx2);
    expect(notices).toHaveLength(1);
    const otherManager = { getSessionId: () => "session-b" };
    loadSettings({ sessionManager: otherManager, ui: { notify: (message: string) => notices.push(message) } });
    expect(notices).toHaveLength(2);
  });

  test("invalid file values report default provenance", () => {
    writeFileSync(configPath, JSON.stringify({ compactionSummaryMode: "bogus", retainedToolOutputMaxTokens: -1 }));
    const view = loadSettingsWithSources();
    expect(view.values.compactionSummaryMode).toBe("append");
    expect(view.values.retainedToolOutputMaxTokens).toBe(20_000);
    expect(view.sources.compactionSummaryMode).toBe("default");
    expect(view.sources.retainedToolOutputMaxTokens).toBe("default");
  });

  test("scaffolding migrates a valid configured fallback instead of shadowing it", () => {
    const primary = join(root, "missing-primary.json");
    const fallback = join(root, "fallback.json");
    writeFileSync(fallback, JSON.stringify({ overrideDefaultCompaction: false }));
    process.env.OMP_VCC_CONFIG_PATH = primary;
    process.env.PI_VCC_CONFIG_PATH = fallback;
    scaffoldSettings();
    expect(JSON.parse(readFileSync(primary, "utf8")).overrideDefaultCompaction).toBe(false);
  });

  test("manifest uses the host enum values field", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.omp.settings.compactionSummaryMode.values).toEqual(["rewrite", "append"]);
    expect(manifest.pi.settings.compactionSummaryMode.values).toEqual(["rewrite", "append"]);
  });

  test("plugin settings loader remains fail-safe when public host API is unavailable", async () => {
    const result = loadSettingsWithPluginOverlay({ cwd: root });
    const settings = result instanceof Promise ? await result : result;
    expect(typeof settings.vccEnabled).toBe("boolean");
  });
});

describe("audit regressions: append context and compaction ownership", () => {
  test("projects the real host compactionSummary role", () => {
    const details = buildAppendOnlyDetails({
      segment: { summary: "segment", coverage: { firstCoveredEntryId: "a", lastCoveredEntryId: "b", firstKeptEntryId: "c", sourceMessageCount: 2 }, tokensBefore: 100 },
      chainStart: true,
      trailingSummary: "fallback",
      sections: ["Session Goal"],
      sourceMessageCount: 2,
      previousSummaryUsed: false,
    })!;
    const branch = [message("a", "user", "a"), message("b", "assistant", "b"), message("c", "user", "c"), compaction("c1", "fallback", "c", details)];
    const chain = collectActiveSegments(branch, { fallbackSummary: "fallback" })!;
    const projected = projectAppendOnlyContext({
      messages: [{ role: "compactionSummary", summary: "fallback" }],
      chain,
      fallbackSummary: "fallback",
    });
    expect(projected[0]).toMatchObject({ customType: APPEND_SEGMENT_CUSTOM_TYPE, content: "segment" });
    expect(projected[1]).toMatchObject({ customType: APPEND_TRAILING_CUSTOM_TYPE, content: "fallback" });
  });

  test("context uses the active branch instead of a later sibling compaction", () => {
    const detailsA = buildAppendOnlyDetails({
      segment: { summary: "A segment", coverage: { firstCoveredEntryId: "a", lastCoveredEntryId: "b", firstKeptEntryId: "c", sourceMessageCount: 2 }, tokensBefore: 100 },
      chainStart: true,
      trailingSummary: "A fallback",
      sections: [],
      sourceMessageCount: 2,
      previousSummaryUsed: false,
    })!;
    const detailsB = buildAppendOnlyDetails({
      segment: { summary: "B segment", coverage: { firstCoveredEntryId: "x", lastCoveredEntryId: "y", firstKeptEntryId: "z", sourceMessageCount: 2 }, tokensBefore: 100 },
      chainStart: true,
      trailingSummary: "B fallback",
      sections: [],
      sourceMessageCount: 2,
      previousSummaryUsed: false,
    })!;
    const branchA = [message("a", "user", "a"), message("b", "assistant", "b"), message("c", "user", "c"), compaction("ca", "A fallback", "c", detailsA)];
    const allEntries = [...branchA, message("x", "user", "x"), message("y", "assistant", "y"), message("z", "user", "z"), compaction("cb", "B fallback", "z", detailsB)];
    const pi: any = { on: (event: string, handler: any) => { if (event === "context") pi.context = handler; }, sendMessage: () => {}, sendUserMessage: () => {} };
    registerBeforeCompactHook(pi);
    const result = pi.context({ messages: [{ role: "compactionSummary", summary: "A fallback" }] }, { sessionManager: { getBranch: () => branchA, getEntries: () => allEntries } });
    expect(result.messages[0]).toMatchObject({ content: "A segment" });
    expect(result.messages[1]).toMatchObject({ content: "A fallback" });
  });

  test("rejects append coverage that disagrees with host firstKeptEntryId", () => {
    const details = buildAppendOnlyDetails({
      segment: { summary: "segment", coverage: { firstCoveredEntryId: "a", lastCoveredEntryId: "b", firstKeptEntryId: "c", sourceMessageCount: 2 }, tokensBefore: 100 },
      chainStart: true,
      trailingSummary: "fallback",
      sections: [],
      sourceMessageCount: 2,
      previousSummaryUsed: false,
    })!;
    const branch = [message("a", "user", "a"), message("b", "assistant", "b"), message("c", "user", "c"), compaction("c1", "fallback", "x", details)];
    expect(collectActiveSegments(branch, { fallbackSummary: "fallback" })).toBeNull();
  });

  test("explicit compaction can start a v3 chain from a valid v2 rewrite", async () => {
    const entries = [
      message("u1", "user", "old"), message("a1", "assistant", "old reply"), message("k1", "user", "kept"),
      message("u2", "user", "middle"), message("a2", "assistant", "middle reply"),
      compaction("legacy", "legacy summary", "k1", { compactor: "omp-vcc", version: 2, sections: [], sourceMessageCount: 2, previousSummaryUsed: false }),
      message("u3", "user", "new"), message("a3", "assistant", "new reply"),
    ];
    const pi = makePi();
    const result = await pi.__handlers.get("session_before_compact")(makeEvent(entries, {
      preparation: { previousSummary: "legacy summary", tokensBefore: 70_000 },
      customInstructions: OMP_VCC_COMPACT_INSTRUCTION,
    }), makeCtx());
    expect(result.compaction.details.version).toBe(3);
    expect(result.compaction.details.segment.sequence).toBe(1);
    expect(result.compaction.details.chainStart).toBe(true);
  });

  test("does not publish stats or compaction after session switch during async memory lookup", async () => {
    const pi = makePi();
    const deferred = Promise.withResolvers<unknown>();
    const memoryResult = deferred.promise;
    const resolveMemory = deferred.resolve;
    const ctx = makeCtx({ memory: { search: () => memoryResult } });
    const entries = [message("u1", "user", "one"), message("a1", "assistant", "reply"), message("u2", "user", "two"), message("a2", "assistant", "done")];
    const pending = pi.__handlers.get("session_before_compact")(makeEvent(entries, { customInstructions: OMP_VCC_COMPACT_INSTRUCTION }), ctx);
    pi.__handlers.get("session_switch")({ type: "session_switch" }, makeCtx({ sessionManager: { getSessionId: () => "session-b" } }));
    resolveMemory({ items: [] });
    expect(await pending).toBeUndefined();
    expect(getCompactionHistory(pi)).toHaveLength(0);
  });

  test("host-owned auto compaction does not schedule a second continuation", async () => {
    const pi = makePi();
    const entries = [message("u1", "user", "one"), message("a1", "assistant", "reply"), message("u2", "user", "two"), message("a2", "assistant", "done")];
    await pi.__handlers.get("auto_compaction_start")({ reason: "threshold", action: "context-full" }, makeCtx());
    await pi.__handlers.get("session_before_compact")(makeEvent(entries), makeCtx());
    await pi.__handlers.get("session_compact")({ fromExtension: true, compactionEntry: { id: "c1", tokensBefore: 60_000, tokensAfter: 10_000 } }, makeCtx());
    expect(pi.__sent).toHaveLength(0);
    await pi.__handlers.get("auto_compaction_end")({ action: "context-full", willRetry: false }, makeCtx());
  });

  test("foreign extension compaction cannot consume VCC display, follow-up, or stats", async () => {
    const pi = makePi();
    const entries = [message("u1", "user", "one"), message("a1", "assistant", "reply"), message("u2", "user", "two"), message("a2", "assistant", "done")];
    await pi.__handlers.get("session_before_compact")(makeEvent(entries, { customInstructions: "continue" }), makeCtx());
    await pi.__handlers.get("session_compact")({
      fromExtension: true,
      compactionEntry: { id: "foreign", summary: "foreign", firstKeptEntryId: "u2", details: { compactor: "other", version: 9 } },
    }, makeCtx());
    expect(pi.__sent).toHaveLength(0);
    expect(getCompactionHistory(pi)).toHaveLength(0);
  });

  test("session transitions clear per-session history", async () => {
    const pi = makePi();
    const entries = [message("u1", "user", "one"), message("a1", "assistant", "reply"), message("u2", "user", "two"), message("a2", "assistant", "done")];
    await pi.__handlers.get("session_before_compact")(makeEvent(entries, { customInstructions: OMP_VCC_COMPACT_INSTRUCTION }), makeCtx());
    expect(getCompactionHistory(pi)).toHaveLength(1);
    pi.__handlers.get("session_switch")({ type: "session_switch" }, makeCtx({ sessionManager: { getSessionId: () => "session-b" } }));
    expect(getCompactionHistory(pi)).toHaveLength(0);
  });

  test("repeats source index for every host conversion fragment", () => {
    __setConvertToLlmForTests((messages: any[]) => messages.flatMap((item) => {
      if (item.role === "bashExecution") return [];
      if (item.role === "fileMention") return [{ role: "user", content: "file one" }, { role: "user", content: "file two" }];
      return [item];
    }));
    const converted = __convertSelectedMessagesForTests(
      [{ role: "bashExecution" }, { role: "fileMention" }],
      ["x1", "x2"],
      [1, 2],
    );
    expect(converted.messages).toHaveLength(2);
    expect(converted.sourceIndices).toEqual([2, 2]);
  });
});

describe("audit regressions: retained output and recall", () => {
  test("does not budget excluded bash output", () => {
    const projection = buildRetainedToolOutputProjection([
      { id: "hidden", type: "message", message: { role: "bashExecution", output: "x".repeat(100), excludeFromContext: true } },
      { id: "visible", type: "message", message: { role: "toolResult", content: "small" } },
    ], 1);
    expect(projection.omissions).toHaveLength(0);
  });

  test("rewrite details replay retained output without positional metadata corruption", () => {
    const entries = [message("r1", "user", "before"), message("r2", "toolResult", "old output"), compaction("c1", "rewrite", "r1", {
      compactor: "omp-vcc", version: 2, sections: [], sourceMessageCount: 1, previousSummaryUsed: false,
      retainedToolOutputProjection: { version: 1, retainedTokens: 0, omittedTokens: 3, pendingCount: 0, omissions: [{ entryId: "r2", marker: "[omitted]" }] },
    })];
    const contextMessages = [{ role: "user", content: "before" }, { role: "toolResult", toolCallId: "call-r2", content: "old output" }];
    const result = applyRetainedToolOutputProjection(contextMessages, entries[2].details.retainedToolOutputProjection, { omissionToolCallIds: { r2: "call-r2" } });
    expect(result[1]).toMatchObject({ content: "[omitted]" });
  });

  test("file search includes paths, matching-line counts, snippets, and CJK scripts", () => {
    const rendered: any[] = [{ index: 0, role: "assistant", summary: "file operation" }];
    const messages: any[] = [{ role: "assistant", content: [{ type: "toolCall", name: "Write", arguments: { path: "src/auth.ts", content: "first\n认证令牌\nlast" } }] }];
    const pathHit = searchEntriesDetailed(rendered, messages, "auth.ts", { mode: "file" }).hits[0];
    expect(pathHit.fileMatches?.[0]).toMatchObject({ path: "src/auth.ts", lineCount: 1 });
    const cjkHit = searchEntriesDetailed(rendered, messages, "认证令牌", { mode: "file" }).hits[0];
    expect(cjkHit.fileMatches?.[0].lineCount).toBe(1);
    expect(formatRecallOutput([cjkHit], "认证令牌")).toContain("认证令牌");
  });

  test("long single-line search snippets remain centered on the match", () => {
    const rendered: any[] = [{ index: 0, role: "toolResult", summary: "long" }];
    const needle = "NEEDLE";
    const messages: any[] = [{ role: "toolResult", content: "x".repeat(49_000) + needle + "y".repeat(1_000) }];
    const hit = searchEntriesDetailed(rendered, messages, needle).hits[0];
    expect(hit.snippet).toContain(needle);
    expect(hit.snippet!.length).toBeLessThan(2_500);
  });

  test("file full drill-down respects UTF-8 byte limits", () => {
    const sessionFile = join(root, "file-session.jsonl");
    const body = "漢".repeat(20_000);
    writeFileSync(sessionFile, JSON.stringify(message("f0", "assistant", [{ type: "toolCall", name: "Write", arguments: { path: "x.ts", content: body } }])) + "\n");
    const text = expandEntryFile(sessionFile, 0, "file", true);
    const renderedBody = (text.split("\n\n")[1] ?? "").split("\n\n... (")[0];
    expect(Buffer.byteLength(body)).toBeGreaterThan(50 * 1024);
    expect(Buffer.byteLength(renderedBody)).toBeLessThanOrEqual(50 * 1024);
    expect(renderedBody).not.toContain("\uFFFD");
  });
});

describe("audit regressions: model recall command wiring", () => {
  test("model file mode without query returns file operations, and #N:text expands message text", async () => {
    const sessionFile = join(root, "session.jsonl");
    const entries = [
      message("m0", "user", "login prose"),
      message("m1", "assistant", [{ type: "toolCall", name: "Write", arguments: { path: "src/auth.ts", content: "tokenRefresh" } }]),
    ];
    writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    let tool: any;
    const commands = new Map<string, any>();
    (extension as any)({
      on: () => {},
      registerTool: (value: any) => { if (value.name === "vcc_recall") tool = value; },
      registerCommand: (name: string, value: any) => commands.set(name, value),
      zod: mockZod,
      sendMessage: () => {},
      sendUserMessage: () => {},
    });
    const ctx = makeCtx({ sessionManager: { getSessionFile: () => sessionFile, getEntries: () => entries, getBranch: () => entries } });
    const fileResult = await tool.execute("call", { mode: "file" }, null, null, ctx);
    expect(fileResult.content[0].text).toContain("src/auth.ts");
    expect(fileResult.content[0].text).not.toContain("login prose");
    const textResult = await tool.execute("call", { query: "#0:text" }, null, null, ctx);
    expect(textResult.content[0].text).toContain("login prose");
  });

  test("production recall surfaces malformed JSONL diagnostics when debug is enabled", async () => {
    writeFileSync(configPath, JSON.stringify({ debug: true, compactionSummaryMode: "append" }));
    const sessionFile = join(root, "malformed.jsonl");
    const entry = message("m0", "user", "login prose");
    writeFileSync(sessionFile, `${JSON.stringify(entry)}\nnot-json\n`);
    let tool: any;
    (extension as any)({
      on: () => {},
      registerTool: (value: any) => { if (value.name === "vcc_recall") tool = value; },
      registerCommand: () => {},
      zod: mockZod,
      sendMessage: () => {},
      sendUserMessage: () => {},
    });
    const notices: string[] = [];
    const ctx = makeCtx({
      sessionManager: { getSessionFile: () => sessionFile, getEntries: () => [entry], getBranch: () => [entry] },
      ui: { notify: (value: string) => notices.push(value) },
    });
    await tool.execute("call", { query: "login" }, null, null, ctx);
    expect(notices.some((value) => value.includes("session-parse-errors") && value.includes("1 malformed lines"))).toBe(true);
  });
});

describe("audit regressions: context pressure and tool settings", () => {
  test("context threshold policy exposes exact boundary values", () => {
    expect(compactionThresholds(272_000, 12_000)).toMatchObject({ chainThreshold: 34_000, contextThreshold: 136_000, minimumSaving: 24_000 });
    expect(decideAppendMode({ chainTokens: 40_000, fullContextTokens: 136_000, rebaseChainTokens: 100, pressure: true, contextWindow: 272_000, reserveTokens: 12_000 }).mode).toBe("rebase");
  });
});

describe("audit regressions: streamed session parsing", () => {
  test("preserves split UTF-8, CRLF, final unterminated lines, and parse diagnostics", () => {
    const sessionFile = join(root, "stream.jsonl");
    const first = message("s1", "user", "漢".repeat(40_000));
    const final = message("s2", "assistant", "final");
    writeFileSync(sessionFile, `${JSON.stringify(first)}\r\n\nnot-json\n${JSON.stringify(final)}`);
    const seen: any[] = [];
    const scan = scanSessionEntries(sessionFile, (entry) => seen.push(entry));
    expect(scan.parseErrors).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[1].id).toBe("s2");
    const diagnostics: any[] = [];
    const loaded = loadAllMessages(sessionFile, false, undefined, (event) => diagnostics.push(event));
    expect(loaded.rendered.map((entry) => entry.index)).toEqual([0, 1]);
    expect(diagnostics).toEqual([{ kind: "session-parse-errors", sessionFile, parseErrors: 1 }]);
  });
});
