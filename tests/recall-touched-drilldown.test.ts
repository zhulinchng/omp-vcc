// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRecallTool } from "../extensions/vcc-core/hook";
import { parseDrillDown } from "../extensions/vcc-core/core/drill-down";
import { formatTouchedOutput, TOUCHED_PAGE_SIZE } from "../extensions/vcc-core/core/format-recall";
import type { TouchedFile } from "../extensions/vcc-core/core/search-entries";

// ── Helpers ───────────────────────────────────────────────────────────────

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

let dirCount = 0;
const makeSession = (entries: any[]) => {
  const dir = mkdtempSync(join(tmpdir(), `pi-vcc-touched-${dirCount++}-`));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return { dir, file, ids: entries.filter((e) => e.type === "message" && e.message).map((e) => e.id) };
};

const register = () => {
  let tool: any;
  registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any);
  return tool;
};

const invoke = async (
  tool: any,
  file: string,
  ids: string[],
  params: Record<string, unknown>,
  branch?: string[],
) => {
  const result = await tool.execute("tool-call", params, undefined, undefined, {
    sessionManager: {
      getSessionFile: () => file,
      getBranch: () => (branch ?? ids).map((id) => ({ id })),
      getEntries: () => ids.map((id) => ({ id })),
    },
  });
  return result.content[0].text as string;
};

// ── mode:touched ─────────────────────────────────────────────────────────

describe("vcc_recall mode:touched", () => {
  it("aggregates multiple edits on the same file into one line with chronological indices", async () => {
    const entries = [
      toolMsg("m0", "edit", { path: "src/a.ts", oldText: "x", newText: "y" }),
      toolMsg("m1", "quick_edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }),
      toolMsg("m2", "write", { path: "src/b.ts", content: "line1\nline2" }),
    ];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = register();
      const out = await invoke(tool, file, ids, { mode: "touched" });
      expect(out).toContain("src/a.ts");
      expect(out).toContain("#0 (edit), #1 (quick_edit)");
      expect(out).toContain("src/b.ts");
      expect(out).toContain("#2 (write)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies by shape: custom tool with path+content counts; Read with path-only args is excluded", async () => {
    const entries = [
      toolMsg("m0", "my_custom_tool", { path: "src/custom.ts", content: "hello\nworld" }),
      toolMsg("m1", "read", { path: "src/readonly.ts" }),
    ];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = register();
      const out = await invoke(tool, file, ids, { mode: "touched" });
      expect(out).toContain("src/custom.ts");
      expect(out).toContain("#0 (my_custom_tool)");
      expect(out).not.toContain("src/readonly.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("empty session has no touchable files", async () => {
    const entries = [userMsg("m0", "hello"), userMsg("m1", "world")];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = register();
      const out = await invoke(tool, file, ids, { mode: "touched" });
      expect(out).toContain("No file operations found in session history.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects scope: file on another branch only with scope all, indices unshifted", async () => {
    const entries = [
      toolMsg("m0", "edit", { path: "src/on.ts", oldText: "x", newText: "y" }),
      toolMsg("m1", "edit", { path: "src/off.ts", oldText: "x", newText: "y" }),
      toolMsg("m2", "edit", { path: "src/on.ts", oldText: "a", newText: "b" }),
    ];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = register();
      const lineage = ["m0", "m2"];

      const defaultOut = await invoke(tool, file, ids, { mode: "touched" }, lineage);
      expect(defaultOut).toContain("src/on.ts");
      expect(defaultOut).toContain("#0 (edit), #2 (edit)");
      expect(defaultOut).not.toContain("src/off.ts");

      const allOut = await invoke(tool, file, ids, { mode: "touched", scope: "all" });
      expect(allOut).toContain("src/off.ts");
      expect(allOut).toContain("#1 (edit)");
      expect(allOut).toContain("src/on.ts");
      expect(allOut).toContain("#2 (edit)"); // index unshifted
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pages when more files than page size", async () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      toolMsg(`m${i}`, "write", { path: `src/f${i}.ts`, content: "x" }),
    );
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = register();
      const page1 = await invoke(tool, file, ids, { mode: "touched" });
      expect(page1).toContain("Page 1/2 (7 total files)");
      expect(page1).toContain("--- Use page:2 for more results ---");
      expect(page1).toContain("src/f0.ts");
      expect(page1).not.toContain("src/f5.ts");

      const page2 = await invoke(tool, file, ids, { mode: "touched", page: 2 });
      expect(page2).toContain("Page 2/2 (7 total files)");
      expect(page2).toContain("src/f5.ts");
      expect(page2).not.toContain("--- Use page:3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── #N:path drill-down ────────────────────────────────────────────────────

describe("vcc_recall drill-down", () => {
  const bigContent = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

  it("expands an entry index from touched output", async () => {
    const entries = [
      toolMsg("m0", "edit", { path: "src/a.ts", oldText: "x", newText: "y" }),
      toolMsg("m1", "write", { path: "src/b.ts", content: "line1\nline2" }),
    ];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = register();
      const touched = await invoke(tool, file, ids, { mode: "touched" });
      // #1 from touched output points at m1 (src/b.ts)
      expect(touched).toContain("#1 (write)");
      const expanded = await invoke(tool, file, ids, { expand: [1] });
      expect(expanded).toContain("src/b.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#N:path previews file content", async () => {
    const entries = [toolMsg("m1", "write", { path: "src/big.ts", content: bigContent })];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = register();
      const out = await invoke(tool, file, ids, { query: "#0:src/big.ts" });
      expect(out).toContain("File: src/big.ts");
      expect(out).toContain("line 0");
      expect(out).not.toContain("line 39"); // preview truncates at 30 lines
      expect(out).toContain("more lines");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#N:path:full returns the complete content", async () => {
    const entries = [toolMsg("m1", "write", { path: "src/big.ts", content: bigContent })];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = register();
      const out = await invoke(tool, file, ids, { query: "#0:src/big.ts:full" });
      expect(out).toContain("File: src/big.ts");
      expect(out).toContain("line 39");
      expect(out).not.toContain("more lines");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inline mention is treated as a normal search, not drill-down", async () => {
    const entries = [toolMsg("m1", "write", { path: "src/big.ts", content: bigContent })];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = register();
      const out = await invoke(tool, file, ids, { query: "see #1:src/big.ts" });
      expect(out).not.toContain("File: src/big.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Unit: parseDrillDown anchoring ────────────────────────────────────────

describe("parseDrillDown", () => {
  it("anchors on ^ so inline mentions are not drill-down", () => {
    expect(parseDrillDown("#42:auth.ts")).not.toBeNull();
    expect(parseDrillDown("#42:auth.ts:full")).not.toBeNull();
    expect(parseDrillDown("check #42:auth.ts")).toBeNull();
    expect(parseDrillDown("see #42:auth.ts here")).toBeNull();
  });

  it("parses full / offset / offset:limit suffixes", () => {
    expect(parseDrillDown("#42:auth.ts:full")).toMatchObject({ index: 42, pathPattern: "auth.ts", full: true });
    expect(parseDrillDown("#42:auth.ts:30")).toMatchObject({ index: 42, pathPattern: "auth.ts", full: false, offset: 30 });
    expect(parseDrillDown("#42:auth.ts:30:20")).toMatchObject({ index: 42, pathPattern: "auth.ts", full: false, offset: 30, limit: 20 });
  });
});

// ── Unit: formatTouchedOutput paging ──────────────────────────────────────

describe("formatTouchedOutput", () => {
  const tf = (path: string, index: number): TouchedFile => ({ path, entries: [{ index, toolName: "edit" }] });

  it("shows page header and footer when there are more pages", () => {
    const files = Array.from({ length: TOUCHED_PAGE_SIZE + 2 }, (_, i) => tf(`src/f${i}.ts`, i));
    const out = formatTouchedOutput(files, 1);
    expect(out).toContain(`Page 1/2 (${files.length} total files)`);
    expect(out).toContain("--- Use page:2 for more results ---");
  });

  it("returns empty-state message when no files", () => {
    expect(formatTouchedOutput([])).toContain("No file operations found in session history.");
  });
});
describe("drill-down scope", () => {
  it("blocks #N:path on off-lineage entries by default, allows with scope all", async () => {
    const entries = [
      toolMsg("m0", "edit", { path: "src/on.ts", oldText: "x", newText: "y" }),
      toolMsg("m1", "edit", { path: "src/off.ts", oldText: "secret-old", newText: "secret-new" }),
      toolMsg("m2", "edit", { path: "src/on.ts", oldText: "a", newText: "b" }),
    ];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = register();
      const lineage = ["m0", "m2"];

      // off-lineage entry blocked under default scope
      const blocked = await invoke(tool, file, ids, { query: "#1:off.ts" }, lineage);
      expect(blocked).toContain("Cannot expand indices outside active lineage: 1");
      expect(blocked).not.toContain("secret-old");

      // on-lineage entry still drills under default scope
      const onOut = await invoke(tool, file, ids, { query: "#2:on.ts" }, lineage);
      expect(onOut).toContain("src/on.ts");

      // scope:'all' reaches the other branch
      const allOut = await invoke(tool, file, ids, { query: "#1:off.ts", scope: "all" });
      expect(allOut).toContain("src/off.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
