// @ts-nocheck
// E2E harness for omp-vcc — isolated OMP_DIR, synthetic sessions, omp spawn
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// ── isolated dir ──
export interface IsolatedOmpDir {
  ompDir: string;
  configPath: string;
  legacyPath: string;
  env: Record<string, string>;
  cleanup: () => void;
}

export function createIsolatedOmpDir(): IsolatedOmpDir {
  const ompDir = mkdtempSync(join(tmpdir(), "omp-vcc-e2e-"));
  // settingsPath() priority: $OMP_VCC_CONFIG_PATH > $PI_VCC_CONFIG_PATH > SETTINGS_PATH_DEFAULT (which itself uses OMP_DIR)
  // So we set both to ensure isolation even though settings.ts reads env at call time.
  const configPath = join(ompDir, "config.json");
  const legacyPath = join(ompDir, "legacy-pi-config.json");
  const env: Record<string, string> = {
    OMP_DIR: ompDir,
    PI_CODING_AGENT_DIR: ompDir,
    OMP_VCC_CONFIG_PATH: configPath,
    PI_VCC_CONFIG_PATH: configPath, // also set legacy var to same file so fallback doesn't read real home
  };
  const cleanup = () => {
    try { rmSync(ompDir, { recursive: true, force: true }); } catch {}
    // also clean debug files that may have been written
    for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) {
      try { if (existsSync(p)) unlinkSync(p); } catch {}
    }
  };
  return { ompDir, configPath, legacyPath, env, cleanup };
}

export function writeConfig(configPath: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(configPath, ".."), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

export function readConfig(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;
  try { return JSON.parse(readFileSync(configPath, "utf-8")); } catch { return null; }
}

// ── session fixture ──
export interface SessionEntry {
  id: string;
  type: string;
  [k: string]: any;
}

export function writeSessionFixture(ompDir: string, entries: SessionEntry[]): string {
  const sessionsDir = join(ompDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `test-${randomUUID()}.jsonl`);
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(file, lines + "\n");
  return file;
}

export function readSessionFixture(file: string): SessionEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ── omp spawn ──
export interface RunOmpResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  debugJson: any | null;
  timedOut: boolean;
}

export async function runOmp(args: string[], opts: { env?: Record<string, string>; input?: string; timeoutMs?: number } = {}): Promise<RunOmpResult> {
  const env = { ...process.env, ...(opts.env ?? {}) } as Record<string, string>;
  const proc = Bun.spawn(["omp", ...args], {
    env,
    stdin: opts.input != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.input != null && proc.stdin) {
    proc.stdin.write(opts.input);
    proc.stdin.end();
  }
  const timeoutMs = opts.timeoutMs ?? 15000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, timeoutMs);
  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } catch {
    exitCode = null;
  } finally {
    clearTimeout(timeout);
  }
  const stdout = await new Response(proc.stdout).text().catch(() => "");
  const stderr = await new Response(proc.stderr).text().catch(() => "");
  let debugJson: any | null = null;
  for (const p of ["/tmp/omp-vcc-debug.json", "/tmp/pi-vcc-debug.json"]) {
    if (existsSync(p)) {
      try { debugJson = JSON.parse(readFileSync(p, "utf-8")); break; } catch {}
    }
  }
  return { exitCode, stdout, stderr, debugJson, timedOut };
}

export async function isOmpAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "omp"], { stdout: "pipe", stderr: "ignore" });
    const code = await proc.exited;
    return code === 0;
  } catch { return false; }
}

export async function probeOmpFlags(): Promise<{ hasPrint: boolean; hasExtensionFlag: boolean; hasPlugin: boolean; helpText: string }> {
  try {
    const proc = Bun.spawn(["omp", "--help"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    const out = await new Response(proc.stdout).text().catch(() => "");
    const err = await new Response(proc.stderr).text().catch(() => "");
    const helpText = out + err;
    return {
      hasPrint: /--print|-p\b/.test(helpText),
      hasExtensionFlag: /--extension|-e\b/.test(helpText),
      hasPlugin: /plugin/.test(helpText),
      helpText,
    };
  } catch {
    return { hasPrint: false, hasExtensionFlag: false, hasPlugin: false, helpText: "" };
  }
}

// ── assertions ──
export function assertCompactionSavingsV2(details: any): void {
  if (!details || !details.savings) throw new Error(`details.savings missing: ${JSON.stringify(details)}`);
  const s = details.savings;
  if (s.version !== 2) throw new Error(`savings.version expected 2 got ${s.version}`);
  if (s.compactor !== "omp-vcc") throw new Error(`compactor expected omp-vcc got ${s.compactor}`);
}

export function assertSummarySections(summary: string, atLeastOneOf = ["[Session Goal]", "[Files And Changes]", "[Brief transcript]"]): void {
  const has = atLeastOneOf.some((sec) => summary.includes(sec));
  if (!has) throw new Error(`summary missing any of ${atLeastOneOf.join(", ")} — got: ${summary.slice(0, 500)}`);
}
