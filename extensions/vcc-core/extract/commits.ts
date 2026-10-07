// @ts-nocheck
import type { NormalizedBlock } from "../types";
import { heredocCloseIndex } from "../core/brief";

interface CommitInfo {
  hash?: string;
  message: string;
}

// `-m` may sit inside a short-flag cluster (`-am`), be spelled `--message`, and
// hug its message (`-m"msg"`); the message may be double-quoted, single-quoted,
// ANSI-C quoted (`$'...'`), or bare. The whitespace anchor before the flag is
// what stops a longer flag that merely ends in `m` (e.g. `--amend`) from being
// misread as `-am`.
//
// Anchored at a command position (`^`, `;`, `&&`, `|`, optionally after sudo) so
// QUOTED text cannot claim a commit: the previous unanchored form matched
// `echo "git commit -m wip"` and every `git commit -m ...` line inside a heredoc
// body. `m` makes `^` line-anchored, so multi-line scripts still match. `g`
// (with matchAll) itemises EVERY commit of `a && b` instead of only the first.
const COMMIT_CMD_RE = /(?:^|[;&|]\s*)(?:sudo\s+)?git\b[^\n;&|]*?\scommit\b[^\n]*?\s(?:-[A-Za-z]*m|--message)[\s=]*(?:"((?:[^"\\]|\\.)*)"|\$?'((?:[^'\\]|\\.)*)'|(\S+))/gm;
// Cheap early-out for the anchored scan above (it also accepts `git -c k=v commit`).
const COMMIT_HINT_RE = /git\b[^\n;&|]*?\scommit\b/;
// Git abbreviates to 7+ hex by default but prints the full 40-char SHA when
// core.abbrev is raised, so allow the whole range.
const HASH_RE = /\b([0-9a-f]{7,40})\b/;
const BRACKET_HASH_RE = /\[\S+\s+([0-9a-f]{7,40})\]/;
const RANGE_HASH_RE = /\b([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\b/;

/**
 * Command lines that actually execute: a heredoc BODY (and its terminator) is
 * data being written, not commands being run, so `cat > NOTES.md <<'EOF' …
 * git commit -m "wip" … EOF` must not report a commit.
 */
const executableText = (command: string): string => {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const close = heredocCloseIndex(lines, i);
    if (close !== -1) i = close;
  }
  return kept.join("\n");
};

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
 * Extract a commit hash from git commit output. The order is load-bearing and
 * duplicated verbatim at both call sites otherwise: `[branch <hash>] msg` and
 * `<a>..<b>` must win over a bare hex word, because a message line can contain
 * an unrelated 7-hex token.
 */
const matchHash = (text: string): string | undefined => {
  const bracket = text.match(BRACKET_HASH_RE);
  if (bracket) return bracket[1];
  const range = text.match(RANGE_HASH_RE);
  if (range) return range[2];
  const plain = text.match(HASH_RE);
  // A BARE hex-looking word only counts as a hash when it contains a letter:
  // `wrote 12345678 bytes` is decimal prose, and [0-9a-f]{7,40} matched it. The
  // bracket/range forms are structural (`[main <sha>]`, `<a>..<b>`) and stay
  // trusted as-is — ~4% of 7-char abbreviations are all digits.
  return plain && /[a-f]/.test(plain[1]) ? plain[1] : undefined;
};

/**
 * Extract git commits from bash tool calls (`git commit -m "..."`) and pair
 * with hash from the immediately following tool_result.
 */
export const extractCommits = (blocks: NormalizedBlock[]): CommitInfo[] => {
  const commits: CommitInfo[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // Two independent gaps used to lose every commit: the name compare was
    // case-SENSITIVE although hosts differ on casing (omp sends `Bash`), and
    // `kind: "bash"` blocks — what normalize produces for the host's
    // bashExecution role — were never inspected at all.
    let cmd = "";
    let resultText: string | undefined;
    if (b.kind === "bash") {
      cmd = typeof b.command === "string" ? b.command : "";
      resultText = typeof b.output === "string" ? b.output : "";
    } else if (b.kind === "tool_call" && sameTool(b.name, "bash")) {
      cmd = typeof b.args.command === "string" ? b.args.command : "";
    } else {
      continue;
    }
    const executable = executableText(cmd);
    if (!COMMIT_HINT_RE.test(executable)) continue;
    const matches = [...executable.matchAll(COMMIT_CMD_RE)];
    if (matches.length === 0) continue;

    let hash: string | undefined;
    if (resultText !== undefined) {
      // A `bash` block already carries the command's output, so the hash is in
      // THIS block — there is no paired tool_result to look ahead for.
      hash = matchHash(resultText);
    } else {
      // Look at the next tool_result for the hash. It must come from the SAME
      // tool: a parallel batch interleaves other tools' results, and taking the
      // first hex-looking word from any of them reported an unrelated commit hash.
      for (let j = i + 1; j < Math.min(blocks.length, i + 3); j++) {
        const r = blocks[j];
        if (r.kind !== "tool_result" || !sameTool(r.name, b.name)) continue;
        hash = matchHash(r.text);
        if (hash) break;
      }
    }

    // One entry per commit: `git commit -m a && git commit -m b` is two commits,
    // and the old single `String.match` kept only the first. Dedup by message+hash.
    for (const m of matches) {
      const message = firstLineOf(cleanMessage(m[1] ?? m[2] ?? m[3] ?? ""));
      if (!message) continue;
      const key = `${hash ?? ""}::${message}`;
      if (!commits.some((c) => `${c.hash ?? ""}::${c.message}` === key)) {
        commits.push({ hash, message });
      }
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
