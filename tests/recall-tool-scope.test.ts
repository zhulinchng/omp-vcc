// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
