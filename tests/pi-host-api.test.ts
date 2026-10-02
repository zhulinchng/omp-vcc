// @ts-nocheck
// pi-host compatibility: the factory MUST load on pi's real ExtensionAPI.
//
// Defect this pins: extensions/main.ts used to build the vcc_recall parameter
// schema with `pi.zod.object(...)`. `zod` exists only on omp's ExtensionAPI; pi's
// has none. On pi the factory threw and the host discarded the whole extension
// (pi loader.ts: `{ extension: null, error: "Failed to load extension: …" }`),
// so the plugin registered zero tools and zero commands despite shipping a pi
// manifest. The fix emits plain JSON Schema, which both hosts pass through to
// the provider unchanged.
//
// The replica below mirrors pi's surface exactly (core/extensions/types.ts
// `ExtensionAPI`): registerTool / registerCommand / registerShortcut /
// registerFlag / getFlag / on / sendMessage / sendUserMessage / appendEntry /
// events — and deliberately NO zod / typebox / arktype / logger / cwd / hasUI,
// which is what made the old code throw.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import extension from "../extensions/main.ts";

let CFG_DIR: string;
let savedOmp: string | undefined;
let savedPi: string | undefined;

beforeAll(() => {
  CFG_DIR = mkdtempSync(join(tmpdir(), "pi-host-api-"));
  savedOmp = process.env.OMP_VCC_CONFIG_PATH;
  savedPi = process.env.PI_VCC_CONFIG_PATH;
  process.env.OMP_VCC_CONFIG_PATH = join(CFG_DIR, "config.json");
  process.env.PI_VCC_CONFIG_PATH = join(CFG_DIR, "config.json");
});

afterAll(() => {
  if (savedOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = savedOmp;
  if (savedPi === undefined) delete process.env.PI_VCC_CONFIG_PATH;
  else process.env.PI_VCC_CONFIG_PATH = savedPi;
  try { rmSync(CFG_DIR, { recursive: true, force: true }); } catch {}
});

// Exactly pi's ExtensionAPI members the plugin could touch, and nothing omp-only.
function makePiReplica() {
  const tools: Array<{ name: string; parameters: unknown }> = [];
  const commands = new Map<string, unknown>();
  const pi: Record<string, unknown> = {
    on: () => {},
    registerTool: (t: { name: string; parameters: unknown }) => tools.push(t),
    registerCommand: (name: string, def: unknown) => commands.set(name, def),
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    events: {},
  };
  return { pi, tools, commands };
}

describe("pi-host compatibility: factory loads without omp-only APIs", () => {
  test("pi ExtensionAPI has no zod/typebox/arktype/logger/cwd/hasUI", () => {
    const { pi } = makePiReplica();
    for (const key of ["zod", "typebox", "arktype", "logger", "cwd", "hasUI", "ui"]) {
      expect(key in pi).toBe(false);
    }
  });

  test("factory does not throw on the pi surface", () => {
    const { pi } = makePiReplica();
    expect(() => (extension as (p: unknown) => void)(pi)).not.toThrow();
  });

  test("registers exactly the two tools on pi", () => {
    const { pi, tools } = makePiReplica();
    (extension as (p: unknown) => void)(pi);
    expect(tools.map((t) => t.name).sort()).toEqual(["vcc_recall", "vcc_stats"]);
  });

  test("registers the full command surface on pi", () => {
    const { pi, commands } = makePiReplica();
    (extension as (p: unknown) => void)(pi);
    expect([...commands.keys()].sort()).toEqual([
      "omp-vcc",
      "pi-vcc",
      "pi-vcc-recall",
      "vcc-config",
      "vcc-recall",
      "vcc-stats",
    ]);
  });

  test("vcc_recall parameters is plain JSON Schema, not a zod builder", () => {
    const { pi, tools } = makePiReplica();
    (extension as (p: unknown) => void)(pi);
    const recall = tools.find((t) => t.name === "vcc_recall");
    const params = recall?.parameters as {
      type: string;
      additionalProperties: boolean;
      properties: Record<string, { type: string; enum?: string[] }>;
    };
    expect(params.type).toBe("object");
    expect(params.additionalProperties).toBe(false);
    expect(params.properties.query.type).toBe("string");
    expect(params.properties.scope.enum).toEqual(["lineage", "all", "active"]);
    expect(params.properties.mode.enum).toEqual(["hybrid", "touched", "file"]);
    expect(params.properties.expand.type).toBe("array");
    expect(params.properties.page.type).toBe("number");
  });

  test("vcc_stats parameters is plain JSON Schema too", () => {
    const { pi, tools } = makePiReplica();
    (extension as (p: unknown) => void)(pi);
    const stats = tools.find((t) => t.name === "vcc_stats");
    const params = stats?.parameters as { type: string; properties: Record<string, { type: string }> };
    expect(params.type).toBe("object");
    expect(params.properties.history.type).toBe("boolean");
  });
});
