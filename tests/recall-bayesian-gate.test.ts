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

const makeFactoryPi = (capture: { tool?: any; handler?: any; sent?: any[] }) => {
  const sent: Array<{ customType: string; content: string; display: boolean }> = [];
  (extension as any)({
    on: () => {},
    registerTool: (t: any) => { if (t.name === "vcc_recall") capture.tool = t; },
    registerCommand: (name: string, command: { handler: any }) => {
      if (name === "vcc-recall") capture.handler = command.handler;
    },
    zod: mockZod,
    sendMessage: (msg: any) => { sent.push(msg); },
    sendUserMessage: async () => {},
  });
  capture.sent = sent;
};

// Integration: Bayesian posterior gate × the rest of the recall system.
// Everything here runs through the production factory paths (tool/command,
// default tuning, scope filtering, pagination, expand/drill-down, touched
// mode) — the unit suites pin the gate math itself; this suite pins what
// the gate does to tool-facing behavior.

const userMsg = (id: string, content: string) => ({
  type: "message",
  id,
  message: { role: "user", content },
});

let dirCount = 0;
const makeSession = (entries: any[]) => {
  const dir = mkdtempSync(join(tmpdir(), `pi-vcc-bayes-gate-${dirCount++}-`));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  const ids = entries.filter((e) => e.type === "message" && e.message).map((e) => e.id);
  return { dir, file, ids };
};

const registerTool = () => {
  const capture: { tool?: any } = {};
  makeFactoryPi(capture);
  return capture.tool;
};

const invokeTool = async (
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

const STRONG_0 = "alpha beta gamma delta alpha beta gamma delta design notes";
const STRONG_1 = "alpha beta gamma delta review one decision";
const WEAK = ["alpha noted briefly", "beta mention here", "gamma aside comment"];

const gradedEntries = () => [
  userMsg("m0", STRONG_0),
  userMsg("m1", STRONG_1),
  userMsg("m2", WEAK[0]),
  userMsg("m3", WEAK[1]),
  userMsg("m4", WEAK[2]),
];

describe("vcc_recall Bayesian gate integration", () => {
  it("filters the weak multi-term tail from tool counts but keeps the top hits", async () => {
    const { dir, file, ids } = makeSession(gradedEntries());
    try {
      const tool = registerTool();
      const out = await invokeTool(tool, file, ids, { query: "alpha beta gamma delta" });
      expect(out).toContain("2 matches");
      expect(out).toContain("design notes");
      expect(out).toContain("review one decision");
      expect(out).not.toContain("aside comment");
      expect(out).not.toContain("noted briefly");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never reports No matches when a top hit survives — keep-first holds end to end", async () => {
    const { dir, file, ids } = makeSession([userMsg("m0", STRONG_0), userMsg("m1", WEAK[0])]);
    try {
      const tool = registerTool();
      const out = await invokeTool(tool, file, ids, { query: "alpha beta gamma delta" });
      expect(out).toContain("1 matches");
      expect(out).toContain("design notes");
      expect(out).not.toContain("No matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gated-out entries stay reachable via expand and #N drill-down", async () => {
    const { dir, file, ids } = makeSession(gradedEntries());
    try {
      const tool = registerTool();
      const gated = await invokeTool(tool, file, ids, { query: "alpha beta gamma delta" });
      expect(gated).not.toContain("aside comment"); // index 4 filtered from search…

      const expanded = await invokeTool(tool, file, ids, { expand: [4] });
      expect(expanded).toContain("#4 [user]");
      expect(expanded).toContain("aside comment"); // …but still expandable by index

      const drilled = await invokeTool(tool, file, ids, { query: "#4" });
      expect(drilled).toContain("aside comment"); // …and resolvable via entry ref
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("paginates the gated set: page 2 works, page 3 reports the gated range", async () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      userMsg(`m${i}`, `alpha beta gamma delta review number ${i} decision`));
    entries.push(userMsg("m6", WEAK[0]), userMsg("m7", WEAK[2]));
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = registerTool();
      const p1 = await invokeTool(tool, file, ids, { query: "alpha beta gamma delta" });
      expect(p1).toContain("Page 1/2 (6 total matches)");
      expect(p1).toContain("Use page:2");

      const p2 = await invokeTool(tool, file, ids, { query: "alpha beta gamma delta", page: 2 });
      expect(p2).toContain("Page 2/2");
      expect(p2).toContain("review number 5 decision");

      const p3 = await invokeTool(tool, file, ids, { query: "alpha beta gamma delta", page: 3 });
      expect(p3).toContain("Page 3 is outside the available range 1-2 (6 matches");
      expect(p3).toContain("refine your query");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lineage scope gates its filtered set; scope:all gates the full set", async () => {
    const { dir, file, ids } = makeSession([
      userMsg("m0", STRONG_0),
      userMsg("m1", WEAK[0]),
      userMsg("m2", STRONG_1),
    ]);
    try {
      const tool = registerTool();
      // Active lineage = m0 only: single matching entry survives via keep-first.
      const lineage = await invokeTool(tool, file, ids, { query: "alpha beta gamma delta" }, ["m0"]);
      expect(lineage).toContain("1 matches");
      expect(lineage).toContain("design notes");

      // Whole session: both strong entries survive, weak filtered, labeled.
      const all = await invokeTool(tool, file, ids, { query: "alpha beta gamma delta", scope: "all" });
      expect(all).toContain("2 matches (scope: all)");
      expect(all).toContain("design notes");
      expect(all).toContain("review one decision");
      expect(all).not.toContain("noted briefly");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mode:touched ignores the gate entirely", async () => {
    const entries = [
      { type: "message", id: "m0", message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: "src/a.ts", oldText: "x", newText: "y" } }] } },
      userMsg("m1", "alpha beta gamma delta design notes"),
    ];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = registerTool();
      const out = await invokeTool(tool, file, ids, { mode: "touched", query: "alpha beta gamma delta" });
      expect(out).toContain("src/a.ts");
      expect(out).toContain("#0 (edit)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("zero-hit phrasing is unchanged", async () => {
    const { dir, file, ids } = makeSession(gradedEntries());
    try {
      const tool = registerTool();
      const out = await invokeTool(tool, file, ids, { query: "xyz123nomatch" });
      expect(out).toBe('No matches for "xyz123nomatch" in session history.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("single-term queries return every match through the tool", async () => {
    const { dir, file, ids } = makeSession([
      userMsg("m0", "the redis cache invalidation kept failing"),
      userMsg("m1", "redis"),
      userMsg("m2", "unrelated changelog entry"),
      userMsg("m3", "redis redis redis cluster topology notes"),
    ]);
    try {
      const tool = registerTool();
      const out = await invokeTool(tool, file, ids, { query: "redis" });
      expect(out).toContain("3 matches");
      expect(out).toContain("invalidation");
      expect(out).toContain("topology");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a 300-entry session completes inside budget with the tail collapsed", async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      userMsg(`m${i}`, `alpha beta gamma delta review number ${i} decision`));
    for (let i = 5; i < 300; i++) entries.push(userMsg(`m${i}`, `alpha noted in padding ${i} lorem ipsum dolor`));
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = registerTool();
      const out = await invokeTool(tool, file, ids, { query: "alpha beta gamma delta" });
      expect(out).toContain("5 matches");
      expect(out).toContain("review number 0 decision");
      expect(out).not.toContain("No matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a strong thinking-only match survives the gate", async () => {
    const marker = "zephyr internal plan upside down alpha beta gamma delta twice";
    const entries = [
      { type: "message", id: "m0", message: { role: "assistant", content: [{ type: "thinking", thinking: marker }] } },
      userMsg("m1", WEAK[0]),
      userMsg("m2", WEAK[1]),
    ];
    const { dir, file, ids } = makeSession(entries);
    try {
      const tool = registerTool();
      const out = await invokeTool(tool, file, ids, { query: "zephyr upside alpha beta" });
      expect(out).toContain("zephyr internal plan");
      expect(out).not.toContain("No matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/vcc-recall command Bayesian gate integration", () => {
  const register = () => {
    const capture: { handler?: any; sent?: any[] } = {};
    makeFactoryPi(capture);
    return { handler: capture.handler!, sent: capture.sent! };
  };

  it("gates the multi-term tail in command output", async () => {
    const { dir, file, ids } = makeSession(gradedEntries());
    try {
      const { handler, sent } = register();
      await handler("alpha beta gamma delta", {
        sessionManager: {
          getSessionFile: () => file,
          getBranch: () => ids.map((id) => ({ id })),
          getEntries: () => ids.map((id) => ({ id })),
        },
        ui: { notify: () => {} },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0].content).toContain("2 matches");
      expect(sent[0].content).toContain("design notes");
      expect(sent[0].content).not.toContain("aside comment");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
