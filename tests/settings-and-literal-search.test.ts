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
import { homedir } from "os";
import { join } from "path";
import { execFileSync } from "node:child_process";
import { getSettingsPath } from "../extensions/vcc-core/core/settings";
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