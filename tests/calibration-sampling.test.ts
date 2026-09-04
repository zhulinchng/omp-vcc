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
  OMP_VCC_COMPACT_INSTRUCTION,
} from "../extensions/vcc-core/hook";

let tmpDir: string;
let CONFIG_PATH: string;
let origOmp: string | undefined;
let origPi: string | undefined;
const setCfg = (extra: any = {}) => writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ vccEnabled: true, overrideDefaultCompaction: true, smartKeepTail: false, debug: false, continueAfterThresholdCompact: false, chainShakeHint: false, ...extra }),
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
