#!/usr/bin/env node
/**
 * postuninstall hook: reset ownership marker and clean stale plugin entries.
 *
 * 1. Marker: ~/.config/@zhulinchng/omp-vcc/.ownership.json with { state: "owned" }
 *    When the plugin set `startup.quiet: true` in the global config, restore.
 *    No-op when marker missing or not owned.
 *
 * 2. Stale plugin entries: historic `package.json:name` renames left
 *    `@zhu/omp-vcc` → `@zhulinchng/omp-vcc` → `omp-vcc`. `omp plugin link .`
 *    under an old name creates a symlink+lock entry that survives the rename
 *    (host `PluginManager.link` did not clean same-realpath stale keys, and
 *    `PluginManager.uninstall` for linked plugins left the symlink behind).
 *    This script removes those stale symlinks+lock entries without touching
 *    correctly installed `omp-vcc` (or npm `dependencies` entries which are
 *    real directories, not symlinks).
 *    Safe to run repeatedly; also runs on extension activation (see
 *    extensions/vcc-core/core/migrate-stale.ts).
 */
import { readFileSync, rmSync, writeFileSync, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { readFile, lstat, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const HISTORIC_NAMES = ["@zhu/omp-vcc", "@zhulinchng/omp-vcc"];
const CURRENT_NAME = "omp-vcc";

export function resetOwnedQuiet(home) {
  const baseHome = home || homedir();
  const markerPath = join(baseHome, ".config", "@zhulinchng/omp-vcc", ".ownership.json");
  const configCandidates = [
    join(baseHome, ".omp", "agent", "config.yml"),
    join(baseHome, ".omp", "config.yml"),
  ];

  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return "no-marker";
  }

  const clearMarker = () => {
    try {
      rmSync(markerPath, { force: true });
    } catch {}
  };

  if (marker?.state !== "owned") {
    clearMarker();
    return "not-owned";
  }

  let content;
  let configPath;
  for (const p of configCandidates) {
    try {
      content = readFileSync(p, "utf8");
      configPath = p;
      break;
    } catch {}
  }
  if (!configPath || content === undefined) {
    clearMarker();
    return "config-missing";
  }

  const lines = content.split("\n");
  let inStartup = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^startup:\s*$/.test(line)) inStartup = true;
    else if (inStartup && /^[^ \t]/.test(line) && line.trim() !== "") inStartup = false;
    if (inStartup && /quiet:\s*true/.test(line)) {
      lines[i] = line.replace("true", "false");
      changed = true;
      break;
    }
  }

  if (changed) {
    try {
      writeFileSync(configPath, lines.join("\n"), "utf8");
    } catch {
      clearMarker();
      return "write-failed";
    }
  }

  clearMarker();
  return changed ? "restored" : "already-default";
}

// --- stale plugin cleanup (in-plugin, no host changes) ---

function isSymlinkSync(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function readJsonSync(p, fallback = null) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Remove stale `omp-vcc` plugin entries left by historic package.json renames
 * and by `omp plugin uninstall` for linked plugins (which left the symlink
 * behind on old hosts).
 *
 * - Only touches lockfile-only entries (not in `package.json:dependencies`)
 *   where `package.json:name` mismatches the lock key, or where two keys
 *   point at the same realpath.
 * - Only removes symlinks, never real directories (npm installs).
 * - Returns a summary string for logging.
 */
export function cleanupStalePluginEntries(home) {
  const baseHome = home || homedir();
  const pluginsDir = join(baseHome, ".omp", "plugins");
  const lockPath = join(pluginsDir, "omp-plugins.lock.json");
  const pkgPath = join(pluginsDir, "package.json");
  const nm = join(pluginsDir, "node_modules");

  const lock = readJsonSync(lockPath, null);
  if (!lock || typeof lock !== "object") return "no-lock";

  const pkg = readJsonSync(pkgPath, { dependencies: {} });
  const deps = (pkg && typeof pkg.dependencies === "object" && pkg.dependencies) || {};

  const pluginKeys = lock.plugins && typeof lock.plugins === "object" ? Object.keys(lock.plugins) : [];
  const ompKeys = pluginKeys.filter((k) => k.includes("omp-vcc"));

  // If no omp-vcc keys at all, still check for orphaned symlinks at historic
  // paths that may remain after `omp plugin uninstall` (old host left symlink).
  const candidates = new Set([...ompKeys, ...HISTORIC_NAMES, CURRENT_NAME]);

  let removedLocks = [];
  let removedLinks = [];

  // Helper to get package.json:name for a node_modules entry, without throwing
  const getPkgName = (name) => {
    try {
      const jp = readJsonSync(join(nm, name, "package.json"), null);
      return jp && typeof jp.name === "string" ? jp.name : null;
    } catch {
      return null;
    }
  };

  // Helper to get realpath for dedup, null if not exists or not symlink
  const getReal = (name) => {
    const p = join(nm, name);
    if (!isSymlinkSync(p)) return null;
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };

  // Map realpath -> list of lock keys that resolve to it (for dedup)
  const realToKeys = new Map();
  for (const k of ompKeys) {
    const rp = getReal(k);
    if (!rp) continue;
    const list = realToKeys.get(rp) || [];
    list.push(k);
    realToKeys.set(rp, list);
  }

  // 1. lock-only mismatch: lock key !== pkg name -> stale (e.g. @zhu/omp-vcc -> omp-vcc)
  for (const k of [...ompKeys]) {
    if (k in deps) continue; // npm-declared, keep even if name mismatches (dual publish)
    const pkgName = getPkgName(k);
    if (pkgName && pkgName !== k) {
      // Historic rename leftover: lock key is old name, package is new name
      const isHistoric = HISTORIC_NAMES.includes(k) || k !== CURRENT_NAME;
      if (isHistoric) {
        // Remove symlink if it exists
        const p = join(nm, k);
        if (isSymlinkSync(p)) {
          try {
            rmSync(p, { force: true });
            removedLinks.push(k);
            // try to remove empty scope dir e.g. .../node_modules/@zhu
            if (k.startsWith("@")) {
              const scopeDir = join(nm, k.split("/")[0]);
              try {
                if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { force: true });
              } catch {}
            }
          } catch {}
        }
        // Remove lock entry
        if (lock.plugins[k]) {
          delete lock.plugins[k];
          removedLocks.push(k);
        }
        if (lock.settings && lock.settings[k]) delete lock.settings[k];
      }
    }
  }

  // 2. duplicate realpath: two lock keys point at same directory -> keep the
  //    one where lock key === pkg name, remove the other(s)
  for (const [, keys] of realToKeys) {
    if (keys.length <= 1) continue;
    // Determine keeper: prefer CURRENT_NAME or key that matches pkg name
    let keeper = null;
    for (const k of keys) {
      const pkgName = getPkgName(k);
      if (pkgName === k) {
        keeper = k;
        break;
      }
    }
    if (!keeper) keeper = keys.includes(CURRENT_NAME) ? CURRENT_NAME : keys[0];
    for (const k of keys) {
      if (k === keeper) continue;
      // Only remove if lock-only (not deps) and symlink
      if (k in deps) continue;
      const p = join(nm, k);
      if (isSymlinkSync(p)) {
        try {
          rmSync(p, { force: true });
          if (!removedLinks.includes(k)) removedLinks.push(k);
          if (k.startsWith("@")) {
            const scopeDir = join(nm, k.split("/")[0]);
            try {
              if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { force: true });
            } catch {}
          }
        } catch {}
      }
      if (lock.plugins[k]) {
        delete lock.plugins[k];
        if (!removedLocks.includes(k)) removedLocks.push(k);
      }
      if (lock.settings && lock.settings[k]) delete lock.settings[k];
    }
  }

  // 3. orphaned symlinks at candidate paths that have no lock entry (old
  //    host left symlink after uninstall). Remove them if they are symlinks
  //    and their package name is omp-vcc (so we don't delete unrelated).
  for (const cand of candidates) {
    const p = join(nm, cand);
    if (!isSymlinkSync(p)) continue;
    const hasLock = !!lock.plugins[cand];
    if (hasLock) continue; // already handled
    const pkgName = getPkgName(cand);
    // Only remove orphaned omp-vcc symlinks, not other plugins
    if (pkgName === CURRENT_NAME || pkgName === "@zhu/omp-vcc" || pkgName === "@zhulinchng/omp-vcc") {
      try {
        rmSync(p, { force: true });
        if (!removedLinks.includes(cand)) removedLinks.push(cand);
        if (cand.startsWith("@")) {
          const scopeDir = join(nm, cand.split("/")[0]);
          try {
            if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { force: true });
          } catch {}
        }
      } catch {}
    }
  }

  if (removedLocks.length > 0 || removedLinks.length > 0) {
    try {
      writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    } catch {}
    return `cleaned locks:${removedLocks.join(",") || "none"} links:${removedLinks.join(",") || "none"}`;
  }
  return "no-stale";
}

const isDirectRun =
  process.argv[1] &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
    } catch {
      return false;
    }
  })();

if (isDirectRun) {
  try {
    const r1 = resetOwnedQuiet(homedir());
    const r2 = cleanupStalePluginEntries(homedir());
    console.log(`uninstall-reset: ${r1} ${r2}`);
  } catch (err) {
    console.log(`uninstall-reset: error ${err?.message ?? err}`);
  }
}
