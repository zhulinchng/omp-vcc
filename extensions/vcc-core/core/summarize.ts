// @ts-nocheck
import type { Message } from "@oh-my-pi/pi-ai";
import type { FileOps } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { formatSummary, capBrief, BRIEF_MAX_LINES, RECALL_NOTE, wrapLongLines } from "./format";
import { selectRankedBriefBlocks, type BriefRankingOptions } from "./rank";
import { renderFileCategoryLines } from "../extract/files";

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  fileOps?: FileOps;
}

export interface RankedCompileInput extends CompileInput {
  ranking?: BriefRankingOptions;
}

const HEADER_NAMES = ["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"];

const SEPARATOR = "\n\n---\n\n";

/** Extract a named section from summary text */
const sectionOf = (text: string, header: string): string => {
  const tag = `[${header}]`;
  // Scope to the headers region (before the first separator) and match the
  // tag only at a line start: value lines may contain literal "[Tags]"
  // mid-line and the brief transcript may contain ghost tags at line starts.
  const head = text.split(SEPARATOR)[0];
  const startMatch = new RegExp(`(^|\\n)${escapeRegExp(tag)}`).exec(head);
  if (!startMatch) return "";
  const start = startMatch.index + startMatch[1].length;
  const after = head.slice(start);
  // Find next section header (line-anchored) as the end boundary.
  const nextSection = HEADER_NAMES
    .filter((h) => h !== header)
    .map((h) => new RegExp(`\\n${escapeRegExp(`[${h}]`)}`).exec(after))
    .filter((m) => m && m.index > 0)
    .map((m) => m.index);
  const end = nextSection.sort((a, b) => a - b)[0];
  return (end ? after.slice(0, end) : after).trim();
};

/** Extract the brief transcript part (everything after ---) */
const briefOf = (text: string): string => {
  const idx = text.indexOf(SEPARATOR);
  if (idx >= 0) return text.slice(idx + SEPARATOR.length).trim();
  // No separator: a stripped headerless summary is all brief, while a lone
  // headers block (starts with a known tag) has no brief.
  const tagPattern = new RegExp(`^\\[(${HEADER_NAMES.map(escapeRegExp).join("|")})\\]`);
  if (tagPattern.test(text.trimStart())) return "";
  return text.trim();
};

/** Rejoin wrapLongLines continuations (indented followers) before line-level
 * merging, so wrapped value lines survive whole. Backslash-marked hard breaks
 * rejoin without a space, normal breaks with one. */
const joinContinuations = (text: string): string[] => {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (out.length > 0 && /^\s+\S/.test(line)) {
      const cont = line.trim();
      const prev = out[out.length - 1];
      out[out.length - 1] = prev.endsWith("\\") ? prev.slice(0, -1) + cont : `${prev} ${cont}`;
    } else {
      out.push(line);
    }
  }
  return out;
};

/** Merge a header section */
const mergeHeaderSection = (header: string, prev: string, fresh: string): string => {
  // Outstanding Context is volatile -- always use fresh only
  if (header === "Outstanding Context") return fresh;

  // Files And Changes: merge by category (Modified/Created/Read), dedup paths.
  // Always rendered through mergeFileLines (even one-sided) so stale bare
  // "(+N more)" counts from legacy summaries are dropped and the display
  // form stays canonical across cycles.
  if (header === "Files And Changes") {
    if (!prev) return fresh;
    return mergeFileLines(prev, fresh);
  }

  if (!prev) return fresh;
  if (!fresh) return prev;

  // Session Goal, User Preferences: line-level dedup, cap
  const isClean = (l: string) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
  const prevLines = joinContinuations(prev).filter(isClean);
  const freshLines = joinContinuations(fresh).filter(isClean);
  const combined = [...new Set([...prevLines, ...freshLines])];
  const CAP = header === "Session Goal" ? 8 : header === "Commits" ? 8 : 15;
  const capped = combined.length > CAP ? combined.slice(-CAP) : combined;
  if (capped.length === 0) return "";
  return `[${header}]\n${capped.join("\n")}`;
};
const mergeFileLines = (prev: string, fresh: string): string => {
  const categories = ["Modified", "Created", "Read"] as const;
  const merged: Record<string, Set<string>> = {};
  for (const cat of categories) merged[cat] = new Set();

  // Parse three line forms from both prev and fresh:
  //   "- Modified: a, b"                        (bare; legacy relative kept verbatim)
  //   "- Modified (in /prefix/): a, b"          (prefix-collapsed display)
  //   "- Modified (+2 more under /d/): b1, b2"  (grouped overflow; dir may be "")
  // formatSummary wraps long lines at 120 cols with an indented continuation:
  // normal breaks rejoin with a space, backslash-marked mid-token breaks
  // rejoin without one. A bare "(+N more)" line/suffix carries no names and
  // is ignored (legacy counts were lossy by design).
  const addPaths = (cat: string, prefix: string, rest: string) => {
    const clean = rest.replace(/\s*\(\+\d+ more\)\s*$/, "");
    for (const p of clean.split(",")) {
      const trimmed = p.trim();
      if (trimmed) merged[cat].add(prefix + trimmed);
    }
  };
  const parseHead = (cat: string, tail: string): { prefix: string; rest: string } | null => {
    if (tail.startsWith(": ")) return { prefix: "", rest: tail.slice(2) };
    if (tail.startsWith(" (in ")) {
      const end = tail.indexOf("): ");
      if (end > 0) return { prefix: tail.slice(5, end), rest: tail.slice(end + 3) };
      return null;
    }
    const grouped = /^ \(\+(\d+) more( under (.+?))?\): (.*)$/.exec(tail);
    if (grouped) {
      const dir = grouped[3] ?? "";
      return { prefix: dir && !dir.endsWith("/") ? `${dir}/` : dir, rest: grouped[4] };
    }
    return null;
  };
  for (const text of [prev, fresh]) {
    let current: { cat: string; prefix: string; rest: string } | null = null;
    const flush = () => {
      if (current) {
        addPaths(current.cat, current.prefix, current.rest);
        current = null;
      }
    };
    for (const line of text.split("\n")) {
      const head = /^- (Modified|Created|Read)(.*)$/.exec(line);
      // "- Modified" without one of the three tails is a bare count or
      // malformed: flush any pending accumulation and ignore.
      if (head && (categories as readonly string[]).includes(head[1])) {
        flush();
        const parsed = parseHead(head[1], head[2]);
        if (parsed) current = { cat: head[1], prefix: parsed.prefix, rest: parsed.rest };
        continue;
      }
      if (current && /^\s+\S/.test(line)) {
        const cont = line.trim();
        if (current.rest.endsWith("\\")) current.rest = current.rest.slice(0, -1) + cont;
        else current.rest += " " + cont;
      } else {
        flush();
      }
    }
    flush();
  }

  // Dedup: if already in Modified, drop from Created (file existed before)
  for (const p of merged.Modified) merged.Created.delete(p);

  // Display shares the fresh path's renderer (flat + grouped overflow +
  // honest bare count). Prefix derivation is display-only: the merged set
  // always holds full paths, so form flips never corrupt.
  const lines: string[] = [];
  for (const cat of categories) {
    if (merged[cat].size === 0) continue;
    for (const line of renderFileCategoryLines(cat, [...merged[cat]])) {
      lines.push(`- ${line}`);
    }
  }
  if (lines.length === 0) return "";
  return `[Files And Changes]\n${lines.join("\n")}`;
};

const mergeBriefTranscript = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return prev;
  return prev + "\n\n" + fresh;
};

const briefLineCount = (text: string): number =>
  text ? text.split("\n").length : 0;

const capBriefToLineBudget = (text: string, maxLines: number): string => {
  if (!text || maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(-maxLines);
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  const omitted = lines.length - clean.length;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

const mergeBriefTranscriptWithFreshBudget = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return capBrief(prev);
  const freshLines = briefLineCount(fresh);
  const remainingPrevLines = Math.max(0, BRIEF_MAX_LINES - freshLines);
  const prevTail = capBriefToLineBudget(prev, remainingPrevLines);
  return prevTail ? `${prevTail}\n\n${fresh}` : fresh;
};

const mergePrevious = (prev: string, fresh: string, options: { preserveFreshBrief?: boolean } = {}): string => {
  // Merge header sections
  const headers = HEADER_NAMES
    .map((header) => {
      const freshSec = sectionOf(fresh, header);
      const prevSec = sectionOf(prev, header);
      return mergeHeaderSection(header, prevSec, freshSec);
    })
    .filter(Boolean);

  // Merge brief transcript
  const prevBrief = briefOf(prev);
  const freshBrief = briefOf(fresh);
  const mergedBrief = options.preserveFreshBrief
    ? mergeBriefTranscriptWithFreshBudget(prevBrief, freshBrief)
    : mergeBriefTranscript(prevBrief, freshBrief);

  const parts: string[] = [];
  if (headers.length > 0) {
    parts.push(headers.join("\n\n"));
  }
  if (mergedBrief) {
    parts.push(options.preserveFreshBrief ? mergedBrief : capBrief(mergedBrief));
  }

  return parts.join(SEPARATOR);
};

interface CompileWithBriefBlocksOptions {
  briefBlocksFor?: (blocks: ReturnType<typeof normalize>) => ReturnType<typeof normalize>;
  capFreshBrief?: boolean;
  preserveFreshBriefOnMerge?: boolean;
}

const compileWithBriefBlocks = (input: CompileInput, options: CompileWithBriefBlocksOptions = {}): string => {
  const blocks = filterNoise(normalize(input.messages));
  const briefBlocks = options.briefBlocksFor?.(blocks);
  const data = buildSections({ blocks, briefBlocks, fileOps: input.fileOps });
  const fresh = formatSummary(data, { capBriefTranscript: options.capFreshBrief ?? true });
  // Strip any legacy RECALL_NOTE baked into prev summary (pre-fix format)
  // so merge doesn't re-stack it inside the brief.
  const prev = input.previousSummary
    ? stripRecallNote(input.previousSummary)
    : undefined;
  const merged = prev ? mergePrevious(prev, fresh, { preserveFreshBrief: options.preserveFreshBriefOnMerge }) : fresh;
  if (!merged) return "";
  return wrapLongLines(merged) + SEPARATOR + RECALL_NOTE;
};

export const compile = (input: CompileInput): string =>
  compileWithBriefBlocks(input);

export const compileRanked = (input: RankedCompileInput): string =>
  compileWithBriefBlocks(input, {
    briefBlocksFor: (blocks) => selectRankedBriefBlocks(blocks, {
      ...input.ranking,
      fileOps: input.ranking?.fileOps ?? input.fileOps,
    }),
    capFreshBrief: false,
    preserveFreshBriefOnMerge: true,
  });

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RECALL_NOTE_PATTERN = new RegExp(RECALL_NOTE.split(" ").map(escapeRegExp).join("\\s+"));

const stripRecallNote = (text: string): string => {
  // Remove trailing RECALL_NOTE (and any separators surrounding it) if present.
  // Whitespace-insensitive: matches the current single-line format, a bare
  // trailing note, and legacy copies wrapped mid-sentence by wrapLongLines.
  const match = RECALL_NOTE_PATTERN.exec(text);
  if (!match || match.index < 0) return text;
  return text.slice(0, match.index).replace(/\s*(?:\n\n---\n\n)?\s*$/, "").trimEnd();
};
