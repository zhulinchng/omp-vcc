// @ts-nocheck
// One-time migration: remove stale @zhu/omp-vcc lock+symlink left by renames.
// correctly installed `omp-vcc` or npm `dependencies` entries (real dirs).
// Mirrors scripts/uninstall-reset.js:cleanupStalePluginEntries.

import * as fsSync from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HISTORIC = ["@zhu/omp-vcc", "@zhulinchng/omp-vcc"];
const CURRENT = "omp-vcc";

function readJson(p: string): unknown | null {
  try {
    return JSON.parse(fsSync.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function isSymlink(p: string): boolean {
  try {
    return fsSync.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function migrateStalePluginEntries(home?: string): string {
  const baseHome = home || homedir();
  const pluginsDir = join(baseHome, ".omp", "plugins");
  const lockPath = join(pluginsDir, "omp-plugins.lock.json");
  const pkgPath = join(pluginsDir, "package.json");
  const nm = join(pluginsDir, "node_modules");

  const lockRaw = readJson(lockPath) as { plugins?: Record<string, unknown>; settings?: Record<string, unknown> } | null;
  if (!lockRaw || typeof lockRaw !== "object") return "no-lock";

  const pkgRaw = readJson(pkgPath) as { dependencies?: Record<string, string> } | null;
  const deps: Record<string, string> = (pkgRaw && typeof pkgRaw.dependencies === "object" && pkgRaw.dependencies) || {};

  const pluginKeys: string[] = lockRaw.plugins ? Object.keys(lockRaw.plugins) : [];
  const ompKeys = pluginKeys.filter((k) => k.includes("omp-vcc"));
  const candidates = new Set([...ompKeys, ...HISTORIC, CURRENT]);

  let removedLocks: string[] = [];
  let removedLinks: string[] = [];

  const getPkgName = (name: string): string | null => {
    const j = readJson(join(nm, name, "package.json")) as { name?: string } | null;
    return j && typeof j.name === "string" ? j.name : null;
  };

  const getReal = (name: string): string | null => {
    const p = join(nm, name);
    if (!isSymlink(p)) return null;
    try {
      return fsSync.realpathSync(p);
    } catch {
      return null;
    }
  };

  const realToKeys = new Map<string, string[]>();
  for (const k of ompKeys) {
    const rp = getReal(k);
    if (!rp) continue;
    const list = realToKeys.get(rp) || [];
    list.push(k);
    realToKeys.set(rp, list);
  }

  for (const k of [...ompKeys]) {
    if (k in deps) continue;
    const pkgName = getPkgName(k);
    if (pkgName && pkgName !== k) {
      const isHistoric = HISTORIC.includes(k) || k !== CURRENT;
      if (isHistoric) {
        const p = join(nm, k);
        if (isSymlink(p)) {
          try {
            fsSync.rmSync(p, { force: true });
            removedLinks.push(k);
            if (k.startsWith("@")) {
              const scopeDir = join(nm, k.split("/")[0]!);
              try {
                if (fsSync.readdirSync(scopeDir).length === 0) fsSync.rmSync(scopeDir, { force: true });
              } catch {}
            }
          } catch {}
        }
        if (lockRaw.plugins && (lockRaw.plugins as Record<string, unknown>)[k]) {
          delete (lockRaw.plugins as Record<string, unknown>)[k];
          removedLocks.push(k);
        }
        if (lockRaw.settings && (lockRaw.settings as Record<string, unknown>)[k]) delete (lockRaw.settings as Record<string, unknown>)[k];
      }
    }
  }

  for (const [, keys] of realToKeys) {
    if (keys.length <= 1) continue;
    let keeper: string | null = null;
    for (const k of keys) {
      if (getPkgName(k) === k) {
        keeper = k;
        break;
      }
    }
    if (!keeper) keeper = keys.includes(CURRENT) ? CURRENT : keys[0]!;
    for (const k of keys) {
      if (k === keeper) continue;
      if (k in deps) continue;
      const p = join(nm, k);
      if (isSymlink(p)) {
        try {
          fsSync.rmSync(p, { force: true });
          if (!removedLinks.includes(k)) removedLinks.push(k);
          if (k.startsWith("@")) {
            const scopeDir = join(nm, k.split("/")[0]!);
            try {
              if (fsSync.readdirSync(scopeDir).length === 0) fsSync.rmSync(scopeDir, { force: true });
            } catch {}
          }
        } catch {}
      }
      if (lockRaw.plugins && (lockRaw.plugins as Record<string, unknown>)[k]) {
        delete (lockRaw.plugins as Record<string, unknown>)[k];
        if (!removedLocks.includes(k)) removedLocks.push(k);
      }
      if (lockRaw.settings && (lockRaw.settings as Record<string, unknown>)[k]) delete (lockRaw.settings as Record<string, unknown>)[k];
    }
  }

  for (const cand of candidates) {
    const p = join(nm, cand);
    if (!isSymlink(p)) continue;
    const hasLock = !!(lockRaw.plugins && (lockRaw.plugins as Record<string, unknown>)[cand]);
    if (hasLock) continue;
    const pkgName = getPkgName(cand);
    if (pkgName === CURRENT || pkgName === "@zhu/omp-vcc" || pkgName === "@zhulinchng/omp-vcc") {
      try {
        fsSync.rmSync(p, { force: true });
        if (!removedLinks.includes(cand)) removedLinks.push(cand);
        if (cand.startsWith("@")) {
          const scopeDir = join(nm, cand.split("/")[0]!);
          try {
            if (fsSync.readdirSync(scopeDir).length === 0) fsSync.rmSync(scopeDir, { force: true });
          } catch {}
        }
      } catch {}
    }
  }

  if (removedLocks.length > 0 || removedLinks.length > 0) {
    try {
      fsSync.writeFileSync(lockPath, JSON.stringify(lockRaw, null, 2));
    } catch {}
    return `migrated locks:${removedLocks.join(",") || "none"} links:${removedLinks.join(",") || "none"}`;
  }
  return "no-stale";
}
