// @ts-nocheck
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";
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
// omp-vcc: XDG-aware config path, mirrored from pi-vcc but under the omp base.
// Priorities: $OMP_VCC_CONFIG_PATH > $PI_VCC_CONFIG_PATH (legacy) > $OMP_DIR >
// $PI_CONFIG_DIR > $PI_CODING_AGENT_DIR > ~/.omp/omp-vcc/config.json
//
// The host knobs mean different things on the two hosts:
//   $PI_CONFIG_DIR       omp: "Config root dirname under home (default .omp)"
//                        (coding-agent/docs/environment-variables.md:533)
//   $PI_CODING_AGENT_DIR omp: agent-directory override; pi: "Override the config
//                        directory" (pi coding-agent/docs/environment-variables.md:81)
// Neither may be dropped from the chain: removing one silently relocates an
// existing config and re-defaults every setting with no warning. Each is also a
// read fallback, so no config is orphaned either way. $OMP_DIR is read for
// historical reasons but is NOT an oh-my-pi variable — its config-root knob is
// $PI_CONFIG_DIR.
//
// `??` falls through only on null/undefined, so an env var set to "" would
// otherwise collapse the path to a cwd-relative one that scaffold would create.
const nonEmptyEnv = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;
// Every root is normalised to an ABSOLUTE path. A relative or `~`-prefixed
// value would otherwise make settingsPath() cwd-relative, and scaffoldSettings()
// would mkdir a stray tree inside whatever directory the host was launched from.
const expandRoot = (value: string | undefined): string | undefined => {
  const raw = nonEmptyEnv(value);
  if (!raw) return undefined;
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : join(homedir(), expanded);
};
const configRoot = expandRoot(process.env.PI_CONFIG_DIR);
const agentDirBase = expandRoot(process.env.PI_CODING_AGENT_DIR);
const ompDirBase = expandRoot(process.env.OMP_DIR);
const defaultBase = ompDirBase ?? configRoot ?? agentDirBase ?? join(homedir(), ".omp");
export const SETTINGS_PATH_DEFAULT = join(defaultBase, "omp-vcc", "config.json");
const legacyPiPath = join(homedir(), ".pi", "agent", "pi-vcc-config.json");
const agentDirSettingsPath = agentDirBase ? join(agentDirBase, "omp-vcc", "config.json") : undefined;
const configDirSettingsPath = configRoot ? join(configRoot, "omp-vcc", "config.json") : undefined;
const settingsPath = (): string =>
  nonEmptyEnv(process.env.OMP_VCC_CONFIG_PATH) ??
  nonEmptyEnv(process.env.PI_VCC_CONFIG_PATH) ??
  SETTINGS_PATH_DEFAULT;
/** Backwards-compat export: frozen at import time (use `getSettingsPath()` for
 *  a live path that reflects the current `OMP_VCC_CONFIG_PATH`). */
export const SETTINGS_PATH = settingsPath();
// For migration: if omp config missing but legacy pi config exists, we read legacy but write to new
// Also handles concurrent-test env shadowing: if OMP path is set by another test but file missing,
// fall back to PI path before default.
/** Ordered read candidates. Callers must SKIP unparseable ones: treating the
 *  first existing file as terminal let a corrupt legacy config permanently
 *  shadow a valid config later in the chain, and blocked scaffoldSettings from
 *  ever creating the primary file. */
const fallbackReadCandidates = (): string[] => {
  const candidates: string[] = [];
  const ompPath = nonEmptyEnv(process.env.OMP_VCC_CONFIG_PATH);
  const piPath = nonEmptyEnv(process.env.PI_VCC_CONFIG_PATH);
  if (ompPath) candidates.push(ompPath);
  if (piPath) candidates.push(piPath);
  if (!candidates.includes(legacyPiPath)) candidates.push(legacyPiPath);
  if (!candidates.includes(SETTINGS_PATH_DEFAULT)) candidates.push(SETTINGS_PATH_DEFAULT);
  // Never orphan a config that used to resolve under $PI_CODING_AGENT_DIR.
  if (agentDirSettingsPath && !candidates.includes(agentDirSettingsPath)) candidates.push(agentDirSettingsPath);
  if (configDirSettingsPath && !candidates.includes(configDirSettingsPath)) candidates.push(configDirSettingsPath);
  return candidates;
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
  "debug", "showPreCompactionMessage", "nativeMemory", "debugLog",
];
const isValidSettingValue = (key: keyof PiVccSettings, value: unknown): boolean => {
  if (BOOLEAN_SETTING_KEYS.includes(key)) return typeof value === "boolean";
  if (key === "compactionSummaryMode") return value === "rewrite" || value === "append";
  if (key === "retainedToolOutputMaxTokens") return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 200_000;
  if (key === "recallResponseMaxChars") return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2_000_000;
  return true;
};

const normalizeSettings = (value: Record<string, unknown> | undefined): PiVccSettings => {
  // Copy only known keys: an unknown/typo'd file or overlay key must not leak
  // into the settings object (the /vcc-config card and its key count read this).
  const source = asRecord(value) ?? {};
  const merged: PiVccSettings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PiVccSettings)[]) {
    if (key in source) (merged as Record<string, unknown>)[key] = source[key];
  }
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
    // Namespaced forms only. A bare `<key>` probe would let an unrelated global
    // host setting of the same name (e.g. `debug`) hijack an omp-vcc key.
    const value = tryGetSetting(ctx, `plugins.@zhulinchng/omp-vcc.${key}`)
      ?? tryGetSetting(ctx, `plugins.omp-vcc.${key}`)
      ?? tryGetSetting(ctx, `omp-vcc.${key}`);
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
    for (const candidate of fallbackReadCandidates()) {
      if (candidate === primary) continue;
      const status = readJsonStatus(candidate);
      if (status.kind === "missing") continue;
      filePresent = true;
      if (status.kind === "valid") {
        parsed = status.value;
        readPath = candidate;
        fileValid = true;
        break;
      }
      // Unparseable: warn, remember it for reporting, and KEEP LOOKING — a
      // corrupt legacy file must not shadow a valid config further down.
      warnInvalidConfig(ctx, candidate);
      if (readPath === null) readPath = candidate;
    }
  }
  return { values: normalizeSettings(parsed ?? undefined), parsed, readPath, filePresent, fileValid };
};

/** Valid overlay keys only, layered over `base`: an out-of-contract overlay
 *  value must fall through to the file value, never reset it to the default. */
const applyValidOverlay = (
  base: PiVccSettings,
  overlay: Record<string, unknown>,
): { values: PiVccSettings; applied: Set<keyof PiVccSettings> } => {
  const accepted: Record<string, unknown> = {};
  const applied = new Set<keyof PiVccSettings>();
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PiVccSettings)[]) {
    if (!(key in overlay)) continue;
    const value = overlay[key];
    if (value === undefined || !isValidSettingValue(key, value)) continue;
    accepted[key] = value;
    applied.add(key);
  }
  return { values: normalizeSettings({ ...base, ...accepted }), applied };
};

export function loadSettings(ctx?: unknown): PiVccSettings {
  const file = readFileSettings(ctx).values;
  if (!ctx) return file;
  const overlay = contextOverlay(ctx);
  return Object.keys(overlay).length ? applyValidOverlay(file, overlay as Record<string, unknown>).values : file;
}

const pluginSettingsCwd = (ctx: unknown): string | undefined => {
  const cwd = asRecord(ctx)?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
};

/**
 * The host's plugin-settings store, read straight off disk.
 *
 * `getPluginSettings()` is the documented bridge, but it needs
 * `@oh-my-pi/pi-coding-agent` resolvable at runtime — which it is not from a
 * plugin install: the package is ESM-only, its `./*` export maps to a source
 * FILE (`./src/*.ts`, so `.../extensibility/plugins` points at a non-existent
 * `plugins.ts`), and the plugin's install directory has no `node_modules` entry
 * for it. Every resolution base the plugin can reach returns MODULE_NOT_FOUND,
 * so the bridge never fired and every setting declared in the manifest was
 * unreachable. Read the same files the host itself reads instead:
 *   <pluginsDir>/omp-plugins.lock.json       → settings[<plugin name>]
 *   <cwd>/{.omp,.pi}/plugin-overrides.json   → settings[<plugin name>]
 * Strictly best-effort: a missing or malformed file is ignored, never fatal.
 */
const HOST_PLUGIN_NAMES = ["omp-vcc", "@zhulinchng/omp-vcc", "pi-vcc"];

const pluginsDirCandidates = (): string[] => {
  const dirs: string[] = [];
  const dataHome = nonEmptyEnv(process.env.XDG_DATA_HOME);
  if (dataHome) dirs.push(join(dataHome, "omp", "plugins"));
  if (ompDirBase) dirs.push(join(ompDirBase, "plugins"));
  dirs.push(join(homedir(), ".omp", "plugins"));
  return dirs;
};

const readJsonObject = (path: string): Record<string, unknown> | null => {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** Copy `settings[<plugin name>]` entries out of one host config document. */
const mergeHostSettings = (target: Record<string, unknown>, document: Record<string, unknown> | null): void => {
  const settings = document?.settings;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return;
  for (const name of HOST_PLUGIN_NAMES) {
    const entry = (settings as Record<string, unknown>)[name];
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      Object.assign(target, entry as Record<string, unknown>);
    }
  }
};

const hostStoreOverlay = (cwd?: string): Record<string, unknown> => {
  const overlay: Record<string, unknown> = {};
  for (const dir of pluginsDirCandidates()) {
    mergeHostSettings(overlay, readJsonObject(join(dir, "omp-plugins.lock.json")));
  }
  if (cwd) {
    for (const name of [".omp", ".pi"]) {
      mergeHostSettings(overlay, readJsonObject(join(cwd, name, "plugin-overrides.json")));
    }
  }
  return overlay;
};

/** Load file settings plus the host's public plugin-settings overlay. */
export function loadSettingsWithPluginOverlay(ctx: unknown): PiVccSettings | Promise<PiVccSettings> {
  const cwd = pluginSettingsCwd(ctx);
  // On-disk host store first (always reachable), then the module bridge on top
  // for hosts that do expose it.
  const base = applyValidOverlay(loadSettings(ctx), hostStoreOverlay(cwd)).values;
  const loader = resolvePluginSettingsLoader();
  if (!loader || !cwd) return base;
  return Promise.resolve(loader("omp-vcc", cwd))
    .then((overlay) => applyValidOverlay(base, overlay ?? {}).values)
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
  // Host store first, then the ctx bridge, so the more specific source wins.
  const overlay: Record<string, unknown> = { ...hostStoreOverlay(pluginSettingsCwd(ctx)) };
  if (ctx) Object.assign(overlay, contextOverlay(ctx));
  if (Object.keys(overlay).length > 0) {
    const merged = applyValidOverlay(values, overlay);
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PiVccSettings)[]) {
      values[key] = merged.values[key];
      if (merged.applied.has(key)) sources[key] = "overlay";
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
      const merged = applyValidOverlay(view.values, overlay ?? {});
      for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof PiVccSettings)[]) {
        view.values[key] = merged.values[key];
        if (merged.applied.has(key)) view.sources[key] = "overlay";
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
      // Migrate from the first VALID candidate. An unparseable candidate must
      // not block creation: returning here left the plugin on defaults forever,
      // re-warning on every session with no way to recover.
      let migrated = false;
      for (const candidate of fallbackReadCandidates()) {
        if (candidate === path) continue;
        const status = readJsonStatus(candidate);
        if (status.kind !== "valid") continue;
        writeFileSync(path, `${JSON.stringify(normalizeSettings(status.value), null, 2)}\n`);
        migrated = true;
        break;
      }
      if (!migrated) writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
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
