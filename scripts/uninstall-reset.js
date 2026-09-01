#!/usr/bin/env node
/**
 * postuninstall hook: reset ownership marker if this plugin owned global state.
 * Generic postuninstall reset for ownership marker
 * Marker: ~/.config/@zhu/omp-vcc/.ownership.json with { state: "owned", previous: boolean }
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function resetOwnedQuiet(home) {
  const markerPath = join(home, ".config", "@zhu/omp-vcc", ".ownership.json");
  const configPath = join(home, ".omp", "agent", "config.yml");
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return "no-marker";
  }
  const clearMarker = () => { try { rmSync(markerPath, { force: true }); } catch {} };
  if (marker?.state !== "owned") {
    clearMarker();
    return "not-owned";
  }
  let content;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
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
      return "write-failed";
    }
  }
  clearMarker();
  return changed ? "restored" : "already-default";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = resetOwnedQuiet(homedir());
  console.log(`uninstall-reset: ${result}`);
}
