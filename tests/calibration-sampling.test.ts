// @ts-nocheck
// Calibration sampling: head/tail windows are collected without mapping or
// joining the whole transcript. Exercises disjoint windows (>100 messages)
// plus a multi-MB tail message end to end through the before_compact handler.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  joinBounded,
  OMP_VCC_COMPACT_INSTRUCTION,
} from "../extensions/vcc-core/hook";
import { messageText } from "../extensions/vcc-core/core/content";
import { calibrateCharsPerToken } from "../extensions/vcc-core/core/token-estimate";

let tmpDir: string;
let CONFIG_PATH: string;
let origOmp: string | undefined;
let origPi: string | undefined;
const setCfg = (extra: any = {}) => writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ vccEnabled: true, overrideDefaultCompaction: true, smartKeepTail: false, debug: false, continueAfterThresholdCompact: false, ...extra }),
);
const T = Date.now();

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vcc-calib-"));
  CONFIG_PATH = join(tmpDir, "config.json");
  origOmp = process.env.OMP_VCC_CONFIG_PATH;
  origPi = process.env.PI_VCC_CONFIG_PATH;
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
  setCfg();
});
afterAll(() => {
  if (origOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH; else process.env.OMP_VCC_CONFIG_PATH = origOmp;
  if (origPi === undefined) delete process.env.PI_VCC_CONFIG_PATH; else process.env.PI_VCC_CONFIG_PATH = origPi;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("calibration sampling windows", () => {
  test("disjoint head/tail windows with a multi-MB tail compact normally", async () => {
    let beforeHandler: any;
    const pi: any = {
      on: (n: string, h: any) => { if (n === "session_before_compact") beforeHandler = h; },
      sendMessage: () => {},
      sendUserMessage: async () => {},
    };
    registerBeforeCompactHook(pi);
    const entries: any[] = [];
    for (let i = 0; i < 120; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      entries.push({ id: `m${i}`, type: "message", message: { role, content: `turn ${i} prose about auth session handling`, timestamp: T } });
    }
    // Multi-MB dense tail: old code joined it into a throwaway sample string.
    entries.push({ id: "mBig", type: "message", message: { role: "toolResult", toolName: "bash", content: "0123456789abcdef ".repeat(200000), timestamp: T } });
    const result: any = await beforeHandler({
      type: "session_before_compact",
      customInstructions: OMP_VCC_COMPACT_INSTRUCTION,
      branchEntries: entries,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 400000 },
      signal: new AbortController().signal,
    }, {
      settings: { get: () => undefined },
      config: { get: () => undefined },
      ui: { notify: () => {} },
    });
    expect(result?.compaction).toBeDefined();
    expect(result.compaction.summary.length).toBeGreaterThan(0);
  });
});

// The head/tail samples must carry the TEXT of array-content messages. Reading
// only `typeof content === "string"` made every array-content message sample as
// "" (the dominant shape on both hosts), so the joined sample was a newline-only
// string that isDenseContent classifies as dense — the prose/dense prior was a
// constant 3 and prose sessions were under-estimated by 25%.
describe("calibration sampling reads message text, not just string content", () => {
  const prose = "the quick brown fox jumps over the lazy dog; context compression needs honest estimates. ";
  const hexDump = "deadbeef0123456789abcdef0123456789abcdef ".repeat(20);

  const arrayContent = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
  const stringContent = (text: string) => ({ role: "user", content: text });

  const ratioFor = (messages: any[], sourceChars: number, sourceTokens: number) => {
    const head = joinBounded(messages.slice(0, 50).map((m) => messageText(m)), 8000);
    const tail = joinBounded(messages.slice(-50).map((m) => messageText(m)), 8000);
    return calibrateCharsPerToken(sourceChars, sourceTokens, head || undefined, tail || undefined).charsPerToken;
  };

  test("array content produces a prose sample (not a newline-only one)", () => {
    const messages = Array.from({ length: 10 }, () => arrayContent(prose.repeat(4)));
    expect(messageText(messages[0])).toContain("quick brown fox");
    expect(joinBounded(messages.map((m) => messageText(m)), 8000)).toContain("quick brown fox");
    // Slice/tokens below 2.5 with a prose sample → the prose prior (4), not the
    // dense prior (3) that the empty sample used to select.
    expect(ratioFor(messages, 2000, 1000)).toBe(4);
  });

  test("string content keeps working", () => {
    const messages = Array.from({ length: 10 }, () => stringContent(prose.repeat(4)));
    expect(ratioFor(messages, 2000, 1000)).toBe(4);
  });

  test("a dense tail still selects the dense prior", () => {
    // The tail window must actually be dominated by the dense text: the sample
    // is bounded to 8k chars from the START of the window, so a short prose head
    // cannot dilute a long hex tail.
    const messages = [
      ...Array.from({ length: 5 }, () => arrayContent(prose)),
      ...Array.from({ length: 20 }, () => arrayContent(hexDump)),
    ];
    expect(ratioFor(messages, 2000, 1000)).toBe(3);
  });
});
