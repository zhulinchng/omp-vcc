// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

// omp-vcc: XDG-aware config path, mirrored from pi-vcc but under ~/.omp
// Priorities: $OMP_VCC_CONFIG_PATH > $PI_VCC_CONFIG_PATH (legacy) > ~/.omp/omp-vcc/config.json
// Also respects $PI_CODING_AGENT_DIR / $OMP_DIR if set (oh-my-pi base dir)
const defaultBase = process.env.OMP_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp");
export const SETTINGS_PATH_DEFAULT = join(defaultBase, "omp-vcc", "config.json");
const legacyPiPath = join(homedir(), ".pi", "agent", "pi-vcc-config.json");
const settingsPath = (): string =>
  process.env.OMP_VCC_CONFIG_PATH ??
  process.env.PI_VCC_CONFIG_PATH ??
  SETTINGS_PATH_DEFAULT;
/** Backwards-compat export. Resolves at access time, not import time. */
export const SETTINGS_PATH = settingsPath();
// For migration: if omp config missing but legacy pi config exists, we read legacy but write to new
const fallbackReadPath = (): string | null => {
  const primary = settingsPath();
  if (existsSync(primary)) return primary;
  if (existsSync(legacyPiPath)) return legacyPiPath;
  return null;
};

export interface PiVccSettings {
  /** Master switch for omp-vcc — when false, no compaction interception occurs */
  vccEnabled: boolean;
  /**
   * When true (default), pi-vcc handles ALL compactions:
   *   - /compact (no args)
   *   - /compact <text>
   *   - auto threshold / overflow
   *   - /pi-vcc (always handled regardless)
   *
   * When false, pi-vcc only handles /pi-vcc; everything else falls back to
   * pi core's default LLM-based compaction. Existing config files keep their
   * stored value; the new default applies to fresh installs only.
   */
  overrideDefaultCompaction: boolean;
  /**
   * When true (default), pi-vcc boosts the default keep-tail when the current
   * keep:1 tail is small enough. Specifically: if the estimated tail for keep:1
   * is <= MIN_SMART_TAIL_TOKENS (5k), increase keep up to the largest N whose
   * tail stays <= MAX_SMART_TAIL_TOKENS (25k). Explicit `keep:N` from the user
   * is always respected and never adjusted.
   */
  smartKeepTail: boolean;
  /**
   * When true (default), pi-vcc asks the agent to continue after a successful
   * automatic compaction (threshold, or overflow after the assistant already
   * finished with stop). This avoids a UX cliff where the agent finishes a response,
   * immediately compacts, and then stops instead of continuing the task.
   * Overflow retry is still owned by pi-core via willRetry.
   */
  continueAfterThresholdCompact: boolean;
  /** Write debug snapshot to /tmp/omp-vcc-debug.json on each compaction. */
  debug: boolean;
  /**
   * When true, after a successful VCC threshold/overflow compaction, eagerly
   * trigger a follow-up shake via ctx.compact when the host rescue would not.
   * Default false: host's #rescueCompactionDeadEnd already runs shake elide
   * automatically when VCC didn't create enough headroom, and leaving shake in
   * methodOrder covers that case without a second entry. Set true only if you
   * want a chained shake even when VCC already made headroom (costs a second
   * CompactionEntry).
   */
  chainShakeHint: boolean;
}

export const DEFAULT_SETTINGS: PiVccSettings = {
  vccEnabled: true,
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  continueAfterThresholdCompact: true,
  debug: false,
  chainShakeHint: false,
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

export function loadSettings(ctx?: unknown): PiVccSettings {
  // File is source of truth, but if the host provides plugin-scoped settings
  // via ctx.settings (omp manifest `omp.settings` / `pi.settings` UI surface),
  // merge them on top of file so /settings toggles take effect without restart.
  // Host shapes vary: ctx.settings.get(key), ctx.config.get(key), or plain map.
  const tryGet = (key: string): unknown => {
    try {
      const c = ctx as any;
      if (!c) return undefined;
      if (c.settings?.get) return c.settings.get(key);
      if (c.config?.get) return c.config.get(key);
      if (c.settings && typeof c.settings === "object" && key in c.settings) return c.settings[key];
      if (c.config && typeof c.config === "object" && key in c.config) return c.config[key];
    } catch {}
    return undefined;
  };
  const file = (() => {
    const primary = settingsPath();
    const parsed = readJson(primary) ?? (() => {
      const fb = fallbackReadPath();
      return fb && fb !== primary ? readJson(fb) : null;
    })();
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(parsed as Partial<PiVccSettings>) };
  })();
  if (!ctx) return file;
  // Overlay plugin-scoped keys if host exposes them (e.g. plugins["@zhulinchng/omp-vcc"].vccEnabled)
  const overlay: Partial<PiVccSettings> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof PiVccSettings)[]) {
    const v = tryGet(`plugins.@zhulinchng/omp-vcc.${k}`) ?? tryGet(`plugins.omp-vcc.${k}`) ?? tryGet(`omp-vcc.${k}`) ?? tryGet(k);
    if (v !== undefined) (overlay as any)[k] = v;
  }
  return Object.keys(overlay).length ? { ...file, ...overlay } : file;
}

/**
 * Ensure ~/.omp/omp-vcc/config.json exists with default keys (migrates legacy pi path read).
 * - File missing → create with full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → fill in missing default keys, preserve existing values.
 */
export function scaffoldSettings(): void {
  try {
    const path = settingsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      // migrate legacy pi-vcc config if present before creating fresh
      const legacy = existsSync(legacyPiPath) ? readJson(legacyPiPath) : null;
      if (legacy && typeof legacy === "object") {
        const migrated = { ...DEFAULT_SETTINGS, ...(legacy as Partial<PiVccSettings>) };
        writeFileSync(path, `${JSON.stringify(migrated, null, 2)}\n`);
        return;
      }
      writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
      return;
    }

    const parsed = readJson(path);
    if (!parsed || typeof parsed !== "object") return; // don't clobber

    let changed = false;
    const next: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in next)) {
        next[key] = value;
        changed = true;
      }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // best-effort; never crash extension load
  }
}
