// @ts-nocheck
import type { NormalizedBlock } from "../types";

interface CommitInfo {
  hash?: string;
  message: string;
}

// `-m` may sit inside a short-flag cluster (`-am`), be spelled `--message`, and
// hug its message (`-m"msg"`); the message may be double-quoted, single-quoted,
// ANSI-C quoted (`$'...'`), or bare. The whitespace anchor before the flag is
// what stops a longer flag that merely ends in `m` (e.g. `--amend`) from being
// misread as `-am`.
const COMMIT_MSG_RE = /git\s+commit[^\n]*?\s(?:-[A-Za-z]*m|--message)[\s=]*(?:"((?:[^"\\]|\\.)*)"|\$?'((?:[^'\\]|\\.)*)'|(\S+))/;
// Git abbreviates to 7+ hex by default but prints the full 40-char SHA when
// core.abbrev is raised, so allow the whole range.
const HASH_RE = /\b([0-9a-f]{7,40})\b/;
const BRACKET_HASH_RE = /\[\S+\s+([0-9a-f]{7,40})\]/;
const RANGE_HASH_RE = /\b([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\b/;

const firstLineOf = (text: string): string => {
  const line = text.split(/\\n|\n/)[0] ?? "";
  return line.trim();
};

const cleanMessage = (msg: string): string =>
  msg.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();

/** Tool names are compared case-insensitively: hosts differ on casing. */
const sameTool = (a: string | undefined, b: string | undefined): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Extract git commits from bash tool calls (`git commit -m "..."`) and pair
 * with hash from the immediately following tool_result.
 */
export const extractCommits = (blocks: NormalizedBlock[]): CommitInfo[] => {
  const commits: CommitInfo[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "tool_call" || b.name !== "bash") continue;
    const cmd = typeof b.args.command === "string" ? b.args.command : "";
    if (!/\bgit\s+commit\b/.test(cmd)) continue;
    const m = cmd.match(COMMIT_MSG_RE);
    if (!m) continue;
    const message = firstLineOf(cleanMessage(m[1] ?? m[2] ?? m[3] ?? ""));
    if (!message) continue;

    let hash: string | undefined;
    // Look at the next tool_result for the hash. It must come from the SAME
    // tool: a parallel batch interleaves other tools' results, and taking the
    // first hex-looking word from any of them reported an unrelated commit hash.
    for (let j = i + 1; j < Math.min(blocks.length, i + 3); j++) {
      const r = blocks[j];
      if (r.kind !== "tool_result" || !sameTool(r.name, b.name)) continue;
      // Common git commit output: `[branch <hash>] message` or `<branch> <hash>..<hash>`
      const bracket = r.text.match(BRACKET_HASH_RE);
      if (bracket) { hash = bracket[1]; break; }
      const range = r.text.match(RANGE_HASH_RE);
      if (range) { hash = range[2]; break; }
      const plain = r.text.match(HASH_RE);
      if (plain) { hash = plain[1]; break; }
    }

    // Dedup by message+hash
    const key = `${hash ?? ""}::${message}`;
    if (!commits.some((c) => `${c.hash ?? ""}::${c.message}` === key)) {
      commits.push({ hash, message });
    }
  }

  return commits;
};

export const formatCommits = (commits: CommitInfo[], limit = 8): string[] => {
  const lines: string[] = [];
  const items = commits.slice(-limit); // keep most recent
  for (const c of items) {
    const prefix = c.hash ? `${c.hash}: ` : "";
    lines.push(`${prefix}${c.message}`);
  }
  return lines;
};
