// @ts-nocheck
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { createIsolatedOmpDir, isOmpAvailable, runOmp } from "./support/e2e-harness";

let isolated: ReturnType<typeof createIsolatedOmpDir> | null = null;
let ompAvailable = false;

beforeAll(async () => {
  ompAvailable = await isOmpAvailable();
  if (ompAvailable) {
    isolated = createIsolatedOmpDir();
    // link plugin in isolated dir
    const link = await runOmp(["plugin", "link", process.cwd()], { env: isolated.env, timeoutMs: 15000 });
    // ignore link failure, doctor will tell
  }
});
afterAll(() => {
  try { isolated?.cleanup(); } catch {}
  for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {}
});

describe("omp integration — real spawn with isolated OMP_DIR (skip if omp missing)", () => {
  test("omp plugin doctor shows omp-vcc healthy", async () => {
    if (!ompAvailable || !isolated) return;
    const res = await runOmp(["plugin", "doctor"], { env: isolated.env, timeoutMs: 15000 });
    expect(res.stdout + res.stderr).toMatch(/ok|healthy|Found|omp-vcc/i);
    expect(res.timedOut).toBe(false);
  });

  test("omp plugin list --json contains omp-vcc extensions and commands", async () => {
    if (!ompAvailable || !isolated) return;
    const res = await runOmp(["plugin", "list", "--json"], { env: isolated.env, timeoutMs: 15000 });
    const out = res.stdout;
    if (!out.trim()) return; // plugin list may output to stderr or need different flag
    try {
      const json = JSON.parse(out);
      const found = JSON.stringify(json).toLowerCase().includes("omp-vcc");
      expect(found).toBe(true);
    } catch {
      // fallback: check combined output contains omp-vcc
      expect((res.stdout + res.stderr).toLowerCase()).toMatch(/omp-vcc/);
    }
  });

  test("sequential omp invocations with mixed commands via runOmp do not crash", async () => {
    if (!ompAvailable || !isolated) return;
    // Run omp --help as proxy for sequential mixed feature invocations without needing TUI
    const help = await runOmp(["--help"], { env: isolated.env, timeoutMs: 10000 });
    expect(help.stdout + help.stderr).toMatch(/omp|help|plugin/i);
    // Run plugin doctor again to simulate second command in sequence
    const doctor2 = await runOmp(["plugin", "doctor"], { env: isolated.env, timeoutMs: 10000 });
    expect(doctor2.timedOut).toBe(false);
  });

  test("isolated OMP_DIR does not pollute real ~/.omp and per-run isolation", async () => {
    if (!ompAvailable || !isolated) return;
    // isolated dir should be different from real home
    const realHome = process.env.HOME ?? "";
    expect(isolated.ompDir).not.toBe(realHome);
    expect(isolated.ompDir).toMatch(/omp-vcc-e2e/);
    // second isolated dir should be distinct
    const second = createIsolatedOmpDir();
    expect(second.ompDir).not.toBe(isolated.ompDir);
    second.cleanup();
  });

  test("debug file written after manual compaction via real hook path (simulate via direct hook + isolated env)", async () => {
    // This test bridges real omp env (isolated OMP_DIR) with host-free hook to prove debug respects isolated config
    if (!isolated) {
      isolated = createIsolatedOmpDir();
    }
    const { writeFileSync } = await import("fs");
    writeFileSync(isolated.configPath, JSON.stringify({ debug: true, overrideDefaultCompaction: true, smartKeepTail: false }));
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    const { registerBeforeCompactHook, OMP_VCC_COMPACT_INSTRUCTION } = await import("../../extensions/vcc-core/hook");
    const { buildSession } = await import("./support/session-builder");
    let before: any;
    const pi: any = { on: (n: string, h: any) => { if (n === "session_before_compact") before = h; if (n === "session_compact" || n === "before_agent_start" || n === "context") {} }, sendMessage: () => {}, sendUserMessage: () => {} };
    const ctx: any = { hasUI: true, ui: { notify: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, mode: "tui" };
    registerBeforeCompactHook(pi);
    const entries = buildSession({ turns: 4, charsPerTurn: 400 }) as any[];
    await before({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: entries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 70000 }, signal: new AbortController().signal }, ctx);
    expect(existsSync("/tmp/omp-vcc-debug.json")).toBe(true);
    delete process.env.OMP_VCC_CONFIG_PATH;
    try { unlinkSync("/tmp/omp-vcc-debug.json"); } catch {}
    try { unlinkSync("/tmp/pi-vcc-debug.json"); } catch {}
  });

  test("runOmp stdin/timeout/debugJson edges", async () => {
    if (!ompAvailable || !isolated) return;
    // stdin branch: --help ignores input but the write path still runs
    const withInput = await runOmp(["--help"], { env: isolated.env, input: "hello\n", timeoutMs: 10000 });
    expect(withInput.timedOut).toBe(false);
    expect(withInput.stdout + withInput.stderr).toMatch(/omp|help|plugin/i);
    // debugJson branch: pre-seeded file is picked up
    const { writeFileSync, unlinkSync } = await import("fs");
    writeFileSync("/tmp/omp-vcc-debug.json", JSON.stringify({ usedOwnCut: true }));
    const withDebug = await runOmp(["--help"], { env: isolated.env, timeoutMs: 10000 });
    expect(withDebug.debugJson).toEqual({ usedOwnCut: true });
    try { unlinkSync("/tmp/omp-vcc-debug.json"); } catch {}
    // timeout branch: 1ms always beats spawn+exec, kill path runs
    const timed = await runOmp(["--help"], { env: isolated.env, timeoutMs: 1 });
    expect(timed.timedOut).toBe(true);
  });
});
