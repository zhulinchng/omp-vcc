// @ts-nocheck
// Gap coverage for the default factory in extensions/main.ts:
// the inline `vcc_recall` tool execute branches and the
// /omp-vcc, /pi-vcc, /vcc-recall, /pi-vcc-recall command handlers.
// Uses the factory (not the hook-level register* helpers) so nothing here
// overlaps tests/vcc-recall-command.test.ts, tests/pi-vcc-command.test.ts,
// tests/recall-tool-scope.test.ts or tests/before-compact-hook.test.ts.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import extension, {
  PI_VCC_COMPACT_INSTRUCTION,
  OMP_VCC_COMPACT_INSTRUCTION,
} from "../extensions/main.ts";

// ── Harness ─────────────────────────────────────────────────────────────

const chain: any = { optional: () => chain, describe: () => chain };
const mockZod: any = {
  object: (o: any) => o,
  boolean: () => chain,
  string: () => chain,
  array: (_a: any) => chain,
  number: () => chain,
  enum: (_a: any) => chain,
};

function makePi() {
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const sent: Array<{ msg: any; opts: any }> = [];
  const userSent: any[] = [];
  const pi: any = {
    on: () => {},
    registerTool: (t: any) => tools.push(t),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    zod: mockZod,
    sendMessage: (msg: any, opts: any) => sent.push({ msg, opts }),
    sendUserMessage: async (c: any) => userSent.push(c),
  };
  (extension as any)(pi);
  const tool = tools.find((t) => t.name === "vcc_recall");
  return { pi, tool, commands, sent, userSent };
}

let dirCount = 0;
const umsg = (id: string, content: string) => ({
  type: "message",
  id,
  message: { role: "user", content },
});
const toolMsg = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "message",
  id,
  message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
});

function makeSession(entries: any[]) {
  const dir = mkdtempSync(join(tmpdir(), `dispatch-gaps-${dirCount++}-`));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  const ids = entries.map((e) => e.id);
  return { dir, file, ids };
}

const toolCtx = (file: string, branch: string[], all?: string[]) => ({
  sessionManager: {
    getSessionFile: () => file,
    getBranch: () => branch.map((id) => ({ id })),
    getEntries: () => (all ?? branch).map((id) => ({ id })),
  },
});

async function toolText(tool: any, params: any, ctx: any) {
  const res = await tool.execute("tc", params, undefined, undefined, ctx);
  return res.content[0].text as string;
}

function cmdCtx(file: string, ids: string[], notify: any[]) {
  return {
    sessionManager: {
      getSessionFile: () => file,
      getBranch: () => ids.map((id) => ({ id })),
      getEntries: () => ids.map((id) => ({ id })),
    },
    ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
  };
}

// ── vcc_recall tool ─────────────────────────────────────────────────────

describe("dispatch gaps: vcc_recall tool (main factory)", () => {
  test("no session file returns the unavailable message", async () => {
    const { tool } = makePi();
    const out = await toolText(tool, { query: "anything" }, {
      sessionManager: { getSessionFile: () => undefined },
    });
    expect(out).toBe("No session file available.");
  });

  test("entry-ref outside active lineage errors; scope all reaches it", async () => {
    const { dir, file, ids } = makeSession([umsg("m0", "alpha one"), umsg("m1", "off lineage secret")]);
    try {
      const { tool } = makePi();
      const err = await toolText(tool, { query: "#1" }, toolCtx(file, ["m0"], ids));
      expect(err).toContain("Cannot expand indices outside active lineage: 1");
      expect(err).toContain("scope:'all'");

      const ok = await toolText(tool, { query: "#1", scope: "all" }, toolCtx(file, ["m0"], ids));
      expect(ok).toContain("off lineage secret");
      expect(ok).not.toContain("Cannot expand indices");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drill-down outside active lineage errors; scope all reaches the file", async () => {
    const { dir, file, ids } = makeSession([
      umsg("m0", "hello"),
      toolMsg("m1", "edit", { path: "src/off.ts", oldText: "x", newText: "y" }),
    ]);
    try {
      const { tool } = makePi();
      const err = await toolText(tool, { query: "#1:src/off.ts" }, toolCtx(file, ["m0"], ids));
      expect(err).toContain("Cannot expand indices outside active lineage: 1");

      const ok = await toolText(tool, { query: "#1:src/off.ts", scope: "all" }, toolCtx(file, ["m0"], ids));
      expect(ok).toContain("src/off.ts");
      expect(ok).not.toContain("Cannot expand indices");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("touched mode returns aggregated files, not search output", async () => {
    const { dir, file, ids } = makeSession([
      toolMsg("m0", "edit", { path: "src/a.ts", oldText: "x", newText: "y" }),
      umsg("m1", "hello"),
    ]);
    try {
      const { tool } = makePi();
      const out = await toolText(tool, { mode: "touched" }, toolCtx(file, ids));
      expect(out).toContain("src/a.ts");
      expect(out).not.toContain("matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("expand with unknown indices names the right boundary per scope", async () => {
    const { dir, file, ids } = makeSession([umsg("m0", "alpha one"), umsg("m1", "alpha two")]);
    try {
      const { tool } = makePi();
      const lineage = await toolText(tool, { expand: [99] }, toolCtx(file, ids));
      expect(lineage).toContain("Cannot expand indices outside active lineage: 99");

      const all = await toolText(tool, { expand: [99], scope: "all" }, toolCtx(file, ids));
      expect(all).toContain("Cannot expand indices outside session history: 99");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("page beyond total without truncation suggests refining the query", async () => {
    const entries = Array.from({ length: 7 }, (_, i) => umsg(`m${i}`, `zebra_plain entry number ${i}`));
    const { dir, file, ids } = makeSession(entries);
    try {
      const { tool } = makePi();
      const out = await toolText(tool, { query: "zebra_plain", page: 5 }, toolCtx(file, ids));
      expect(out).toContain("Page 5 is outside the available range 1-2");
      expect(out).toContain("7 matches");
      expect(out).toContain("or refine your query");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("page beyond total with truncation omits the duplicate refine hint", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => umsg(`m${i}`, `zebra_cap entry number ${i}`));
    const { dir, file, ids } = makeSession(entries);
    try {
      const { tool } = makePi();
      const out = await toolText(tool, { query: "zebra_cap", page: 11 }, toolCtx(file, ids));
      expect(out).toContain("Page 11 is outside the available range 1-10");
      expect(out).toContain("showing 50 of 60");
      expect(out).toContain("Use a page between 1 and 10.");
      expect(out).not.toContain("or refine your query");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scope all labels the header and points the footer at scope all", async () => {
    const entries = Array.from({ length: 7 }, (_, i) => umsg(`m${i}`, `zebra_scope entry number ${i}`));
    const { dir, file, ids } = makeSession(entries);
    try {
      const { tool } = makePi();
      const out = await toolText(tool, { query: "zebra_scope", scope: "all" }, toolCtx(file, ids));
      expect(out).toContain("(scope: all)");
      expect(out).toContain("with scope:'all'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-query default returns recent messages, prefixed only for scope all", async () => {
    const { dir, file, ids } = makeSession([umsg("m0", "first tail"), umsg("m1", "second tail")]);
    try {
      const { tool } = makePi();
      const recent = await toolText(tool, {}, toolCtx(file, ids));
      expect(recent).toContain("second tail");
      expect(recent).not.toContain("Scope: all");

      const scoped = await toolText(tool, { scope: "all" }, toolCtx(file, ids));
      expect(scoped).toContain("Scope: all");
      expect(scoped).toContain("second tail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("expand with valid indices returns the entries, scope all prefixes output", async () => {
    const { dir, file, ids } = makeSession([umsg("m0", "expand me alpha"), umsg("m1", "expand me beta")]);
    try {
      const { tool } = makePi();
      const out = await toolText(tool, { expand: [0, 1] }, toolCtx(file, ids));
      expect(out).toContain("expand me alpha");
      expect(out).toContain("expand me beta");
      expect(out).not.toContain("Scope: all");

      const scoped = await toolText(tool, { expand: [1], scope: "all" }, toolCtx(file, ids));
      expect(scoped).toContain("Scope: all");
      expect(scoped).toContain("expand me beta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("entry-ref and drill-down inside active lineage expand directly", async () => {
    const { dir, file, ids } = makeSession([
      umsg("m0", "lineage alpha"),
      toolMsg("m1", "write", { path: "/tmp/lineage-file.ts", content: "line one\nline two\n" }),
    ]);
    try {
      const { tool } = makePi();
      const entry = await toolText(tool, { query: "#0" }, toolCtx(file, ids));
      expect(entry).toContain("lineage alpha");
      expect(entry).not.toContain("Cannot expand indices");
      const drill = await toolText(tool, { query: "#1:lineage-file.ts" }, toolCtx(file, ids));
      expect(drill).toContain("line one");
      expect(drill).not.toContain("Cannot expand indices");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── /vcc-recall command ─────────────────────────────────────────────────

describe("dispatch gaps: /vcc-recall command (main factory)", () => {
  test("no session file notifies an error and sends nothing", async () => {
    const { commands, sent } = makePi();
    const notify: any[] = [];
    await commands.get("vcc-recall").handler("", {
      sessionManager: { getSessionFile: () => undefined },
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(notify.some((n) => n.msg === "No session file available.")).toBe(true);
    expect(sent.length).toBe(0);
  });

  test("no-query recent path sends recent and notifies the count", async () => {
    const { dir, file, ids } = makeSession([umsg("m0", "recent marker one"), umsg("m1", "recent marker two")]);
    try {
      const { commands, sent } = makePi();
      const notify: any[] = [];
      await commands.get("vcc-recall").handler("", cmdCtx(file, ids, notify));
      expect(sent.length).toBe(1);
      expect(sent[0].msg.content).toContain("recent marker two");
      expect(notify.some((n) => n.msg.includes("recent"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("page out of range uses /vcc-recall guidance syntax", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => umsg(`m${i}`, `zebra_cmd entry number ${i}`));
    const { dir, file, ids } = makeSession(entries);
    try {
      const { commands, sent } = makePi();
      const notify: any[] = [];
      await commands.get("vcc-recall").handler("zebra_cmd page:11", cmdCtx(file, ids, notify));
      expect(sent.length).toBe(1);
      expect(sent[0].msg.content).toContain("Page 11 is outside the available range 1-10");
      expect(sent[0].msg.content).toContain("/vcc-recall zebra_cmd");
      expect(sent[0].msg.content).toContain("page:N");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scope:all suffix and leading forms both label scope all", async () => {
    const entries = Array.from({ length: 7 }, (_, i) => umsg(`m${i}`, `zebra_sa entry number ${i}`));
    const { dir, file, ids } = makeSession(entries);
    try {
      for (const args of ["zebra_sa scope:all", "scope:all zebra_sa"]) {
        const { commands, sent } = makePi();
        const notify: any[] = [];
        await commands.get("vcc-recall").handler(args, cmdCtx(file, ids, notify));
        expect(sent[0].msg.content).toContain("(scope: all)");
        expect(sent[0].msg.content).toContain("scope:all");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── /pi-vcc-recall command ──────────────────────────────────────────────

describe("dispatch gaps: /pi-vcc-recall command (main factory)", () => {
  test("no session file notifies an error and sends nothing", async () => {
    const { commands, sent } = makePi();
    const notify: any[] = [];
    await commands.get("pi-vcc-recall").handler("", {
      sessionManager: { getSessionFile: () => undefined },
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(notify.some((n) => n.msg === "No session file available.")).toBe(true);
    expect(sent.length).toBe(0);
  });

  test("no-query recent path sends without notifying (unlike /vcc-recall)", async () => {
    const { dir, file, ids } = makeSession([umsg("m0", "pi recent one"), umsg("m1", "pi recent two")]);
    try {
      const { commands, sent } = makePi();
      const notify: any[] = [];
      await commands.get("pi-vcc-recall").handler("", cmdCtx(file, ids, notify));
      expect(sent.length).toBe(1);
      expect(sent[0].msg.content).toContain("pi recent two");
      expect(notify.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("query footer points at /pi-vcc-recall", async () => {
    const entries = Array.from({ length: 7 }, (_, i) => umsg(`m${i}`, `zebra_pi entry number ${i}`));
    const { dir, file, ids } = makeSession(entries);
    try {
      const { commands, sent } = makePi();
      const notify: any[] = [];
      await commands.get("pi-vcc-recall").handler("zebra_pi", cmdCtx(file, ids, notify));
      expect(sent[0].msg.content).toContain("/pi-vcc-recall zebra_pi");
      expect(sent[0].msg.content).not.toContain("--- /vcc-recall ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── /omp-vcc and /pi-vcc commands ───────────────────────────────────────

describe("dispatch gaps: /omp-vcc and /pi-vcc commands (main factory)", () => {
  test("/omp-vcc falls back to the omp-vcc compacted notice with no stats", async () => {
    const { commands } = makePi();
    const notify: any[] = [];
    let compactArg: any = null;
    await commands.get("omp-vcc").handler("", {
      compact: async (arg: any) => { compactArg = arg; },
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(compactArg).toBe(OMP_VCC_COMPACT_INSTRUCTION);
    expect(notify.some((n) => n.msg === "Compacted with omp-vcc")).toBe(true);
  });

  test("/omp-vcc follow-up prompt is sent as a user message", async () => {
    const { commands, userSent } = makePi();
    const notify: any[] = [];
    await commands.get("omp-vcc").handler("fix auth", {
      compact: async () => {},
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(userSent).toContain("fix auth");
  });

  test("/omp-vcc cancellation maps to a nothing-to-compact warning", async () => {
    for (const err of ["Compaction cancelled", "Already compacted"]) {
      const { commands } = makePi();
      const notify: any[] = [];
      await commands.get("omp-vcc").handler("", {
        compact: async () => { throw new Error(err); },
        ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
      });
      expect(notify.some((n) => n.msg === "Nothing to compact" && n.level === "warning")).toBe(true);
    }
  });

  test("/omp-vcc surfaces other failures as compaction errors", async () => {
    const { commands } = makePi();
    const notify: any[] = [];
    await commands.get("omp-vcc").handler("", {
      compact: async () => { throw new Error("boom disk"); },
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(notify.some((n) => n.msg === "Compaction failed: boom disk" && n.level === "error")).toBe(true);
  });

  test("/pi-vcc falls back to the pi-vcc notice and uses pi instructions", async () => {
    const omp = makePi();
    const piHarness = makePi();
    const ompNotify: any[] = [];
    const piNotify: any[] = [];
    let ompArg: any = null;
    let piArg: any = null;
    await omp.commands.get("omp-vcc").handler("", {
      compact: async (arg: any) => { ompArg = arg; },
      ui: { notify: (msg: string) => ompNotify.push(msg) },
    });
    await piHarness.commands.get("pi-vcc").handler("", {
      compact: async (arg: any) => { piArg = arg; },
      ui: { notify: (msg: string) => piNotify.push(msg) },
    });
    expect(piArg).toBe(PI_VCC_COMPACT_INSTRUCTION);
    expect(piArg).not.toBe(ompArg);
    expect(String(piArg)).toContain("__pi_vcc__");
    expect(String(ompArg)).not.toContain("__pi_vcc__");
    expect(piNotify).toContain("Compacted with pi-vcc (via omp-vcc)");
  });

  test("/pi-vcc cancellation maps to a nothing-to-compact warning", async () => {
    const { commands } = makePi();
    const notify: any[] = [];
    await commands.get("pi-vcc").handler("", {
      compact: async () => { throw new Error("Compaction cancelled"); },
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(notify.some((n) => n.msg === "Nothing to compact" && n.level === "warning")).toBe(true);
  });

  test("/pi-vcc surfaces other failures as compaction errors", async () => {
    const { commands } = makePi();
    const notify: any[] = [];
    await commands.get("pi-vcc").handler("", {
      compact: async () => { throw new Error("boom disk"); },
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(notify.some((n) => n.msg === "Compaction failed: boom disk" && n.level === "error")).toBe(true);
  });

  test("/pi-vcc follow-up prompt is sent as a user message", async () => {
    const { commands, userSent } = makePi();
    const notify: any[] = [];
    await commands.get("pi-vcc").handler("fix auth", {
      compact: async () => {},
      ui: { notify: (msg: string, level?: string) => notify.push({ msg, level }) },
    });
    expect(userSent).toContain("fix auth");
  });
});
