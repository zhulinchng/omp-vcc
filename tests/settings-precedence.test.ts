// @ts-nocheck
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadSettings, DEFAULT_SETTINGS } from "../extensions/vcc-core/core/settings";
import { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION } from "../extensions/vcc-core/hook";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vcc-precedence-"));
  // Ensure clean env before each test — mimics CI isolation
  delete process.env.OMP_VCC_CONFIG_PATH;
  delete process.env.PI_VCC_CONFIG_PATH;
  for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {}
});

afterEach(() => {
  delete process.env.OMP_VCC_CONFIG_PATH;
  delete process.env.PI_VCC_CONFIG_PATH;
  for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const writeCfg = (path: string, cfg: Record<string, unknown>) => writeFileSync(path, JSON.stringify(cfg));

const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id, type: "message", message: { role, content },
});
function makeEvent(branchEntries: any[], customInstructions?: string, eventContext: Record<string, unknown> = {}) {
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 1000 },
    signal: new AbortController().signal,
    ...eventContext,
  };
}
function createMockPi() {
  let beforeHandler: any;
  const notifyCalls: any[] = [];
  const ctx: any = { hasUI: true, ui: { notify: (msg: string, level: string) => notifyCalls.push({ msg, level }) } };
  return {
    pi: { on: (e: string, h: any) => { if (e === "session_before_compact") beforeHandler = h; } } as any,
    invokeBefore: (event: any) => beforeHandler(event, ctx),
    notifyCalls,
  };
}

describe("settings precedence — OMP vs PI race (gap from Node24 CI #33656213765)", () => {
  test("OMP wins over PI when both exist with different values", () => {
    const ompPath = join(tmpRoot, "omp.json");
    const piPath = join(tmpRoot, "pi.json");
    writeCfg(ompPath, { overrideDefaultCompaction: true, debug: false });
    writeCfg(piPath, { overrideDefaultCompaction: false, debug: true });
    process.env.OMP_VCC_CONFIG_PATH = ompPath;
    process.env.PI_VCC_CONFIG_PATH = piPath;
    const s = loadSettings();
    expect(s.overrideDefaultCompaction).toBe(true); // OMP wins
    expect(s.debug).toBe(false);
  });

  test("PI fallback when OMP file missing but PI exists (concurrent-test shadowing fix)", () => {
    const ompPath = join(tmpRoot, "missing-omp.json"); // not created
    const piPath = join(tmpRoot, "pi-exists.json");
    writeCfg(piPath, { overrideDefaultCompaction: false, debug: true });
    process.env.OMP_VCC_CONFIG_PATH = ompPath;
    process.env.PI_VCC_CONFIG_PATH = piPath;
    const s = loadSettings();
    expect(s.overrideDefaultCompaction).toBe(false); // falls back to PI
    expect(s.debug).toBe(true);
  });

  test("PI fallback when OMP env deleted, PI remains", () => {
    const piPath = join(tmpRoot, "pi-only.json");
    writeCfg(piPath, { debug: true, vccEnabled: false });
    process.env.PI_VCC_CONFIG_PATH = piPath;
    // OMP not set
    const s = loadSettings();
    expect(s.debug).toBe(true);
    expect(s.vccEnabled).toBe(false);
  });

  test("defaults when neither file exists", () => {
    process.env.OMP_VCC_CONFIG_PATH = join(tmpRoot, "nope-omp.json");
    process.env.PI_VCC_CONFIG_PATH = join(tmpRoot, "nope-pi.json");
    const s = loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  test("concurrent shadowing simulation: OMP set by other test with defaults does not leak into PI test when fixed", () => {
    // Simulate CI race: before-compact-hook.test.ts sets PI=false, but concurrent test sets OMP=true
    // With fix (both envs set to same file), PI test should still read false, not true.
    // Here we verify that when both are set to same file with false, OMP wins but content is false.
    const sharedPath = join(tmpRoot, "shared.json");
    writeCfg(sharedPath, { overrideDefaultCompaction: false });
    process.env.OMP_VCC_CONFIG_PATH = sharedPath;
    process.env.PI_VCC_CONFIG_PATH = sharedPath;
    const s = loadSettings();
    expect(s.overrideDefaultCompaction).toBe(false);

    // Now simulate other test overwriting OMP to default true file
    const otherPath = join(tmpRoot, "other.json");
    writeCfg(otherPath, { overrideDefaultCompaction: true });
    const origOmp = process.env.OMP_VCC_CONFIG_PATH;
    process.env.OMP_VCC_CONFIG_PATH = otherPath;
    const s2 = loadSettings();
    expect(s2.overrideDefaultCompaction).toBe(true); // other test sees true

    // Restore original — beforeEach re-assert would do this, but we test manual restore
    process.env.OMP_VCC_CONFIG_PATH = origOmp;
    const s3 = loadSettings();
    expect(s3.overrideDefaultCompaction).toBe(false); // restored to false
  });
});

describe("registerBeforeCompactHook — gaps that failed on Node24", () => {
  test("/compact with override=false short-circuits even when OMP env was briefly shadowed", () => {
    const cfgPath = join(tmpRoot, "cfg.json");
    writeCfg(cfgPath, { overrideDefaultCompaction: false });
    process.env.OMP_VCC_CONFIG_PATH = cfgPath;
    process.env.PI_VCC_CONFIG_PATH = cfgPath;
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invokeBefore(makeEvent(entries, undefined))).toBeUndefined();
    expect(notifyCalls).toHaveLength(0);
  });

  test("overflow retry with willRetry falls back to core even when debug true file exists", () => {
    const cfgPath = join(tmpRoot, "cfg2.json");
    writeCfg(cfgPath, { debug: true, overrideDefaultCompaction: true });
    process.env.OMP_VCC_CONFIG_PATH = cfgPath;
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    const result = invokeBefore(makeEvent(entries, undefined, { reason: "overflow", willRetry: true }));
    expect(result).toBeUndefined();
    expect(notifyCalls).toHaveLength(0);
    expect(existsSync("/tmp/omp-vcc-debug.json")).toBe(true);
  });

  test("debug:true writes snapshot without content leakage (SECRET_TOKEN)", () => {
    const cfgPath = join(tmpRoot, "cfg3.json");
    writeCfg(cfgPath, { debug: true, overrideDefaultCompaction: false });
    process.env.OMP_VCC_CONFIG_PATH = cfgPath;
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user", "SECRET_TOKEN_abc123"), msg("m2", "assistant", "sensitive")];
    expect(invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
    expect(existsSync("/tmp/omp-vcc-debug.json")).toBe(true);
    const snap = JSON.parse(require("fs").readFileSync("/tmp/omp-vcc-debug.json", "utf-8"));
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("SECRET_TOKEN_abc123");
    expect(serialized).not.toContain("sensitive");
  });

  test("continueAfterThresholdCompact:false disables threshold continuation", async () => {
    const cfgPath = join(tmpRoot, "cfg4.json");
    writeCfg(cfgPath, { overrideDefaultCompaction: true, continueAfterThresholdCompact: false });
    process.env.OMP_VCC_CONFIG_PATH = cfgPath;
    let beforeHandler: any, compactHandler: any;
    const customMessages: any[] = [];
    const pi: any = {
      on: (e: string, h: any) => {
        if (e === "session_before_compact") beforeHandler = h;
        if (e === "session_compact") compactHandler = h;
      },
      sendMessage: (m: any, o: any) => customMessages.push({ m, o }),
    };
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    beforeHandler(makeEvent(entries, undefined, { reason: "threshold", willRetry: false }), { hasUI: true, ui: { notify: () => {} } });
    await compactHandler({ type: "session_compact", fromExtension: true, reason: "threshold", willRetry: false }, { hasUI: true, ui: { notify: () => {} } });
    await new Promise((r) => setTimeout(r, 10));
    expect(customMessages).toEqual([]);
  });

  test("custom_message content appears in debug preview", () => {
    const cfgPath = join(tmpRoot, "cfg5.json");
    writeCfg(cfgPath, { debug: true, overrideDefaultCompaction: false });
    process.env.OMP_VCC_CONFIG_PATH = cfgPath;
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [
      { id: "c1", type: "custom_message", customType: "memory-inject", content: "INJECTED_CTX_9999", display: false, timestamp: "2026-01-01T00:00:00.000Z" },
      msg("u1", "user", "go"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "next"),
      msg("a2", "assistant", "done"),
    ];
    const result = invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.cancel).toBeUndefined();
    expect(existsSync("/tmp/omp-vcc-debug.json")).toBe(true);
    const snap = JSON.parse(require("fs").readFileSync("/tmp/omp-vcc-debug.json", "utf-8"));
    expect(JSON.stringify(snap)).toContain("INJECTED_CTX_9999");
  });
});
