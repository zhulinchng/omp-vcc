// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { createRequire } from "node:module";

type PluginSettingsLoader = (pluginName: string, cwd: string) => Promise<Record<string, unknown>>;
let pluginSettingsLoader: PluginSettingsLoader | null | undefined;
const resolvePluginSettingsLoader = (): PluginSettingsLoader | null => {
  if (pluginSettingsLoader !== undefined) return pluginSettingsLoader;
  try {
    const req = createRequire(import.meta.url);
    for (const id of [
      "@oh-my-pi/pi-coding-agent/extensibility/plugins",
      "@earendil-works/pi-coding-agent/extensibility/plugins",
    ]) {
      try {
        const mod = req(id) as { getPluginSettings?: PluginSettingsLoader };
        if (typeof mod.getPluginSettings === "function") {
          pluginSettingsLoader = mod.getPluginSettings;
          return pluginSettingsLoader;
        }
      } catch {}
    }
  } catch {}
  pluginSettingsLoader = null;
  return pluginSettingsLoader;
};
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
// Also handles concurrent-test env shadowing: if OMP path is set by another test but file missing,
// fall back to PI path before default.
const fallbackReadPath = (): string | null => {
  const candidates: string[] = [];
  if (process.env.OMP_VCC_CONFIG_PATH) candidates.push(process.env.OMP_VCC_CONFIG_PATH);
  if (process.env.PI_VCC_CONFIG_PATH) candidates.push(process.env.PI_VCC_CONFIG_PATH);
  if (!candidates.includes(legacyPiPath)) candidates.push(legacyPiPath);
  if (!candidates.includes(SETTINGS_PATH_DEFAULT)) candidates.push(SETTINGS_PATH_DEFAULT);
  for (const p of candidates) if (existsSync(p)) return p;
  // No candidate exists — return primary for creation path (used by scaffold)
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
  /** Use append-only segments with a mutable trailing summary. */
  compactionSummaryMode: "rewrite" | "append";
  /** Maximum provider-visible retained tool-output tokens; 0 disables projection. */
  retainedToolOutputMaxTokens: number;
  /** Emit a display-only notification for text dropped during compaction. */
  showPreCompactionMessage: boolean;
  /** Maximum model-facing recall response characters; 0 disables the cap. */
  recallResponseMaxChars: number;
  /** Query oh-my-pi's public native memory backend during compaction. */
  nativeMemory: boolean;
  /** Write bounded rotating JSONL metrics under the omp config directory. */
  debugLog: boolean;
}

export const DEFAULT_SETTINGS: PiVccSettings = {
  vccEnabled: true,
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  continueAfterThresholdCompact: true,
  debug: false,
  chainShakeHint: false,
  compactionSummaryMode: "append",
  retainedToolOutputMaxTokens: 20_000,
  showPreCompactionMessage: true,
  recallResponseMaxChars: 48_000,
  nativeMemory: true,
  debugLog: false,
};

export type JsonReadStatus =
  | { kind: "missing" }
  | { kind: "valid"; value: Record<string, unknown> }
  | { kind: "invalid" };

export const readJsonStatus = (path: string): JsonReadStatus => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "invalid" };
    return { kind: "valid", value: value as Record<string, unknown> };
  } catch {
    return { kind: "invalid" };
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const warnedConfigPaths = new WeakMap<object, Set<string>>();
const warnedConfigPathsWithoutContext = new Set<string>();
const warnInvalidConfig = (ctx: unknown, path: string): void => {
  const root = asRecord(ctx);
  const owner = asRecord(root?.sessionManager) ?? (ctx && (typeof ctx === "object" || typeof ctx === "function") ? ctx as object : null);
  const seen = owner ? warnedConfigPaths.get(owner) ?? new Set<string>() : warnedConfigPathsWithoutContext;
  if (owner && !warnedConfigPaths.has(owner)) warnedConfigPaths.set(owner, seen);
  if (seen.has(path)) return;
  seen.add(path);
  try {
    const ui = asRecord(root?.ui);
    if (typeof ui?.notify === "function") ui.notify.call(ui, `omp-vcc: config file ${path} is invalid; using defaults`, "warning");
  } catch {}
};

const BOOLEAN_SETTING_KEYS: Array<keyof PiVccSettings> = [
  "vccEnabled", "overrideDefaultCompaction", "smartKeepTail", "continueAfterThresholdCompact",
  "debug", "chainShakeHint", "showPreCompactionMessage", "nativeMemory", "debugLog",
];
const isValidSettingValue = (key: keyof PiVccSettings, value: unknown): boolean => {
  if (BOOLEAN_SETTING_KEYS.includes(key)) return typeof value === "boolean";
  if (key === "compactionSummaryMode") return value === "rewrite" || value === "append";
  if (key === "retainedToolOutputMaxTokens") return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 200_000;
  if (key === "recallResponseMaxChars") return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2_000_000;
  return true;
};

const normalizeSettings = (value: Record<string, unknown> | undefined): PiVccSettings => {
  const merged: PiVccSettings = { ...DEFAULT_SETTINGS, ...(value ?? {}) };
  for (const key of BOOLEAN_SETTING_KEYS) {
    if (typeof merged[key] !== "boolean") merged[key] = DEFAULT_SETTINGS[key];
  }
  if (merged.compactionSummaryMode !== "rewrite" && merged.compactionSummaryMode !== "append") {
    merged.compactionSummaryMode = DEFAULT_SETTINGS.compactionSummaryMode;
  }
  const retained = merged.retainedToolOutputMaxTokens;
  if (typeof retained !== "number" || !Number.isFinite(retained) || retained < 0 || retained > 200_000) {
    merged.retainedToolOutputMaxTokens = DEFAULT_SETTINGS.retainedToolOutputMaxTokens;
  }
  const recall = merged.recallResponseMaxChars;
  if (typeof recall !== "number" || !Number.isFinite(recall) || recall < 0 || recall > 2_000_000) {
    merged.recallResponseMaxChars = DEFAULT_SETTINGS.recallResponseMaxChars;
  }
  return merged;
};

const tryGetSetting = (ctx: unknown, key: string): unknown => {
  try {
    const root = asRecord(ctx);
    if (!root) return undefined;
    for (const containerKey of ["settings", "config"] as const) {
      const container = asRecord(root[containerKey]);
      if (!container) continue;
      const getter = container.get;
      if (typeof getter === "function") return getter.call(container, key);
      if (key in container) return container[key];
    }
  } catch {}
  return undefined;
};

const contextOverlay = (ctx: unknown): Partial<PiVccSettings> => {
  const overlay: Partial<PiVccSettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PiVccSettings)[]) {
    const value = tryGetSetting(ctx, `plugins.@zhulinchng/omp-vcc.${key}`)
      ?? tryGetSetting(ctx, `plugins.omp-vcc.${key}`)
      ?? tryGetSetting(ctx, `omp-vcc.${key}`)
      ?? tryGetSetting(ctx, key);
    if (value !== undefined) Object.assign(overlay, { [key]: value });
  }
  return overlay;
};


const readFileSettings = (ctx?: unknown): { values: PiVccSettings; parsed: Record<string, unknown> | null; readPath: string | null; filePresent: boolean; fileValid: boolean } => {
  const primary = settingsPath();
  const primaryStatus = readJsonStatus(primary);
  let parsed: Record<string, unknown> | null = null;
  let readPath: string | null = null;
  let filePresent = primaryStatus.kind !== "missing";
  let fileValid = false;
  if (primaryStatus.kind === "valid") {
    parsed = primaryStatus.value;
    readPath = primary;
    fileValid = true;
  } else if (primaryStatus.kind === "invalid") {
    readPath = primary;
    warnInvalidConfig(ctx, primary);
  } else {
    const fb = fallbackReadPath();
    if (fb && fb !== primary) {
      const fallbackStatus = readJsonStatus(fb);
      filePresent = true;
      if (fallbackStatus.kind === "valid") {
        parsed = fallbackStatus.value;
        readPath = fb;
        fileValid = true;
      } else if (fallbackStatus.kind === "invalid") {
        readPath = fb;
        warnInvalidConfig(ctx, fb);
      }
    }
  }
  return { values: normalizeSettings(parsed ?? undefined), parsed, readPath, filePresent, fileValid };
};

export function loadSettings(ctx?: unknown): PiVccSettings {
  const file = readFileSettings(ctx).values;
  if (!ctx) return file;
  const overlay = contextOverlay(ctx);
  return Object.keys(overlay).length ? normalizeSettings({ ...file, ...overlay }) : file;
}

const pluginSettingsCwd = (ctx: unknown): string | undefined => {
  const cwd = asRecord(ctx)?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
};

/** Load file settings plus the host's public plugin-settings overlay. */
export function loadSettingsWithPluginOverlay(ctx: unknown): PiVccSettings | Promise<PiVccSettings> {
  const base = loadSettings(ctx);
  const loader = resolvePluginSettingsLoader();
  const cwd = pluginSettingsCwd(ctx);
  if (!loader || !cwd) return base;
  return Promise.resolve(loader("omp-vcc", cwd))
    .then((overlay) => normalizeSettings({ ...base, ...overlay }))
    .catch(() => base);
}

export function loadSettingsWithSources(ctx?: unknown): VccConfigView {
  const path = settingsPath();
  const file = readFileSettings(ctx);
  const values = file.values;
  const sources = {} as Record<keyof PiVccSettings, VccSettingSource>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PiVccSettings)[]) {
    sources[key] = file.fileValid && file.parsed && key in file.parsed && isValidSettingValue(key, file.parsed[key])
      ? "file"
      : "default";
  }
  if (ctx) {
    const overlay = contextOverlay(ctx);
    const merged = normalizeSettings({ ...values, ...overlay });
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PiVccSettings)[]) {
      values[key] = merged[key];
      if (overlay[key] !== undefined) sources[key] = isValidSettingValue(key, overlay[key]) ? "overlay" : "default";
    }
  }
  return { path, readPath: file.readPath, filePresent: file.filePresent, fileValid: file.fileValid, values, sources };
}

export function loadSettingsWithSourcesAsync(ctx: unknown): VccConfigView | Promise<VccConfigView> {
  const view = loadSettingsWithSources(ctx);
  const loader = resolvePluginSettingsLoader();
  const cwd = pluginSettingsCwd(ctx);
  if (!loader || !cwd) return view;
  return Promise.resolve(loader("omp-vcc", cwd))
    .then((overlay) => {
      const merged = normalizeSettings({ ...view.values, ...overlay });
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PiVccSettings)[]) {
        view.values[key] = merged[key];
        if (overlay[key] !== undefined) view.sources[key] = isValidSettingValue(key, overlay[key]) ? "overlay" : "default";
      }
      return view;
    })
    .catch(() => view);
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
      const fallback = fallbackReadPath();
      if (fallback && fallback !== path) {
        const status = readJsonStatus(fallback);
        if (status.kind === "valid") {
          writeFileSync(path, `${JSON.stringify(normalizeSettings(status.value), null, 2)}\n`);
        } else if (status.kind === "invalid") {
          return;
        } else {
          writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
        }
      } else {
        writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
      }
      return;
    }

    const status = readJsonStatus(path);
    if (status.kind !== "valid") return;
    let changed = false;
    const next: Record<string, unknown> = { ...status.value };
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
/** Live-resolved config path. Unlike the `SETTINGS_PATH` const (frozen at import
 * time), this reflects the current `OMP_VCC_CONFIG_PATH` / `PI_VCC_CONFIG_PATH` env. */
export function getSettingsPath(): string {
  return settingsPath();
}

export type VccSettingSource = "file" | "overlay" | "default";

export interface VccConfigView {
  /** Live primary path — where a config file WOULD live. */
  path: string;
  /** Actual file parsed (primary, XDG/legacy fallback, or null when none). */
  readPath: string | null;
  /** True when a candidate file exists (even if unparseable). */
  filePresent: boolean;
  /** True when a candidate file parsed as a JSON object. */
  fileValid: boolean;
  /** Effective values — same merge as `loadSettings` (defaults ← file ← ctx overlay). */
  values: PiVccSettings;
  /** Per-key provenance. Presence check is `key in parsed`, so a file key that
   * happens to equal the default still counts as `file`. */
  sources: Record<keyof PiVccSettings, VccSettingSource>;
}
