// @ts-nocheck
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseDrillDown,
  parseEntryRef,
  expandEntryFile,
  expandEntry,
} from "../extensions/vcc-core/core/drill-down.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

let dirCount = 0;
const makeSession = (entries: any[]) => {
  const dir = mkdtempSync(join(tmpdir(), `pi-vcc-drillgaps-${dirCount++}-`));
  tmpDirs.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return file;
};

const toolMsg = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "message",
  id,
  message: {
    role: "assistant",
    content: [{ type: "toolCall", name, arguments: args }],
  },
});

const userMsg = (id: string, content: string) => ({
  type: "message",
  id,
  message: { role: "user", content },
});

const textMsg = (id: string, text: string) => ({
  type: "message",
  id,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const lines = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`).join("\n");

// ── findContentBearingCalls filtering (via expandEntryFile) ────────────────

describe("drill-down gaps: findContentBearingCalls filtering", () => {
  it("non-array content yields zero calls", () => {
    const file = makeSession([userMsg("m0", "just chatting")]);
    expect(expandEntryFile(file, 0, "file")).toContain("No file content found in entry #0.");
  });

  it("non-toolCall parts are skipped", () => {
    const file = makeSession([textMsg("m0", "plain assistant text")]);
    expect(expandEntryFile(file, 0, "file")).toContain("No file content found in entry #0.");
  });

  it("args failing isContentBearing (path without content fields) are skipped", () => {
    const file = makeSession([toolMsg("m0", "edit", { path: "src/a.ts" })]);
    expect(expandEntryFile(file, 0, "file")).toContain("No file content found in entry #0.");
  });

  it("content-bearing args with missing path are skipped", () => {
    const file = makeSession([toolMsg("m0", "write", { content: "orphan content" })]);
    expect(expandEntryFile(file, 0, "file")).toContain("No file content found in entry #0.");
  });

  it("edits array with non-object entries is rejected", () => {
    const file = makeSession([
      toolMsg("m0", "edit", {
        path: "src/a.ts",
        edits: ["junk", null, { oldText: "a", newText: "b" }],
      }),
    ]);
    expect(expandEntryFile(file, 0, "file")).toContain("No file content found in entry #0.");
  });

  it("oldText/newText are suppressed when edits array is present", () => {
    const file = makeSession([
      toolMsg("m0", "edit", {
        path: "src/a.ts",
        edits: [{ oldText: "edit-old", newText: "edit-new" }],
        oldText: "SUPPRESSED-OLD",
        newText: "SUPPRESSED-NEW",
      }),
    ]);
    const out = expandEntryFile(file, 0, "src/a.ts");
    expect(out).toContain("edit-old");
    expect(out).not.toContain("SUPPRESSED-OLD");
    expect(out).not.toContain("SUPPRESSED-NEW");
  });

  it("oldText/newText are carried when edits array is absent", () => {
    const file = makeSession([
      toolMsg("m0", "edit", { path: "src/a.ts", oldText: "before-x", newText: "after-x" }),
    ]);
    const out = expandEntryFile(file, 0, "src/a.ts");
    expect(out).toContain("--- old ---");
    expect(out).toContain("before-x");
    expect(out).toContain("after-x");
  });

  it("content string is carried onto the call", () => {
    const file = makeSession([
      toolMsg("m0", "write", { path: "src/a.ts", content: "carried-content-123" }),
    ]);
    expect(expandEntryFile(file, 0, "src/a.ts")).toContain("carried-content-123");
  });
});

// ── formatToolCallContent branches (via expandEntryFile) ───────────────────

describe("drill-down gaps: formatToolCallContent rendering", () => {
  it("edits branch renders per-edit separators", () => {
    const file = makeSession([
      toolMsg("m0", "edit", {
        path: "src/e.ts",
        edits: [
          { oldText: "a", newText: "b" },
          { oldText: "c", newText: "d" },
        ],
      }),
    ]);
    const out = expandEntryFile(file, 0, "src/e.ts");
    expect(out).toContain("--- edit 1 ---");
    expect(out).toContain("--- edit 2 ---");
    expect(out).toContain("--- becomes ---");
  });

  it("newText-only call hits the no-content branch", () => {
    const file = makeSession([toolMsg("m0", "edit", { path: "solo.ts", newText: "only-new" })]);
    expect(expandEntryFile(file, 0, "solo.ts")).toContain("(no file content");
  });

  it("full mode truncates files exceeding the 50KB display limit", () => {
    const file = makeSession([
      toolMsg("m0", "write", { path: "big.bin", content: "x".repeat(52_000) }),
    ]);
    const out = expandEntryFile(file, 0, "big.bin", true);
    expect(out).toContain("exceeds 50KB display limit");
  });

  it("offset middle page shows the next-page hint", () => {
    const file = makeSession([toolMsg("m0", "write", { path: "mid.ts", content: lines(50, "row") })]);
    const out = expandEntryFile(file, 0, "mid.ts", false, 10);
    expect(out).toContain("Lines 11-40 (of 50)");
    expect(out).toContain("for next 30 lines");
  });

  it("offset last page shows the end-of-file marker", () => {
    const file = makeSession([toolMsg("m0", "write", { path: "mid.ts", content: lines(50, "row") })]);
    const out = expandEntryFile(file, 0, "mid.ts", false, 40);
    expect(out).toContain("Lines 41-50 (of 50)");
    expect(out).toContain("(End of file)");
  });

  it("offset beyond length reports the file length", () => {
    const file = makeSession([toolMsg("m0", "write", { path: "mid.ts", content: lines(10, "row") })]);
    expect(expandEntryFile(file, 0, "mid.ts", false, 999)).toContain("is beyond file length 10");
  });

  it("preview truncates past 30 lines with a continuation hint", () => {
    const file = makeSession([toolMsg("m0", "write", { path: "long.ts", content: lines(40, "ln") })]);
    const out = expandEntryFile(file, 0, "long.ts");
    expect(out).toContain("ln-0");
    expect(out).not.toContain("ln-39");
    expect(out).toContain("more lines");
  });
});

// ── parseDrillDown gaps ────────────────────────────────────────────────────

describe("drill-down gaps: parseDrillDown edge inputs", () => {
  it("rejects inline prefixes and missing segments; trailing text joins the path", () => {
    expect(parseDrillDown("prefix #7:src/b.ts")).toBeNull();
    expect(parseDrillDown("#7:src/b.ts suffix")).toMatchObject({
      index: 7,
      pathPattern: "src/b.ts suffix",
    });
    expect(parseDrillDown("#7")).toBeNull();
    expect(parseDrillDown("#7:")).toBeNull();
    expect(parseDrillDown("#:src/b.ts")).toBeNull();
    expect(parseDrillDown("#x:src/b.ts")).toBeNull();
  });
  it("parses the :full suffix with empty offset and limit", () => {
    expect(parseDrillDown("#7:src/b.ts:full")).toMatchObject({
      index: 7,
      pathPattern: "src/b.ts",
      full: true,
      offset: undefined,
      limit: undefined,
    });
  });

  it("parses the :offset suffix with default limit", () => {
    expect(parseDrillDown("#7:src/b.ts:30")).toMatchObject({
      index: 7,
      pathPattern: "src/b.ts",
      full: false,
      offset: 30,
      limit: undefined,
    });
  });

  it("parses the :offset:limit suffix pair", () => {
    expect(parseDrillDown("#7:src/b.ts:30:20")).toMatchObject({
      index: 7,
      pathPattern: "src/b.ts",
      full: false,
      offset: 30,
      limit: 20,
    });
  });

  it("no-suffix query yields preview mode fields", () => {
    expect(parseDrillDown("#7:src/b.ts")).toMatchObject({
      index: 7,
      pathPattern: "src/b.ts",
      full: false,
      offset: undefined,
      limit: undefined,
    });
  });
});

// ── parseEntryRef ──────────────────────────────────────────────────────────

describe("drill-down gaps: parseEntryRef forms", () => {
  it("parses a bare #N ref", () => {
    expect(parseEntryRef("#42")).toMatchObject({
      index: 42,
      full: false,
      offset: undefined,
      limit: undefined,
    });
  });

  it("parses the #N:full form", () => {
    expect(parseEntryRef("#42:full")).toMatchObject({ index: 42, full: true });
  });

  it("parses the #N:offset form", () => {
    expect(parseEntryRef("#42:30")).toMatchObject({ index: 42, full: false, offset: 30 });
  });

  it("parses the #N:offset:limit form", () => {
    expect(parseEntryRef("#42:30:20")).toMatchObject({
      index: 42,
      full: false,
      offset: 30,
      limit: 20,
    });
  });

  it("returns null for non-numeric and non-entry patterns", () => {
    expect(parseEntryRef("#x")).toBeNull();
    expect(parseEntryRef("#42:auth.ts")).toBeNull();
    expect(parseEntryRef("#42:30:20:10")).toBeNull();
    expect(parseEntryRef("check #42")).toBeNull();
    expect(parseEntryRef("")).toBeNull();
  });
});

// ── expandEntryFile routing ────────────────────────────────────────────────

describe("drill-down gaps: expandEntryFile routing", () => {
  it("reports a negative entry index as out of range", () => {
    const file = makeSession([toolMsg("m0", "write", { path: "a.ts", content: "hi" })]);
    expect(expandEntryFile(file, -1, "file")).toContain("Entry #-1 not found in session history.");
  });

  it("reports an index past the end as out of range", () => {
    const file = makeSession([toolMsg("m0", "write", { path: "a.ts", content: "hi" })]);
    expect(expandEntryFile(file, 5, "file")).toContain("Entry #5 not found in session history.");
  });

  it("#N:file with zero calls reports no file content", () => {
    const file = makeSession([userMsg("m0", "hello")]);
    expect(expandEntryFile(file, 0, "file")).toContain("No file content found in entry #0.");
  });

  it("#N:file with one call renders that call", () => {
    const file = makeSession([
      toolMsg("m0", "write", { path: "src/only.ts", content: "solo-body" }),
    ]);
    const out = expandEntryFile(file, 0, "file");
    expect(out).toContain("File: src/only.ts");
    expect(out).toContain("solo-body");
  });

  it("#N:file with multiple calls lists each operation", () => {
    const file = makeSession([
      {
        type: "message",
        id: "m0",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "edit", arguments: { path: "src/a.ts", oldText: "x", newText: "y" } },
            { type: "toolCall", name: "write", arguments: { path: "src/b.ts", content: "z" } },
          ],
        },
      },
    ]);
    const out = expandEntryFile(file, 0, "file");
    expect(out).toContain("has 2 file operations");
    expect(out).toContain("[#0:src/a.ts]");
    expect(out).toContain("Use #0:path to drill into a specific file.");
  });

  it("reports no match for an unmatched path pattern", () => {
    const file = makeSession([toolMsg("m0", "write", { path: "src/a.ts", content: "hi" })]);
    expect(expandEntryFile(file, 0, "missing.ts")).toContain(
      'No file content found in entry #0 for "missing.ts".',
    );
  });

  it("ambiguous multi-match lists options with the more-specific-path hint", () => {
    const file = makeSession([
      {
        type: "message",
        id: "m0",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "edit", arguments: { path: "src/app-one.ts", oldText: "x", newText: "y" } },
            { type: "toolCall", name: "edit", arguments: { path: "src/app-two.ts", oldText: "a", newText: "b" } },
          ],
        },
      },
    ]);
    const out = expandEntryFile(file, 0, "app-");
    expect(out).toContain('has 2 file operations matching "app-"');
    expect(out).toContain("more-specific-path");
  });
});

// ── expandEntry ────────────────────────────────────────────────────────────

describe("drill-down gaps: expandEntry paging", () => {
  it("reports out-of-range indices on both ends", () => {
    const file = makeSession([userMsg("m0", "hi")]);
    expect(expandEntry(file, -1)).toContain("Entry #-1 not found in session history.");
    expect(expandEntry(file, 3)).toContain("Entry #3 not found in session history.");
  });

  it("full mode returns the header plus the complete body", () => {
    const file = makeSession([userMsg("m0", lines(40, "grow"))]);
    const out = expandEntry(file, 0, true);
    expect(out).toContain("#0 [user]");
    expect(out).toContain("grow-39");
    expect(out).not.toContain("more lines");
  });

  it("offset middle page shows the next-lines hint", () => {
    const file = makeSession([userMsg("m0", lines(50, "pg"))]);
    const out = expandEntry(file, 0, false, 10);
    expect(out).toContain("Lines 11-40 (of 50)");
    expect(out).toContain("for next 30 lines");
  });

  it("offset last page shows the end-of-entry marker", () => {
    const file = makeSession([userMsg("m0", lines(50, "pg"))]);
    const out = expandEntry(file, 0, false, 40);
    expect(out).toContain("Lines 41-50 (of 50)");
    expect(out).toContain("(End of entry)");
  });

  it("offset beyond length reports the entry length", () => {
    const file = makeSession([userMsg("m0", lines(10, "pg"))]);
    expect(expandEntry(file, 0, false, 999)).toContain("is beyond entry length 10");
  });

  it("preview truncates past 30 lines with a continuation hint", () => {
    const file = makeSession([userMsg("m0", lines(40, "pv"))]);
    const out = expandEntry(file, 0);
    expect(out).toContain("pv-0");
    expect(out).not.toContain("pv-39");
    expect(out).toContain("more lines");
  });

  it("short body renders verbatim without paging chrome", () => {
    const file = makeSession([userMsg("m0", "short and sweet")]);
    const out = expandEntry(file, 0);
    expect(out).toBe("#0 [user]\n\nshort and sweet");
  });
});
