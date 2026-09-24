// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAllMessages } from "../extensions/vcc-core/core/load-messages";
import { buildGlobalIndex } from "../extensions/vcc-core/core/global-indices";
import { capRecallBlocks } from "../extensions/vcc-core/core/recall-budget";
import { searchEntriesDetailed } from "../extensions/vcc-core/core/search-entries";
import { loadSettings } from "../extensions/vcc-core/core/settings";
import { registerBeforeCompactHook, OMP_VCC_COMPACT_INSTRUCTION, clearCompactionHistoryForTests } from "../extensions/vcc-core/hook";

import { buildAppendOnlyDetails } from "../extensions/vcc-core/core/compaction-chain";
const message = (id: string, role: string, content: unknown) => ({ id, type: "message", message: { role, content } });
const rendered = (index: number, role: string, summary: string, files?: string[]) => ({ index, role, summary, ...(files ? { files } : {}) });

describe("approved parity feature contracts", () => {
  test("global indices fail closed on duplicate IDs and streamed loader preserves entry IDs", () => {
    const index = buildGlobalIndex([
      { type: "message", id: "a" },
      { type: "message" },
      { type: "message", id: "a" },
      { type: "message", id: "b" },
      { type: "compaction", id: "c" },
    ]);
    expect(index.messageCount).toBe(4);
    expect(index.indexById.has("a")).toBe(false);
    expect(index.indexById.get("b")).toBe(4);

    const root = mkdtempSync(join(tmpdir(), "vcc-stream-"));
    const file = join(root, "session.jsonl");
    const diagnostics: any[] = [];
    writeFileSync(file, [
      JSON.stringify(message("m1", "user", "hello")),
      "{malformed",
      JSON.stringify(message("m2", "assistant", "world")),
      JSON.stringify({ type: "message", message: { role: "user", content: "last" } }),
    ].join("\n"));
    const loaded = loadAllMessages(file, false, new Set(["m1"]), (event) => diagnostics.push(event));
    expect(loaded.rendered.map((entry) => entry.index)).toEqual([0]);
    expect(loaded.entryIds).toEqual(["m1"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].kind).toBe("session-parse-errors");
    rmSync(root, { recursive: true, force: true });
  });

  test("model recall budget represents every requested block and file/CJK search is scoped", () => {
    const capped = capRecallBlocks([
      { id: "#1", text: "a".repeat(100) },
      { id: "#2", text: "b".repeat(100) },
    ], 50, { blockKind: "entry" });
    expect(capped).toContain("recall response capped at 50 characters");
    expect(capped).toContain("entry #1");
    expect(capped).toContain("entry #2");

    const entries = [rendered(0, "user", "login"), rendered(1, "assistant", "Write tokenRefresh", ["src/auth.ts"])];
    const messages = [
      { role: "user", content: "login" },
      { role: "assistant", content: [{ type: "toolCall", name: "Write", arguments: { path: "src/auth.ts", content: "tokenRefresh" } }] },
    ];
    const fileResult = searchEntriesDetailed(entries, messages, "tokenRefresh", { mode: "file" });
    expect(fileResult.hits).toHaveLength(1);
    expect(fileResult.hits[0].fileMatches?.[0]).toMatchObject({ path: "src/auth.ts", toolName: "Write" });
    expect(searchEntriesDetailed(entries, messages, "login", { mode: "file" }).hits).toHaveLength(0);
    expect(searchEntriesDetailed(entries, messages, "认证令牌", { mode: "file" }).hits).toHaveLength(0);
    const cjkEntries = [rendered(0, "assistant", "认证令牌")];
    const cjkMessages = [{ role: "assistant", content: [{ type: "toolCall", name: "Write", arguments: { path: "src/cjk.ts", content: "认证令牌" } }] }];
    expect(searchEntriesDetailed(cjkEntries, cjkMessages, "认证令牌", { mode: "file" }).hits).toHaveLength(1);
  });
  test("registered vcc_recall tool applies the live response budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "vcc-tool-budget-"));
    const sessionFile = join(root, "session.jsonl");
    const config = join(root, "config.json");
    writeFileSync(sessionFile, [
      JSON.stringify(message("m1", "user", "auth decision")),
      JSON.stringify(message("m2", "assistant", "the auth decision is recorded")),
      JSON.stringify(message("m3", "user", "continue")),
    ].join("\n"));
    writeFileSync(config, JSON.stringify({ recallResponseMaxChars: 80 }));
    const previous = process.env.OMP_VCC_CONFIG_PATH;
    process.env.OMP_VCC_CONFIG_PATH = config;
    const tools: any[] = [];
    const zodChain: any = {};
    zodChain.describe = () => zodChain;
    zodChain.optional = () => zodChain;
    const pi: any = {
      cwd: root,
      hasUI: true,
      ui: { notify: () => {} },
      on: () => {},
      registerTool: (tool: any) => tools.push(tool),
      registerCommand: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
      zod: { object: (shape: unknown) => shape, string: () => zodChain, number: () => zodChain, boolean: () => zodChain, array: () => zodChain, enum: () => zodChain },
    };
    const { default: createExtension } = await import("../extensions/main");
    createExtension(pi);
    const tool = tools.find((value) => value.name === "vcc_recall");
    const result = await tool.execute("", { query: "auth", scope: "all" }, null, null, { sessionManager: { getSessionFile: () => sessionFile, getEntries: () => [] } });
    expect(result.content[0].text).toContain("recall response capped at 80 characters");
    if (previous === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
    else process.env.OMP_VCC_CONFIG_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });

  test("native memory is queried asynchronously without replacing deterministic summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "vcc-memory-"));
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ compactionSummaryMode: "rewrite", showPreCompactionMessage: false }));
    const previous = process.env.OMP_VCC_CONFIG_PATH;
    process.env.OMP_VCC_CONFIG_PATH = config;
    let before: any;
    const calls: any[] = [];
    const pi: any = {
      on: (event: string, handler: any) => { if (event === "session_before_compact") before = handler; },
      sendMessage: () => {},
      sendUserMessage: () => {},
    };
    registerBeforeCompactHook(pi);
    const ctx: any = {
      memory: { search: (query: string, options: any) => { calls.push({ query, options }); return Promise.resolve([{ id: "mem-1", source: "host", content: "remember the auth decision" }]); } },
      ui: { notify: () => {} },
    };
    const entries = [message("u1", "user", "make an auth decision"), message("a1", "assistant", "working"), message("u2", "user", "continue"), message("a2", "assistant", "done")];
    const result = await before({
      customInstructions: OMP_VCC_COMPACT_INSTRUCTION,
      branchEntries: entries,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 },
      signal: new AbortController().signal,
    }, ctx);
    expect(calls[0].options).toMatchObject({ limit: 8 });
    expect(calls[0].options.signal).toBeDefined();
    expect(result.compaction.summary).toContain("[Host Memory]");
    expect(result.compaction.summary).toContain("auth decision");
    clearCompactionHistoryForTests();
    if (previous === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
    else process.env.OMP_VCC_CONFIG_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });

  test("context hook projects one persisted append fallback into segments and trailing state", () => {
    const details = buildAppendOnlyDetails({
      segment: { summary: "fresh segment", coverage: { firstCoveredEntryId: "a", lastCoveredEntryId: "b", firstKeptEntryId: "c", sourceMessageCount: 2 }, tokensBefore: 100 },
      chainStart: true,
      trailingSummary: "complete fallback",
      sections: ["Session Goal"],
      sourceMessageCount: 2,
      previousSummaryUsed: false,
    });
    const entries = [message("a", "user", "old"), message("b", "assistant", "answer"), message("c", "user", "tail"), { id: "c1", type: "compaction", summary: "complete fallback", firstKeptEntryId: "c", details }];
    let context: any;
    const pi: any = { on: (event: string, handler: any) => { if (event === "context") context = handler; }, sendMessage: () => {}, sendUserMessage: () => {} };
    registerBeforeCompactHook(pi);
    const result = context({ messages: [{ role: "user", content: "old" }, { role: "branchSummary", summary: "complete fallback" }, { role: "user", content: "tail" }] }, { sessionManager: { getEntries: () => entries } });
    expect(result.messages[1]).toMatchObject({ role: "custom", display: false, content: "fresh segment" });
    expect(result.messages[2]).toMatchObject({ role: "custom", display: false, content: "complete fallback" });
    clearCompactionHistoryForTests();
  });

  test("invalid primary config blocks fallback and normalizes new numeric values", () => {
    const root = mkdtempSync(join(tmpdir(), "vcc-config-invalid-"));
    const primary = join(root, "primary.json");
    const fallback = join(root, "fallback.json");
    writeFileSync(primary, "{broken");
    writeFileSync(fallback, JSON.stringify({ debug: true, recallResponseMaxChars: -1 }));
    const previousOmp = process.env.OMP_VCC_CONFIG_PATH;
    const previousPi = process.env.PI_VCC_CONFIG_PATH;
    process.env.OMP_VCC_CONFIG_PATH = primary;
    process.env.PI_VCC_CONFIG_PATH = fallback;
    const settings = loadSettings({ ui: { notify: () => {} } });
    expect(settings.debug).toBe(false);
    expect(settings.recallResponseMaxChars).toBe(48_000);
    if (previousOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
    else process.env.OMP_VCC_CONFIG_PATH = previousOmp;
    if (previousPi === undefined) delete process.env.PI_VCC_CONFIG_PATH;
    else process.env.PI_VCC_CONFIG_PATH = previousPi;
    rmSync(root, { recursive: true, force: true });
  });
});
