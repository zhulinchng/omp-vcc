#!/usr/bin/env node
/**
 * postuninstall hook: reset ownership marker if this plugin owned global state.
 * Marker: ~/.config/@zhulinchng/omp-vcc/.ownership.json with { state: "owned", previous: boolean }
 * When the plugin set `startup.quiet: true` in the global config, restore to previous.
 * No-op when marker missing or not owned. Safe to run repeatedly.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function resetOwnedQuiet(home) {
  const baseHome = home || homedir();
  const markerPath = join(
    baseHome,
    ".config",
    "@zhulinchng/omp-vcc",
    ".ownership.json",
  );
  // try user-level configs in priority order (agent subdir first, then root)
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
      // still clear marker even if write fails — avoid stale ownership
      clearMarker();
      return "write-failed";
    }
  }

  clearMarker();
  return changed ? "restored" : "already-default";
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
    const result = resetOwnedQuiet(homedir());
    console.log(`uninstall-reset: ${result}`);
  } catch (err) {
    // never fail postuninstall — log and exit 0
    console.log(`uninstall-reset: error ${err?.message ?? err}`);
  }
}
