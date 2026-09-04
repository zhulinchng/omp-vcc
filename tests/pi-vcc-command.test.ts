// @ts-nocheck
// /pi-vcc factory alias: same compact flow as /omp-vcc with pi-vcc branding
// (PI sentinel via buildPiVccCustomInstructions, "via omp-vcc" toasts).
// Unlike the deleted hook registrar, the factory awaits compact directly —
// there are no onComplete/onError callbacks; errors map inline.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import extension from "../extensions/main";
import { PI_VCC_COMPACT_INSTRUCTION } from "../extensions/vcc-core/hook";

const chain: any = { optional: () => chain, describe: () => chain };
const mockZod: any = {
  object: (o: any) => o,
  boolean: () => chain,
  string: () => chain,
  array: (_a: any) => chain,
  number: () => chain,
  enum: (_a: any) => chain,
};

let tmpDir: string;
let CONFIG_PATH: string;
let origOmp: string | undefined;
let origPi: string | undefined;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vcc-pi-alias-"));
  CONFIG_PATH = join(tmpDir, "config.json");
  origOmp = process.env.OMP_VCC_CONFIG_PATH;
  origPi = process.env.PI_VCC_CONFIG_PATH;
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
  writeFileSync(CONFIG_PATH, JSON.stringify({ vccEnabled: true, overrideDefaultCompaction: true, smartKeepTail: false, debug: false, continueAfterThresholdCompact: false, chainShakeHint: false }));
});
afterAll(() => {
  if (origOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH; else process.env.OMP_VCC_CONFIG_PATH = origOmp;
  if (origPi === undefined) delete process.env.PI_VCC_CONFIG_PATH; else process.env.PI_VCC_CONFIG_PATH = origPi;
  rmSync(tmpDir, { recursive: true, force: true });
});

function createHarness(opts: {
  compactImpl?: (arg: string) => Promise<void> | void;
  sendUserMessage?: (content: string) => unknown;
} = {}) {
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const compactCalls: string[] = [];
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const userMessages: string[] = [];
  const tools: any[] = [];
  const pi: any = {
    on: (n: string, h: any) => handlers.set(n, h),
    registerTool: (t: any) => tools.push(t),
    registerCommand: (name: string, def: any) => commands.set(name, def),
    zod: mockZod,
    sendMessage: () => {},
    sendUserMessage: opts.sendUserMessage ?? ((content: string) => { userMessages.push(content); }),
  };
  (extension as any)(pi);
  const ctx = {
    compact: opts.compactImpl ?? (async (arg: string) => { compactCalls.push(arg); }),
    ui: { notify: (msg: string, level?: string) => notifyCalls.push({ msg, level: level ?? "info" }) },
  };
  return {
    invoke: (args = "") => commands.get("pi-vcc").handler(args, ctx),
    before: handlers.get("session_before_compact"),
    pi,
    compactCalls,
    notifyCalls,
    userMessages,
  };
}

describe("pi-vcc alias command", () => {
  test("uses the pi-vcc compaction marker", async () => {
    const { invoke, compactCalls } = createHarness();

    await invoke();

    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]).toBe(PI_VCC_COMPACT_INSTRUCTION);
  });

  test("parses keep token at the start of args and strips it from the prompt", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("keep:3   continue  ");

    expect(compactCalls[0]).toBe(`${PI_VCC_COMPACT_INSTRUCTION} keep:3`);
    expect(userMessages).toEqual(["continue"]);
  });

  test("parses keep token at the end of args and strips it from the prompt", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("  continue   keep:2");

    expect(compactCalls[0]).toBe(`${PI_VCC_COMPACT_INSTRUCTION} keep:2`);
    expect(userMessages).toEqual(["continue"]);
  });

  test("parses a lone keep token without sending a follow-up prompt", async () => {
    const { invoke, compactCalls, userMessages } = createHarness();

    await invoke("keep:4");

    expect(compactCalls[0]).toBe(`${PI_VCC_COMPACT_INSTRUCTION} keep:4`);
    expect(userMessages).toHaveLength(0);
  });

  test("notifies the alias-branded toast when no stats exist", async () => {
    const { invoke, notifyCalls } = createHarness();

    await invoke("continue");

    expect(notifyCalls).toEqual([{ msg: "Compacted with pi-vcc (via omp-vcc)", level: "info" }]);
  });

  test("schedules metric notify from seeded stats after successful compaction", async () => {
    const { invoke, before, pi, notifyCalls, userMessages } = createHarness();
    const hookCtx: any = {
      settings: { get: () => undefined },
      config: { get: () => undefined },
      ui: { notify: () => {} },
    };

    // Seed stats by running the real compaction first (same pi object).
    const seeded: any = await before({
      type: "session_before_compact",
      customInstructions: PI_VCC_COMPACT_INSTRUCTION,
      branchEntries: [
        { id: "m1", type: "message", message: { role: "user", content: "one" } },
        { id: "m2", type: "message", message: { role: "assistant", content: "reply one" } },
        { id: "m3", type: "message", message: { role: "user", content: "two" } },
        { id: "m4", type: "message", message: { role: "assistant", content: "reply two" } },
      ],
      preparation: {
        previousSummary: undefined,
        fileOps: { read: [], written: [], edited: [] },
        tokensBefore: 1000,
      },
      signal: new AbortController().signal,
    }, hookCtx);
    expect(seeded?.compaction).toBeDefined();
    void pi;

    await invoke("continue");
    expect(userMessages).toEqual(["continue"]);

    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(notifyCalls.some((call) => call.msg.includes("kept 1/2 turns,"))).toBe(true);
  });

  test("swallows a rejecting follow-up send without throwing", async () => {
    const { invoke } = createHarness({
      sendUserMessage: () => Promise.reject(new Error("send failed")),
    });

    await invoke("continue");
  });

  test("skips follow-up when trailing prompt is empty", async () => {
    const { invoke, userMessages } = createHarness();

    await invoke("   ");

    expect(userMessages).toHaveLength(0);
  });

  test("does not send trailing prompt on compaction error", async () => {
    const { invoke, userMessages, notifyCalls } = createHarness({
      compactImpl: async () => { throw new Error("Already compacted"); },
    });

    await invoke("continue");

    expect(userMessages).toHaveLength(0);
    expect(notifyCalls).toEqual([{ msg: "Nothing to compact", level: "warning" }]);
  });

  test("normalizes huge keep tokens to a safe integer instruction", async () => {
    const { invoke, compactCalls } = createHarness();

    await invoke("keep:999999999999999999999 continue");

    expect(compactCalls[0]).toBe(`${PI_VCC_COMPACT_INSTRUCTION} keep:${Number.MAX_SAFE_INTEGER}`);
  });
});
