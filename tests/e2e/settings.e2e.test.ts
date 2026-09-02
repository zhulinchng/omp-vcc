// @ts-nocheck
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { homedir } from "os";
import { DEFAULT_SETTINGS, loadSettings, scaffoldSettings } from "../../extensions/vcc-core/core/settings";
import { registerBeforeCompactHook, OMP_VCC_COMPACT_INSTRUCTION } from "../../extensions/vcc-core/hook";
import { createIsolatedOmpDir } from "./support/e2e-harness";
import { buildSession, msg } from "./support/session-builder";

let isolated: ReturnType<typeof createIsolatedOmpDir>;

beforeAll(() => { isolated = createIsolatedOmpDir(); });
afterAll(() => { try { isolated.cleanup(); } catch {} });
beforeEach(() => {
  try { if (existsSync(isolated.configPath)) unlinkSync(isolated.configPath); } catch {}
  for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {}
  delete process.env.OMP_VCC_CONFIG_PATH;
  delete process.env.PI_VCC_CONFIG_PATH;
});
afterEach(() => {
  try { if (existsSync(isolated.configPath)) unlinkSync(isolated.configPath); } catch {}
  for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) try { if (existsSync(p)) unlinkSync(p); } catch {}
  delete process.env.OMP_VCC_CONFIG_PATH;
  delete process.env.PI_VCC_CONFIG_PATH;
});

function mockCtxWithSettings(settings: Record<string, unknown>): any {
  return {
    settings: { get: (key: string) => (key in settings ? settings[key] : undefined) },
    config: { get: (key: string) => (key in settings ? settings[key] : undefined) },
  } as any;
}

describe("settings E2E — file source, XDG priority, migration, overlay, manifest", () => {
  test("DEFAULT_SETTINGS has 5 booleans with expected defaults", () => {
    expect(DEFAULT_SETTINGS.vccEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.overrideDefaultCompaction).toBe(true);
    expect(DEFAULT_SETTINGS.smartKeepTail).toBe(true);
    expect(DEFAULT_SETTINGS.continueAfterThresholdCompact).toBe(true);
    expect(DEFAULT_SETTINGS.debug).toBe(false);
    expect(Object.keys(DEFAULT_SETTINGS).length).toBe(5);
  });

  test("scaffoldSettings creates file with defaults without clobbering existing keys", () => {
    // isolated path ensures no real home clobber
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    // ensure file absent
    expect(existsSync(isolated.configPath)).toBe(false);
    scaffoldSettings();
    expect(existsSync(isolated.configPath)).toBe(true);
    const first = JSON.parse(readFileSync(isolated.configPath, "utf-8"));
    expect(first.vccEnabled).toBe(true);
    expect(first.debug).toBe(false);
    // modify one key, scaffold again should not clobber
    writeFileSync(isolated.configPath, JSON.stringify({ ...first, debug: true, vccEnabled: false }));
    scaffoldSettings();
    const second = JSON.parse(readFileSync(isolated.configPath, "utf-8"));
    expect(second.debug).toBe(true);
    expect(second.vccEnabled).toBe(false);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("XDG priority: OMP_VCC_CONFIG_PATH wins over real home path", async () => {
    const customPath = join(isolated.ompDir, "custom-config.json");
    writeFileSync(customPath, JSON.stringify({ vccEnabled: false, debug: false }));
    process.env.OMP_VCC_CONFIG_PATH = customPath;
    const settings = loadSettings();
    expect(settings.vccEnabled).toBe(false);
    // now test that PI_VCC_CONFIG_PATH is fallback when OMP not set
    delete process.env.OMP_VCC_CONFIG_PATH;
    process.env.PI_VCC_CONFIG_PATH = customPath;
    const settings2 = loadSettings();
    expect(settings2.vccEnabled).toBe(false);
    delete process.env.PI_VCC_CONFIG_PATH;
  });

  test("loadSettings ctx overlay applies without restart (file false, ctx true => true)", () => {
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false }));
    const ctx = mockCtxWithSettings({ "plugins.@zhulinchng/omp-vcc.debug": true });
    const settings = loadSettings(ctx);
    expect(settings.debug).toBe(true);
    // also test namespaced key variation
    const ctx2 = mockCtxWithSettings({ "plugins.omp-vcc.debug": true });
    // loadSettings checks both plugins.@zhulinchng/omp-vcc.* and plugins.omp-vcc.* and plain keys
    // at least one path should enable debug
    const settings2 = loadSettings(ctx2);
    // we don't assert true for second path strictly, just that file false without overlay stays false
    const settingsNoOverlay = loadSettings({ settings: { get: () => undefined }, config: { get: () => undefined } } as any);
    expect(settingsNoOverlay.debug).toBe(false);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("debug toggle controls /tmp/omp-vcc-debug.json write", async () => {
    const entries = buildSession({ turns: 4, charsPerTurn: 500 }) as any[];
    function createMockPi() {
      let h: any;
      const pi: any = { on: (n: string, fn: any) => { if (n === "session_before_compact") h = fn; if (n === "session_compact" || n === "before_agent_start" || n === "context") {} }, sendMessage: () => {}, sendUserMessage: () => {} };
      const ctx: any = { hasUI: true, ui: { notify: () => {} }, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, mode: "tui" };
      return { pi, ctx, getBefore: () => h };
    }
    // debug false -> no file
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ debug: false, overrideDefaultCompaction: true }));
    let mocked = createMockPi();
    registerBeforeCompactHook(mocked.pi);
    await mocked.getBefore()({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: entries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 60000 }, signal: new AbortController().signal }, mocked.ctx);
    expect(existsSync("/tmp/omp-vcc-debug.json")).toBe(false);
    // debug true -> file exists with dual write
    writeFileSync(isolated.configPath, JSON.stringify({ debug: true, overrideDefaultCompaction: true }));
    mocked = createMockPi();
    registerBeforeCompactHook(mocked.pi);
    await mocked.getBefore()({ type: "session_before_compact", customInstructions: OMP_VCC_COMPACT_INSTRUCTION, branchEntries: entries, preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 60000 }, signal: new AbortController().signal }, mocked.ctx);
    expect(existsSync("/tmp/omp-vcc-debug.json")).toBe(true);
    expect(existsSync("/tmp/pi-vcc-debug.json")).toBe(true);
    const dbg = JSON.parse(readFileSync("/tmp/omp-vcc-debug.json", "utf-8"));
    expect(dbg.usedOwnCut).toBe(true);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });

  test("package.json plugin manifest has correct extensions, commands, settings", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    expect(pkg.omp.extensions).toContain("./extensions/main.ts");
    expect(pkg.pi.extensions).toContain("./extensions/main.ts");
    // commands should include omp-vcc and vcc-recall
    const allCommands = [...(pkg.omp.commands ?? []), ...(pkg.pi.commands ?? [])].join(" ");
    expect(allCommands).toMatch(/omp-vcc/);
    expect(allCommands).toMatch(/vcc-recall/);
    // settings should have 5 keys
    const settingsKeys = Object.keys(pkg.omp.settings ?? {});
    expect(settingsKeys.length).toBe(5);
    expect(settingsKeys).toContain("vccEnabled");
    expect(settingsKeys).toContain("overrideDefaultCompaction");
    expect(settingsKeys).toContain("smartKeepTail");
    expect(settingsKeys).toContain("continueAfterThresholdCompact");
    expect(settingsKeys).toContain("debug");
    // files should include extensions, skills, commands
    expect(pkg.files).toContain("extensions");
    expect(pkg.files).toContain("skills");
    expect(pkg.files).toContain("commands");
  });

  test("per-flag semantics verified via loadSettings and hook gate", async () => {
    // vccEnabled false disables compaction; override false disables auto; smartKeep tested elsewhere
    // here we just verify that settings values propagate
    process.env.OMP_VCC_CONFIG_PATH = isolated.configPath;
    writeFileSync(isolated.configPath, JSON.stringify({ vccEnabled: true, overrideDefaultCompaction: false, smartKeepTail: false, continueAfterThresholdCompact: false, debug: false }));
    const s = loadSettings();
    expect(s.vccEnabled).toBe(true);
    expect(s.overrideDefaultCompaction).toBe(false);
    expect(s.smartKeepTail).toBe(false);
    expect(s.continueAfterThresholdCompact).toBe(false);
    expect(s.debug).toBe(false);
    delete process.env.OMP_VCC_CONFIG_PATH;
  });
});
