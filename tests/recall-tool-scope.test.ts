// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import extension from "../extensions/main";
import { loadSettings } from "../extensions/vcc-core/core/settings";

const chain: any = { optional: () => chain, describe: () => chain };
const mockZod: any = {
  object: (o: any) => o,
  boolean: () => chain,
  string: () => chain,
  array: (_a: any) => chain,
  number: () => chain,
  enum: (_a: any) => chain,
};

const makeSession = () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-scope-"));
  const file = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: `active lineage token ${"x".repeat(350)} full-content-end` } }),
    JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: "off lineage secret" } }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return { dir, file };
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

const invoke = async (tool: any, file: string, params: Record<string, unknown>) => {
  const result = await tool.execute("tool-call", params, undefined, undefined, {
    sessionManager: {
      getSessionFile: () => file,
      getBranch: () => [{ id: "m1" }],
      getEntries: () => [{ id: "m1" }, { id: "m2" }],
    },
  });
  return result.content[0].text as string;
};

describe("vcc_recall scope", () => {
  it("defaults to active lineage and opts into all-session search explicitly", async () => {
    const { dir, file } = makeSession();
    try {
      const tool = register();

      const lineage = await invoke(tool, file, { query: "secret" });
      expect(lineage).toContain("No matches");

      const all = await invoke(tool, file, { query: "secret", scope: "all" });
      expect(all).toContain("scope: all");
      expect(all).toContain("off lineage secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands full entries even when the original query is included", async () => {
    const { dir, file } = makeSession();
    try {
      const tool = register();
      const output = await invoke(tool, file, { query: "active", expand: [0] });

      expect(output).toContain("#0 [user]");
      expect(output).toContain("full-content-end");
      expect(output).not.toContain("matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps expand strict by default but allows off-lineage expand with scope all", async () => {
    const { dir, file } = makeSession();
    try {
      const tool = register();

      const lineage = await invoke(tool, file, { expand: [1] });
      expect(lineage).toContain("Cannot expand indices outside active lineage: 1");

      const all = await invoke(tool, file, { expand: [1], scope: "all" });
      expect(all).toContain("Scope: all");
      expect(all).toContain("#1 [user] off lineage secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Input guards and bounded-page labels ───────────────────────────────────

type RecallTool = {
  execute: (
    id: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

const writeJsonl = (root: string, rows: unknown[]) => {
  const file = join(root, "session.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return file;
};

const userRow = (id: string, content: string) => ({
  type: "message",
  id,
  message: { role: "user", content },
});

/** Invoke with every written entry on the active lineage. */
const invokeLineage = async (tool: RecallTool, file: string, ids: string[], params: Record<string, unknown>) => {
  const result = await tool.execute("tool-call", params, undefined, undefined, {
    sessionManager: {
      getSessionFile: () => file,
      getBranch: () => ids.map((id) => ({ id })),
      getEntries: () => ids.map((id) => ({ id })),
    },
  });
  return result.content[0].text;
};

describe("vcc_recall input guards", () => {
  const MANY = Array.from({ length: 12 }, (_, i) => userRow(`m${i}`, `auth decision number ${i}`));

  it("treats a non-numeric page as page 1 instead of reporting no matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-page-"));
    try {
      const file = writeJsonl(dir, MANY);
      const out = await invokeLineage(register(), file, MANY.map((r) => r.id), { query: "auth", page: "two" });
      expect(out).not.toContain("No matches");
      expect(out).not.toContain("NaN");
      expect(out).toContain("12 total matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("coerces a non-string query instead of throwing out of execute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-query-"));
    try {
      const rows = [userRow("m0", "port 8080 configured"), ...MANY];
      const file = writeJsonl(dir, rows);
      const tool = register();
      const out = await invokeLineage(tool, file, rows.map((r) => r.id), { query: 8080 });
      expect(out).toContain("8080");
      expect(out).not.toContain("No matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a null query as absent rather than searching for the text null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-nullq-"));
    try {
      const file = writeJsonl(dir, MANY);
      const out = await invokeLineage(register(), file, MANY.map((r) => r.id), { query: null });
      // The no-query view lists recent entries; it never reports a match count
      // for the literal word "null".
      expect(out).not.toContain('matches for "null"');
      expect(out).toContain("auth decision number 11");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws for a structurally hostile params object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-hostile-"));
    try {
      const file = writeJsonl(dir, MANY);
      const tool = register();
      const ids = MANY.map((r) => r.id);
      for (const params of [{ query: {} }, { query: [] }, { query: true }, { query: null }, { page: {} }, { expand: "x" }, {}]) {
        await expect(invokeLineage(tool, file, ids, params as Record<string, unknown>)).resolves.toBeString();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The block label duplicated its kind: `blockLabel` renders `${kind} ${id}`,
// and the caller already prefixed the id, so the omission marker read
// "omitted page: page page:1". The continuation id must stay `page:N`.
describe("vcc_recall bounded-page omission label", () => {
  const WRITES = Array.from({ length: 6 }, (_, i) => ({
    type: "message",
    id: `t${i}`,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "Write", arguments: { path: `/repo/file${i}.ts`, content: `line${i}` } }],
    },
  }));

  it("labels an omitted page block once, keeping page:N as the continuation id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-label-"));
    const config = join(dir, "config.json");
    const previousOmp = process.env.OMP_VCC_CONFIG_PATH;
    const previousPi = process.env.PI_VCC_CONFIG_PATH;
    try {
      const file = writeJsonl(dir, WRITES);
      writeFileSync(config, JSON.stringify({ recallResponseMaxChars: 30 }));
      // Set BOTH: a concurrent suite setting only one would otherwise shadow
      // this config, and the guard below would fail loudly rather than pass
      // against a default budget the fixture can never exceed.
      process.env.OMP_VCC_CONFIG_PATH = config;
      process.env.PI_VCC_CONFIG_PATH = config;
      expect(loadSettings(undefined).recallResponseMaxChars).toBe(30);

      const out = await invokeLineage(register(), file, WRITES.map((r) => r.id), { mode: "touched" });
      expect(out).toContain("omitted page: page 1");
      expect(out).not.toContain("omitted page: page page:1");
    } finally {
      if (previousOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
      else process.env.OMP_VCC_CONFIG_PATH = previousOmp;
      if (previousPi === undefined) delete process.env.PI_VCC_CONFIG_PATH;
      else process.env.PI_VCC_CONFIG_PATH = previousPi;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
