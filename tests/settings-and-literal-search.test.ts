// @ts-nocheck
// Steps 10, 11, 12 regressions (low-severity correctness).
//
// Step 10: the config path chain used `??`, which falls through only on
// null/undefined — an env var set to "" collapsed the path to a cwd-relative
// "omp-vcc/config.json" that scaffoldSettings() would create. It also treated
// $PI_CODING_AGENT_DIR as a config root, but both hosts define that as the
// SESSION storage directory (default ~/.omp/agent).
//
// Step 11: the literal-retry for backslash queries was gated on ZERO combined
// hits. A multi-word query containing a path ("fix C:\temp\build.log") scores
// BM25 hits for the ordinary words, which suppressed the retry — so the path
// was never found, contradicting the function's own doc comment.
//
// Step 12 lives in tests/tool-output-budget.test.ts.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { isAbsolute } from "path";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { getSettingsPath, loadSettings, loadSettingsWithSources, loadSettingsWithPluginOverlay, pluginsDirCandidates, DEFAULT_SETTINGS } from "../extensions/vcc-core/core/settings";
import { searchEntriesDetailed } from "../extensions/vcc-core/core/search-entries";

const ENV_KEYS = ["OMP_VCC_CONFIG_PATH", "PI_VCC_CONFIG_PATH", "OMP_DIR", "PI_CODING_AGENT_DIR"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

const SETTINGS_MODULE = new URL("../extensions/vcc-core/core/settings.ts", import.meta.url).pathname;

// SETTINGS_PATH_DEFAULT is computed at module load, so import-time env has to be
// exercised in a fresh process.
const pathWithEnv = (env: Record<string, string>): string => {
  const script = `import { getSettingsPath } from ${JSON.stringify(SETTINGS_MODULE)}; process.stdout.write(getSettingsPath());`;
  return execFileSync("bun", ["--eval", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
};
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("step 10: config path resolution", () => {
  test("an empty OMP_VCC_CONFIG_PATH does not produce a relative path", () => {
    process.env.OMP_VCC_CONFIG_PATH = "";
    const path = getSettingsPath();
    expect(isAbsolute(path)).toBe(true);
    expect(path.startsWith("omp-vcc")).toBe(false);
  });

  test("an empty PI_VCC_CONFIG_PATH does not produce a relative path", () => {
    process.env.PI_VCC_CONFIG_PATH = "";
    expect(isAbsolute(getSettingsPath())).toBe(true);
  });

  test("PI_CODING_AGENT_DIR still roots the config (no silent relocation)", () => {
    // pi documents this as "Override the config directory"
    // (coding-agent/docs/environment-variables.md:81) while omp's help calls it
    // the session storage directory. Removing it from the chain would silently
    // relocate an existing pi config to ~/.omp and re-default every setting.
    // SETTINGS_PATH_DEFAULT is frozen at import time, so run this in a subprocess.
    expect(pathWithEnv({ PI_CODING_AGENT_DIR: "/custom/agent-dir" }))
      .toBe("/custom/agent-dir/omp-vcc/config.json");
  });

  test("OMP_DIR wins over PI_CODING_AGENT_DIR when both are set (no regression)", () => {
    expect(pathWithEnv({ OMP_DIR: "/custom/omp-root", PI_CODING_AGENT_DIR: "/custom/agent-dir" }))
      .toBe("/custom/omp-root/omp-vcc/config.json");
  });

  test("an empty OMP_DIR at import time falls through to ~/.omp", () => {
    expect(pathWithEnv({ OMP_DIR: "" }))
      .toBe(join(homedir(), ".omp", "omp-vcc", "config.json"));
  });

  test("an empty PI_CODING_AGENT_DIR falls through rather than rooting at /", () => {
    const path = pathWithEnv({ PI_CODING_AGENT_DIR: "" });
    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(join(homedir(), ".omp", "omp-vcc", "config.json"));
  });

  test("PI_CONFIG_DIR roots the config (omp's real config-root knob)", () => {
    // omp documents PI_CONFIG_DIR as "Config root dirname under home
    // (default .omp)" (coding-agent/docs/environment-variables.md:533). It was
    // previously ignored entirely, so a user with a custom root silently fell
    // back to ~/.omp.
    expect(pathWithEnv({ PI_CONFIG_DIR: ".custom-omp" }))
      .toBe(join(homedir(), ".custom-omp", "omp-vcc", "config.json"));
    expect(pathWithEnv({ PI_CONFIG_DIR: "/abs/config-root" }))
      .toBe("/abs/config-root/omp-vcc/config.json");
    expect(pathWithEnv({ OMP_DIR: "/custom/omp-root", PI_CONFIG_DIR: "/abs/config-root" }))
      .toBe("/custom/omp-root/omp-vcc/config.json");
  });

  test("an explicit absolute config path still wins (no regression)", () => {
    process.env.OMP_VCC_CONFIG_PATH = "/tmp/explicit.json";
    expect(getSettingsPath()).toBe("/tmp/explicit.json");
  });
});

describe("step 11: literal retry inside a multi-word query", () => {
  const rendered: any[] = [
    { index: 0, role: "user", summary: "please fix the build" },
    { index: 1, role: "user", summary: "log lives at C:\\temp\\build.log" },
  ];
  const messages: any[] = [
    { role: "user", content: "please fix the build" },
    { role: "user", content: "log lives at C:\\temp\\build.log" },
  ];

  test("a literal path inside a multi-word query is found", () => {
    const result = searchEntriesDetailed(rendered, messages, "fix C:\\temp\\build.log");
    expect(result.hits.some((hit) => hit.summary.includes("C:\\temp\\build.log"))).toBe(true);
  });

  test("the plain literal path query still resolves", () => {
    const result = searchEntriesDetailed(rendered, messages, "C:\\temp\\build.log");
    expect(result.hits.some((hit) => hit.summary.includes("C:\\temp\\build.log"))).toBe(true);
  });

  test("the ordinary-word hits are not dropped by the union", () => {
    const result = searchEntriesDetailed(rendered, messages, "fix C:\\temp\\build.log");
    expect(result.hits.length).toBeGreaterThan(1);
  });

  test("a literal hit survives even when the first pass already filled the cap", () => {
    // Appending literal hits after an already-capped first pass put them at
    // position 51+, where capHits sliced them straight back off — so the retry
    // was a no-op in exactly the large-corpus case it exists for.
    const bigRendered: any[] = [];
    const bigMessages: any[] = [];
    for (let i = 0; i < 60; i++) {
      bigRendered.push({ index: i, role: "user", summary: `step ${i} of the plan` });
      bigMessages.push({ role: "user", content: `step ${i} of the plan` });
    }
    bigRendered.push({ index: 60, role: "user", summary: "log lives at C:\\temp\\build.log" });
    bigMessages.push({ role: "user", content: "log lives at C:\\temp\\build.log" });

    const result = searchEntriesDetailed(bigRendered, bigMessages, "step C:\\temp\\build.log");
    expect(result.hits.length).toBeLessThanOrEqual(50);
    expect(result.hits.some((hit) => hit.summary.includes("C:\\temp\\build.log"))).toBe(true);
  });

  test("hits are de-duplicated by index", () => {
    const result = searchEntriesDetailed(rendered, messages, "fix C:\\temp\\build.log");
    const indexes = result.hits.map((hit) => hit.index);
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  test("a backslash query matching nothing still reports none", () => {
    const result = searchEntriesDetailed(rendered, messages, "absent C:\\nope\\missing.log");
    expect(result.hits).toEqual([]);
  });

  test("queries without a backslash are untouched (no regression)", () => {
    const result = searchEntriesDetailed(rendered, messages, "build");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => typeof hit.index === "number")).toBe(true);
  });
});

// Runs the module in a fresh process with a synthetic HOME, so import-time
// constants and the real filesystem are both exercised.
const settingsWithHome = (home: string, extra: Record<string, string> = {}) => {
  const script = `
    const S = require(${JSON.stringify(SETTINGS_MODULE)});
    const fs = require("fs");
    const v = S.loadSettingsWithSources({ ui: { notify: () => {} } });
    S.scaffoldSettings();
    process.stdout.write(JSON.stringify({
      readPath: v.readPath,
      fileValid: v.fileValid,
      vccEnabled: v.values.vccEnabled,
      overrideDefaultCompaction: v.values.overrideDefaultCompaction,
      primaryCreated: fs.existsSync(S.getSettingsPath()),
    }));
  `;
  return JSON.parse(execFileSync("bun", ["--eval", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, ...extra },
  }));
};

describe("settings: config resolution and corrupt-file recovery", () => {
  test("relative or ~-prefixed roots never produce a cwd-relative path", () => {
    // A relative root used to reach scaffoldSettings(), which mkdir'd a stray
    // directory tree inside whatever directory the host was launched from.
    expect(pathWithEnv({ PI_CODING_AGENT_DIR: "relagent" })).toBe(join(homedir(), "relagent", "omp-vcc", "config.json"));
    expect(pathWithEnv({ OMP_DIR: "relomp" })).toBe(join(homedir(), "relomp", "omp-vcc", "config.json"));
    expect(pathWithEnv({ PI_CODING_AGENT_DIR: "~/tildeagent" })).toBe(join(homedir(), "tildeagent", "omp-vcc", "config.json"));
    expect(pathWithEnv({ PI_CONFIG_DIR: "relcfg" })).toBe(join(homedir(), "relcfg", "omp-vcc", "config.json"));
  });

  test("a corrupt legacy pi config does not shadow a valid omp config", () => {
    const home = mkdtempSync(join(tmpdir(), "vcc-home-"));
    try {
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      mkdirSync(join(home, ".omp", "omp-vcc"), { recursive: true });
      writeFileSync(join(home, ".pi", "agent", "pi-vcc-config.json"), "BROKEN{");
      writeFileSync(join(home, ".omp", "omp-vcc", "config.json"), JSON.stringify({ vccEnabled: false, overrideDefaultCompaction: false }));

      // The fallback chain is only consulted when the primary is MISSING, so
      // point the override at a path that does not exist yet (the case the
      // corrupt legacy file used to win).
      const primary = join(home, "custom", "c.json");
      const r = settingsWithHome(home, { OMP_VCC_CONFIG_PATH: primary });
      // The corrupt legacy candidate is skipped and the valid file wins...
      expect(r.readPath).toBe(join(home, ".omp", "omp-vcc", "config.json"));
      expect(r.fileValid).toBe(true);
      expect(r.vccEnabled).toBe(false);
      expect(r.overrideDefaultCompaction).toBe(false);
      // ...and the primary is still created rather than being blocked forever.
      expect(r.primaryCreated).toBe(true);
      expect(existsSync(primary)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // `pluginsDirCandidates` takes injectable roots so the resolved store list is
  // auditable without spawning a host. Modules are imported in this process, so
  // the module-load `configRoot` is passed explicitly as `configBase`.
  const candidates = (
    env: Record<string, string | undefined>,
    configBase = "/u/.omp",
    ompBase?: string,
  ) => pluginsDirCandidates(env, "/u", configBase, ompBase);

  // Precedence, not just membership: `hostStoreOverlay` merges in array order
  // with last-write-wins, so the LAST entry outranks the earlier ones. The host
  // resolves getPluginsDir() to the PROFILE root, so every profile-scoped root
  // must come last.
  test("with no overrides the store is <configRoot>/plugins", () => {
    expect(candidates({})).toEqual(["/u/.omp/plugins"]);
  });

  test("XDG_DATA_HOME adds the migrated store at higher precedence than the legacy root", () => {
    expect(candidates({ XDG_DATA_HOME: "/xdg" }))
      .toEqual(["/u/.omp/plugins", "/xdg/omp/plugins"]);
  });

  // omp's getPluginsDir() is the PROFILE config root, so a named profile moves
  // the store under profiles/<name>; only the unprofiled XDG form was covered.
  test("a named profile adds <configRoot>/profiles/<name>/plugins at top precedence", () => {
    expect(candidates({ OMP_PROFILE: "work" }))
      .toEqual(["/u/.omp/plugins", "/u/.omp/profiles/work/plugins"]);
  });

  test("a profiled XDG root is probed too, and outranks the config-root one", () => {
    expect(candidates({ OMP_PROFILE: "work", XDG_DATA_HOME: "/xdg" })).toEqual([
      "/u/.omp/plugins",
      "/xdg/omp/plugins",
      "/u/.omp/profiles/work/plugins",
      "/xdg/omp/profiles/work/plugins",
    ]);
  });

  test("PI_PROFILE is the legacy fallback and OMP_PROFILE wins over it", () => {
    expect(candidates({ PI_PROFILE: "legacy" }))
      .toContain("/u/.omp/profiles/legacy/plugins");
    const both = candidates({ OMP_PROFILE: "canon", PI_PROFILE: "legacy" });
    expect(both).toContain("/u/.omp/profiles/canon/plugins");
    expect(both).not.toContain("/u/.omp/profiles/legacy/plugins");
  });

  // omp consults PI_PROFILE only when OMP_PROFILE is UNDEFINED: an explicitly
  // empty OMP_PROFILE selects the default profile on purpose rather than
  // inheriting the legacy variable. `??` on a non-empty test collapsed "" to
  // undefined and read an INACTIVE profile's store.
  test("an explicitly empty OMP_PROFILE selects the default profile", () => {
    expect(candidates({ OMP_PROFILE: "", PI_PROFILE: "work" }))
      .toEqual(["/u/.omp/plugins"]);
  });

  test("an invalid profile name is skipped instead of escaping the config root", () => {
    for (const bad of ["../../etc", "/abs", "", ".", "UPPER", "a".repeat(65)]) {
      const dirs = candidates({ OMP_PROFILE: bad });
      expect(dirs).toEqual(["/u/.omp/plugins"]);
      expect(dirs.some((d) => d.includes("profiles"))).toBe(false);
    }
  });

  test("PI_CONFIG_DIR relocates the store and keeps the legacy read fallback", () => {
    expect(candidates({}, "/x/custom")).toEqual(["/u/.omp/plugins", "/x/custom/plugins"]);
  });

  test("a profile inside a relocated config root moves with it", () => {
    expect(candidates({ OMP_PROFILE: "work" }, "/x/custom"))
      .toEqual(["/u/.omp/plugins", "/x/custom/plugins", "/x/custom/profiles/work/plugins"]);
  });

  test("duplicate roots are collapsed", () => {
    // $OMP_DIR, the config root and the legacy fallback all resolve to the same
    // directory here, so the candidate list must not carry it three times.
    expect(candidates({}, "/u/.omp", "/u/.omp")).toEqual(["/u/.omp/plugins"]);
  });

  // The reviewer's counterexample: both the base and the profile root hold a
  // lock file, and the ACTIVE profile's value must win for every key it defines
  // — not only the keys the base root leaves undefined.
  //
  // Uses the XDG roots because XDG_DATA_HOME and OMP_PROFILE are read at CALL
  // time, so no module-load env (and therefore no subprocess) is needed. Both
  // files set the SAME key to two DIFFERENT non-default values, so the
  // assertion cannot pass by default.
  test("the active profile's lock file outranks the default-profile one", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "vcc-profprec-"));
    const saved = {
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      OMP_PROFILE: process.env.OMP_PROFILE,
      PI_PROFILE: process.env.PI_PROFILE,
    };
    try {
      process.env.XDG_DATA_HOME = dataHome;
      process.env.OMP_PROFILE = "work";
      delete process.env.PI_PROFILE;
      const writeLock = (dir: string, settings: Record<string, unknown>) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "omp-plugins.lock.json"), JSON.stringify({ plugins: {}, settings: { "omp-vcc": settings } }));
      };
      writeLock(join(dataHome, "omp", "plugins"), { retainedToolOutputMaxTokens: 11111, debug: true });
      writeLock(join(dataHome, "omp", "profiles", "work", "plugins"), { retainedToolOutputMaxTokens: 22222 });

      const v = loadSettingsWithPluginOverlay({ cwd: dataHome });
      expect(v.retainedToolOutputMaxTokens).toBe(22222);  // profile beats base
      expect(v.debug).toBe(true);                         // base still read as a fallback
    } finally {
      for (const [k, val] of Object.entries(saved)) {
        if (val === undefined) delete process.env[k]; else process.env[k] = val;
      }
      rmSync(dataHome, { recursive: true, force: true });
    }
  });

  // The host walks .omp → .claude → .codex → .gemini and RETURNS the first file
  // that parses. Merging every directory inverted precedence (on omp `.pi`
  // overrode `.omp`) and skipped the dirs the host actually reads.
  const overlayWithProject = (project: Record<string, unknown>) => {
    const home = mkdtempSync(join(tmpdir(), "vcc-proj-"));
    try {
      for (const [dir, document] of Object.entries(project)) {
        mkdirSync(join(home, dir), { recursive: true });
        writeFileSync(join(home, dir, "plugin-overrides.json"), JSON.stringify(document));
      }
      return loadSettingsWithPluginOverlay({ cwd: home });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  test("project overrides resolve first-wins, .omp before .claude", () => {
    const v = overlayWithProject({
      ".omp": { settings: { "omp-vcc": { vccEnabled: false, overrideDefaultCompaction: true } } },
      ".claude": { settings: { "omp-vcc": { vccEnabled: true, overrideDefaultCompaction: false } } },
    });
    expect(v.vccEnabled).toBe(false);
    expect(v.overrideDefaultCompaction).toBe(true);
  });

  test("a project override in .claude is read when .omp has none", () => {
    const v = overlayWithProject({ ".claude": { settings: { "omp-vcc": { vccEnabled: false } } } });
    expect(v.vccEnabled).toBe(false);
  });

  test("a project override in .codex is read when .omp and .claude have none", () => {
    const v = overlayWithProject({ ".codex": { settings: { "omp-vcc": { vccEnabled: false } } } });
    expect(v.vccEnabled).toBe(false);
  });

  test("a .pi/plugin-overrides.json is ignored — no host reads .pi", () => {
    const v = overlayWithProject({ ".pi": { settings: { "omp-vcc": { vccEnabled: false } } } });
    expect(v.vccEnabled).toBe(DEFAULT_SETTINGS.vccEnabled);
  });

  // Neither host exposes `ctx.settings` or `ctx.config`, so the documented
  // ctx-overlay tier could never fire. It is gone; a ctx that stubs one must
  // not change the result, and every key must still report its real source.
  test("a ctx-provided settings object no longer overlays the file", () => {
    const home = mkdtempSync(join(tmpdir(), "vcc-ctx-tier-"));
    const saved = process.env.OMP_VCC_CONFIG_PATH;
    const savedPi = process.env.PI_VCC_CONFIG_PATH;
    try {
      const cfg = join(home, "config.json");
      writeFileSync(cfg, JSON.stringify({ vccEnabled: false }));
      process.env.OMP_VCC_CONFIG_PATH = cfg;
      process.env.PI_VCC_CONFIG_PATH = cfg;
      const ctx = { cwd: home, settings: { get: () => true }, config: { get: () => true } };
      expect(loadSettings(ctx).vccEnabled).toBe(false);
      expect(loadSettingsWithSources(ctx).values.vccEnabled).toBe(false);
      expect(loadSettingsWithSources(ctx).sources.vccEnabled).toBe("file");
    } finally {
      if (saved === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
      else process.env.OMP_VCC_CONFIG_PATH = saved;
      if (savedPi === undefined) delete process.env.PI_VCC_CONFIG_PATH;
      else process.env.PI_VCC_CONFIG_PATH = savedPi;
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Runs the module in a fresh process with an isolated HOME/XDG root.
  const sourcesWithStore = (home: string, store: unknown) => {
    mkdirSync(join(home, "omp", "plugins"), { recursive: true });
    writeFileSync(join(home, "omp", "plugins", "omp-plugins.lock.json"), JSON.stringify(store));
    const script = `
      const S = require(${JSON.stringify(SETTINGS_MODULE)});
      const v = S.loadSettingsWithSources({ cwd: ${JSON.stringify(home)}, ui: { notify: () => {} } });
      process.stdout.write(JSON.stringify({
        vccEnabled: v.values.vccEnabled,
        mode: v.values.compactionSummaryMode,
        src: v.sources.vccEnabled,
      }));
    `;
    return JSON.parse(execFileSync("bun", ["--eval", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_DATA_HOME: home },
    }));
  };

  test("the host plugin-settings store is read from disk", () => {
    // `getPluginSettings()` cannot resolve at runtime from a plugin install, so
    // the manifest settings were unreachable; read the host's own store.
    const home = mkdtempSync(join(tmpdir(), "vcc-store-"));
    try {
      const r = sourcesWithStore(home, {
        plugins: {},
        settings: { "omp-vcc": { vccEnabled: false, compactionSummaryMode: "rewrite" } },
      });
      expect(r.vccEnabled).toBe(false);
      expect(r.mode).toBe("rewrite");
      expect(r.src).toBe("overlay");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an out-of-contract host-store value falls through to the default", () => {
    const home = mkdtempSync(join(tmpdir(), "vcc-store-bad-"));
    try {
      const r = sourcesWithStore(home, { plugins: {}, settings: { "omp-vcc": { vccEnabled: "no", compactionSummaryMode: "nonsense" } } });
      expect(r.vccEnabled).toBe(true);       // DEFAULT_SETTINGS
      expect(r.mode).toBe("append");         // DEFAULT_SETTINGS
      expect(r.src).not.toBe("overlay");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a malformed host store is ignored, never fatal", () => {
    const home = mkdtempSync(join(tmpdir(), "vcc-store-broken-"));
    try {
      mkdirSync(join(home, "omp", "plugins"), { recursive: true });
      writeFileSync(join(home, "omp", "plugins", "omp-plugins.lock.json"), "NOT JSON{");
      const script = `
        const S = require(${JSON.stringify(SETTINGS_MODULE)});
        const v = S.loadSettingsWithSources({ cwd: ${JSON.stringify(home)}, ui: { notify: () => {} } });
        process.stdout.write(JSON.stringify({ vccEnabled: v.values.vccEnabled }));
      `;
      const out = JSON.parse(execFileSync("bun", ["--eval", script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: home, XDG_DATA_HOME: home },
      }));
      expect(out.vccEnabled).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("with no valid candidate at all the primary is created from defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "vcc-home-empty-"));
    try {
      const r = settingsWithHome(home);
      expect(r.primaryCreated).toBe(true);
      expect(r.vccEnabled).toBe(true); // DEFAULT_SETTINGS
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});