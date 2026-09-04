// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseEntryRef, expandEntry } from "../extensions/vcc-core/core/drill-down";
import { renderMessage } from "../extensions/vcc-core/core/render-entries";
import { loadAllMessages } from "../extensions/vcc-core/core/load-messages";
import { formatRecallOutput } from "../extensions/vcc-core/core/format-recall";
import extension from "../extensions/main";

const chain: any = { optional: () => chain, describe: () => chain };
const mockZod: any = {
  object: (o: any) => o,
  boolean: () => chain,
  string: () => chain,
  array: (_a: any) => chain,
  number: () => chain,
  enum: (_a: any) => chain,
};

const register = () => {
  let tool: any;
  (extension as any)({
    on: () => {},
    registerTool: (t: any) => { if (t.name === "vcc_recall") tool = t; },
    registerCommand: () => {},
    zod: mockZod,
    sendMessage: () => {},
    sendUserMessage: async () => {},
  });
  return tool;
};

let dirCount = 0;
const makeSession = (entries: any[]) => {
  const dir = mkdtempSync(join(tmpdir(), `vcc-entryref-${dirCount++}-`));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return { dir, file };
};

const userMsg = (id: string, content: string) => ({
  type: "message",
  id,
  message: { role: "user", content },
});

const asstMsg = (id: string, text: string) => ({
  type: "message",
  id,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const LONG_TEXT = Array.from({ length: 50 }, (_, i) => `line${i} sigma${i}`).join("\n");

const makeLongSession = () => makeSession([
  userMsg("m0", LONG_TEXT),
  asstMsg("m1", "short reply"),
  { type: "message", id: "m2", message: { role: "toolResult", toolName: "Read", toolCallId: "tc_1", content: "file body here", isError: false } },
]);

// ── parseEntryRef ─────────────────────────────────────────────────────────

describe("parseEntryRef", () => {
  it("parses bare #N", () => {
    expect(parseEntryRef("#42")).toMatchObject({ index: 42, full: false });
  });

  it("parses :full / :offset / :offset:limit suffixes", () => {
    expect(parseEntryRef("#42:full")).toMatchObject({ index: 42, full: true });
    expect(parseEntryRef("#42:30")).toMatchObject({ index: 42, full: false, offset: 30 });
    expect(parseEntryRef("#42:30:20")).toMatchObject({ index: 42, full: false, offset: 30, limit: 20 });
  });

  it("rejects non-refs (plain queries, file paths, inline mentions)", () => {
    expect(parseEntryRef("redis cache")).toBeNull();
    expect(parseEntryRef("#42:auth.ts")).toBeNull();
    expect(parseEntryRef("check #42")).toBeNull();
  });
});

// ── expandEntry ───────────────────────────────────────────────────────────

describe("expandEntry", () => {
  it("previews long entries with a :full hint", () => {
    const { dir, file } = makeLongSession();
    try {
      const out = expandEntry(file, 0);
      expect(out).toContain("#0 [user]");
      expect(out).toContain("line0 sigma0");
      expect(out).toContain("...(20 more lines");
      expect(out).not.toContain("line49 sigma49");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(":full returns the complete renderMessage summary verbatim", () => {
    const { dir, file } = makeLongSession();
    try {
      const { rawMessages } = loadAllMessages(file, true);
      const expected = renderMessage(rawMessages[0] as any, 0, true).summary;
      expect(expandEntry(file, 0, true)).toBe(`#0 [user]\n\n${expected}`);
      expect(expected).toContain("line49 sigma49");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("windows with a Lines X-Y (of Z) header", () => {
    const { dir, file } = makeLongSession();
    try {
      const out = expandEntry(file, 0, false, 10, 5);
      expect(out).toContain("Lines 11-15 (of 50)");
      expect(out).toContain("line10 sigma10");
      expect(out).not.toContain("line9 sigma9");
      expect(out).toContain("#0:15");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves assistant and tool_result entries with role tags", () => {
    const { dir, file } = makeLongSession();
    try {
      expect(expandEntry(file, 1)).toBe("#1 [assistant]\n\nshort reply");
      expect(expandEntry(file, 2)).toContain("#2 [tool_result]");
      expect(expandEntry(file, 2)).toContain("file body here");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports out-of-range indices", () => {
    const { dir, file } = makeLongSession();
    try {
      expect(expandEntry(file, 99)).toContain("Entry #99 not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── recall dispatch + guidance footer ─────────────────────────────────────

describe("recall #N dispatch and guidance footer", () => {
  it("routes a bare #N query to the full entry through the recall tool", async () => {
    const { dir, file } = makeLongSession();
    try {
      const tool = register();
      const result = await tool.execute("tc", { query: "#1", scope: "all" }, undefined, undefined, {
        sessionManager: { getSessionFile: () => file },
      });
      const text = result.content[0].text as string;
      expect(text).toContain("#1 [assistant]");
      expect(text).toContain("short reply");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends the #N hint on capped results and clipped snippets only", () => {
    const clipped = [{ index: 3, role: "assistant", summary: "s", snippet: "hit\n...(2 lines below)" }];
    expect(formatRecallOutput(clipped as any, "q")).toContain("Use #N for full entry text");
    const plain = [{ index: 3, role: "assistant", summary: "s", snippet: "plain match line" }];
    expect(formatRecallOutput(plain as any, "q")).not.toContain("Use #N");
    const capped = formatRecallOutput(plain as any, "q", undefined, { truncated: true, totalBeforeCap: 60 });
    expect(capped).toContain("Use #N for full entry text");
  });
});
