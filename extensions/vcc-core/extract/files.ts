// @ts-nocheck
import type { FileOps, NormalizedBlock } from "../types";
import { extractPath } from "../core/tool-args";

interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
}

// Tool names are matched case-insensitively (see `matches`), mirroring the /i
// regexes in core/rank.ts. Entries must be lowercase.
const FILE_READ_TOOLS = new Set([
  "read", "read_file", "view",
]);

// Multi-file patch tools (apply_patch) carry their paths inside the diff payload,
// not in a path arg, so extractPath yields nothing for them; those files are
// recovered from the hook-provided fileOps below.
const FILE_WRITE_TOOLS = new Set([
  "edit", "write", "edit_file", "write_file",
  "multiedit", "quick_edit", "target_edit", "apply_patch",
]);

const FILE_CREATE_TOOLS = new Set([
  "write", "write_file",
]);

const matches = (tools: Set<string>, name: string): boolean => tools.has(name.toLowerCase());

/**
 * Find the longest common directory prefix among absolute paths.
 * Returns "" if fewer than 2 absolute paths or no meaningful common prefix.
 * Shared with core/summarize.ts, which re-derives one prefix per merge so
 * prev-cycle and fresh paths keep a consistent display form.
 */
export const longestCommonDirPrefix = (paths: string[]): string => {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return ""; // require at least /a/b common
  return split[0].slice(0, i).join("/") + "/";
};

export const extractFiles = (
  blocks: NormalizedBlock[],
  fileOps?: FileOps,
): FileActivity => {
  const act: FileActivity = {
    read: new Set(fileOps?.readFiles ?? []),
    modified: new Set(fileOps?.modifiedFiles ?? []),
    created: new Set(fileOps?.createdFiles ?? []),
  };

  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const p = extractPath(b.args);
    if (!p) continue;

    if (matches(FILE_READ_TOOLS, b.name)) act.read.add(p);
    if (matches(FILE_WRITE_TOOLS, b.name)) act.modified.add(p);
    if (matches(FILE_CREATE_TOOLS, b.name)) act.created.add(p);
  }

  // Full paths are carried verbatim: per-cycle prefix trimming made prev-cycle
  // and fresh paths unresolvable when mixed. Display collapse happens in
  // renderFileCategoryLines below, re-derived every render for consistency.
  return act;
};

/** Exact file paths shown flat per category; further named paths spill into
 * per-directory overflow groups up to FILE_CATEGORY_TOTAL_CAP. */
export const FILE_CATEGORY_DISPLAY_CAP = 20;
/** Max NAMED file paths per category (flat + grouped overflow). Past this,
 * excess degrades to a bare honest (+N more) count. */
export const FILE_CATEGORY_TOTAL_CAP = 100;

/**
 * Render one Files-And-Changes category (lines WITHOUT the "- " bullet;
 * callers add it or route through section()). Shared by the fresh path
 * (build-sections) and the merge path (mergeFileLines) so both carry the
 * same lossless overflow forms:
 *   `Modified: a, b` / `Modified (in /prefix/): a, b` (flat, prefix-collapsed)
 *   `Modified (+2 more under /d/): b1, b2`            (grouped overflow)
 *   `Modified (+5 more)`                              (honest bare count)
 */
export const renderFileCategoryLines = (cat: string, paths: string[]): string[] => {
  if (paths.length === 0) return [];
  const prefix = longestCommonDirPrefix(paths);
  const strip = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const flat = paths.slice(0, FILE_CATEGORY_DISPLAY_CAP).map(strip);
  const lines = [prefix ? `${cat} (in ${prefix}): ${flat.join(", ")}` : `${cat}: ${flat.join(", ")}`];
  const overflow = paths.slice(FILE_CATEGORY_DISPLAY_CAP, FILE_CATEGORY_TOTAL_CAP);
  const groups = new Map<string, string[]>();
  for (const p of overflow) {
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
    const base = dir ? p.slice(dir.length) : p;
    const list = groups.get(dir) ?? [];
    list.push(base);
    groups.set(dir, list);
  }
  for (const [dir, bases] of groups) {
    lines.push(`${cat} (+${bases.length} more${dir ? ` under ${dir}` : ""}): ${bases.join(", ")}`);
  }
  const dropped = paths.length - FILE_CATEGORY_DISPLAY_CAP - overflow.length;
  if (dropped > 0) lines.push(`${cat} (+${dropped} more)`);
  return lines;
};
