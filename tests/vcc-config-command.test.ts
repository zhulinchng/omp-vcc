// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerVccConfigCommand, formatVccConfigCard } from "../extensions/vcc-core/hook";
import { DEFAULT_SETTINGS, getSettingsPath, loadSettingsWithSources } from "../extensions/vcc-core/core/settings";

const ALL_KEYS = Object.keys(DEFAULT_SETTINGS);
const onOff = (v) => (v ? "on" : "off");

let tmp;
let savedOmp;
let savedPi;

function makePi() {
  const cmds = new Map();
  const pi = {
    registerCommand: (n, def) => cmds.set(n, def),
    sendMessage: (m, opts) => {
      pi._sent.push({ m, opts });
    },
    _sent: [],
  };
  return { pi, cmds };
}

function makeCtx(notify) {
  const notes = [];
  return {
    ctx: {
      ui: {
        notify: (msg, level) => {
          notes.push({ msg, level });
          if (notify) notify(msg, level);
        },
      },
    },
    notes,
  };
}

beforeEach(() => {
  savedOmp = process.env.OMP_VCC_CONFIG_PATH;
  savedPi = process.env.PI_VCC_CONFIG_PATH;
  delete process.env.PI_VCC_CONFIG_PATH;
  tmp = mkdtempSync(join(tmpdir(), "vcc-config-cmd-"));
  // default: primary points at a missing file (no fixture created)
  process.env.OMP_VCC_CONFIG_PATH = join(tmp, "missing.json");
});

afterEach(() => {
  if (savedOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = savedOmp;
  if (savedPi === undefined) delete process.env.PI_VCC_CONFIG_PATH;
  else process.env.PI_VCC_CONFIG_PATH = savedPi;
});

describe("vcc-config command registration", () => {
  test("registers vcc-config with description, no alias", () => {
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    expect(cmds.has("vcc-config")).toBe(true);
    expect(typeof cmds.get("vcc-config").description).toBe("string");
    expect(cmds.get("vcc-config").description.length).toBeGreaterThan(0);
    expect(typeof cmds.get("vcc-config").handler).toBe("function");
    expect(cmds.has("omp-vcc-config")).toBe(false);
    expect(cmds.has("pi-vcc-config")).toBe(false);
  });

  test("factory wires vcc-config (extension end-to-end)", async () => {
    const { default: createExtension } = await import("../extensions/main");
    const cmds = new Map();
    const chain = {};
    chain.describe = () => chain;
    chain.optional = () => chain;
    const pi = {
      on: () => {},
      registerTool: () => {},
      registerCommand: (n, def) => cmds.set(n, def),
      sendMessage: () => {},
      zod: {
        object: (o) => o,
        string: () => chain,
        number: () => chain,
        boolean: () => chain,
        array: () => chain,
        enum: () => chain,
      },
    };
    createExtension(pi);
    expect(cmds.has("vcc-config")).toBe(true);
  });
});

describe("vcc-config card: file states", () => {
  test("handler renders the loader view verbatim on any machine", async () => {
    // OMP_VCC_CONFIG_PATH points at a missing file, but a fallback candidate
    // (e.g. ~/.omp/omp-vcc/config.json) may exist on the test machine — so pin
    // the handler to the loader output instead of assuming a missing file.
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    const { ctx, notes } = makeCtx();
    await cmds.get("vcc-config").handler("", ctx);
    const expected = formatVccConfigCard(loadSettingsWithSources(ctx));
    expect(pi._sent.length).toBe(1);
    const { m, opts } = pi._sent[0];
    expect(m.customType).toBe("vcc-config");
    expect(m.display).toBe(true);
    expect(opts).toEqual({ triggerTurn: false });
    expect(m.content).toBe(expected);
    expect(m.content).toContain(`**omp-vcc config** (\`${process.env.OMP_VCC_CONFIG_PATH}\`)`);
    expect(notes.length).toBe(1);
    expect(notes[0].msg).toMatch(/vcc_config: 6 keys from /);
    expect(notes[0].level).toBe("info");
  });

  test("partial file fills missing keys with defaults", async () => {
    const cfg = join(tmp, "partial.json");
    writeFileSync(cfg, JSON.stringify({ debug: true }));
    process.env.OMP_VCC_CONFIG_PATH = cfg;
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    const { ctx } = makeCtx();
    await cmds.get("vcc-config").handler("", ctx);
    const content = pi._sent[0].m.content;
    expect(content).toContain(`Source: file ${cfg}`);
    expect(content).toContain("- debug: on (file)");
    for (const k of ALL_KEYS.filter((k) => k !== "debug")) {
      expect(content).toContain(`- ${k}: ${onOff(DEFAULT_SETTINGS[k])} (default)`);
    }
  });

  test("invalid JSON falls back to defaults with unparseable status", async () => {
    const cfg = join(tmp, "broken.json");
    writeFileSync(cfg, "{oops not json");
    process.env.OMP_VCC_CONFIG_PATH = cfg;
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    const { ctx } = makeCtx();
    await cmds.get("vcc-config").handler("", ctx);
    const content = pi._sent[0].m.content;
    expect(content).toContain("unparseable");
    for (const k of ALL_KEYS) {
      expect(content).toContain(`- ${k}: ${onOff(DEFAULT_SETTINGS[k])} (default)`);
    }
  });

  test("full non-default file marks every key (file)", async () => {
    const cfg = join(tmp, "full.json");
    const fixture = {
      vccEnabled: false,
      overrideDefaultCompaction: false,
      smartKeepTail: false,
      continueAfterThresholdCompact: false,
      debug: true,
      chainShakeHint: true,
    };
    writeFileSync(cfg, JSON.stringify(fixture));
    process.env.OMP_VCC_CONFIG_PATH = cfg;
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    const { ctx, notes } = makeCtx();
    await cmds.get("vcc-config").handler("", ctx);
    const content = pi._sent[0].m.content;
    for (const k of ALL_KEYS) {
      expect(content).toContain(`- ${k}: ${onOff(fixture[k])} (file)`);
    }
    expect(notes[0].msg).toContain(`from ${cfg}`);
  });
});

describe("vcc-config card: host overlay", () => {
  test("settings.get namespaced key overlays file value", async () => {
    const cfg = join(tmp, "overlay1.json");
    writeFileSync(cfg, JSON.stringify({ debug: false }));
    process.env.OMP_VCC_CONFIG_PATH = cfg;
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    const { ctx } = makeCtx();
    ctx.settings = { get: (k) => (k === "plugins.@zhulinchng/omp-vcc.debug" ? true : undefined) };
    await cmds.get("vcc-config").handler("", ctx);
    const content = pi._sent[0].m.content;
    expect(content).toContain("- debug: on (host overlay)");
    expect(content).toContain("- vccEnabled: on (default)");
  });

  test("config.get bare key overlays file value", async () => {
    const cfg = join(tmp, "overlay2.json");
    writeFileSync(cfg, JSON.stringify({ debug: false }));
    process.env.OMP_VCC_CONFIG_PATH = cfg;
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    const { ctx } = makeCtx();
    ctx.config = { get: (k) => (k === "debug" ? true : undefined) };
    await cmds.get("vcc-config").handler("", ctx);
    expect(pi._sent[0].m.content).toContain("- debug: on (host overlay)");
  });

  test("plain settings map overlays file value", async () => {
    const cfg = join(tmp, "overlay3.json");
    writeFileSync(cfg, JSON.stringify({ debug: false }));
    process.env.OMP_VCC_CONFIG_PATH = cfg;
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    const plain = { ctx: { settings: { "omp-vcc.debug": true }, ui: { notify: () => {} } } };
    await cmds.get("vcc-config").handler("", plain.ctx);
    expect(pi._sent[0].m.content).toContain("- debug: on (host overlay)");
  });
});

describe("vcc-config card: robustness", () => {
  test("args are ignored — same card for any input", async () => {
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    const { ctx } = makeCtx();
    await cmds.get("vcc-config").handler("history --json", ctx);
    await cmds.get("vcc-config").handler("", ctx);
    expect(pi._sent.length).toBe(2);
    expect(pi._sent[0].m.content).toBe(pi._sent[1].m.content);
  });

  test("host without sendMessage and ctx without ui never throws", async () => {
    const cmds = new Map();
    registerVccConfigCommand({ registerCommand: (n, def) => cmds.set(n, def) });
    await cmds.get("vcc-config").handler("", {});
    await cmds.get("vcc-config").handler("", undefined);
  });

  test("throwing ui.notify is tolerated, card still delivered", async () => {
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    const ctx = {
      ui: {
        notify: () => {
          throw new Error("toast down");
        },
      },
    };
    await cmds.get("vcc-config").handler("", ctx);
    expect(pi._sent.length).toBe(1);
    expect(pi._sent[0].m.customType).toBe("vcc-config");
  });

  test("getSettingsPath resolves live env, not import-time const", () => {
    expect(getSettingsPath()).toBe(process.env.OMP_VCC_CONFIG_PATH);
  });

  test("fallback file is read and labeled as fallback", async () => {
    const legacy = join(tmp, "legacy.json");
    writeFileSync(legacy, JSON.stringify({ debug: true }));
    process.env.PI_VCC_CONFIG_PATH = legacy;
    const { pi, cmds } = makePi();
    registerVccConfigCommand(pi);
    const { ctx } = makeCtx();
    await cmds.get("vcc-config").handler("", ctx);
    const content = pi._sent[0].m.content;
    expect(content).toContain(`Source: fallback file ${legacy}`);
    expect(content).toContain("- debug: on (file)");
  });

  test("formatVccConfigCard covers all four status branches", () => {
    const base = {
      path: "/primary.json",
      values: { ...DEFAULT_SETTINGS },
      sources: Object.fromEntries(ALL_KEYS.map((k) => [k, "default"])),
    };
    const missing = formatVccConfigCard({ ...base, readPath: null, filePresent: false, fileValid: false });
    expect(missing).toContain("No config file found");
    for (const k of ALL_KEYS) {
      expect(missing).toContain(`- ${k}: ${onOff(DEFAULT_SETTINGS[k])} (default)`);
    }
    const broken = formatVccConfigCard({ ...base, readPath: null, filePresent: true, fileValid: false });
    expect(broken).toContain("unparseable");
    const primary = formatVccConfigCard({ ...base, readPath: "/primary.json", filePresent: true, fileValid: true });
    expect(primary).toContain("Source: file /primary.json");
    const fallback = formatVccConfigCard({ ...base, readPath: "/other.json", filePresent: true, fileValid: true });
    expect(fallback).toContain("Source: fallback file /other.json");
  });

  test("formatVccConfigCard key order follows DEFAULT_SETTINGS", () => {
    const view = {
      path: "/tmp/x.json",
      readPath: null,
      filePresent: false,
      fileValid: false,
      values: { ...DEFAULT_SETTINGS },
      sources: Object.fromEntries(ALL_KEYS.map((k) => [k, "default"])),
    };
    const lines = formatVccConfigCard(view).split("\n").filter((l) => l.startsWith("- "));
    expect(lines.map((l) => l.slice(2).split(":")[0])).toEqual(ALL_KEYS);
  });
});
