// @ts-nocheck
import type { Message } from "@oh-my-pi/pi-ai";
import type { RenderedEntry } from "./render-entries";
import { textOf, thinkingOf, isContentBearing, extractToolCallText, extractToolCallArgsText, clip } from "./content";
import { scoreToProbability, estimateLikelihoodParams } from "./bayesian-probability.ts";

export interface SearchHit extends RenderedEntry {
  /** Context snippet around the first matched term (only when query provided) */
  snippet?: string;
  /** Number of query terms matched (for ranking) */
  matchCount?: number;
  /** Calibrated P(relevance) from the Bayesian transform (BM25 path only) */
  probability?: number;
}

/**
 * Result of a search, with enough metadata for a caller to report truncation
 * honestly (see `searchEntriesDetailed`). `searchEntries` stays `SearchHit[]`
 * for existing call sites that only need the hits themselves.
 */
export interface SearchResult {
  hits: SearchHit[];
  /** Genuine matches found before the hard cap was applied (after any
   *  posterior-gate noise filtering). May exceed `hits.length`. */
  totalBeforeCap: number;
  /** True when the hard cap discarded matches (`totalBeforeCap > hits.length`). */
  truncated: boolean;
}
/** A file touched in one entry — used by mode:touched aggregation. */
export interface FileTouch {
  index: number;
  toolName: string;
}

/** Aggregated view of a file touched across multiple entries. */
export interface TouchedFile {
  path: string;
  entries: FileTouch[];
}
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quantifier starting at `i`, if any. Only unbounded forms (+, *, {n,}) can
 *  drive catastrophic backtracking. */
const quantifierAt = (p: string, i: number): { len: number; unbounded: boolean } => {
  const c = p[i];
  if (c === "+" || c === "*") return { len: 1, unbounded: true };
  if (c === "{") {
    const end = p.indexOf("}", i);
    const body = end === -1 ? "" : p.slice(i + 1, end);
    if (/^\d+(,\d*)?$/.test(body)) return { len: end - i + 1, unbounded: body.endsWith(",") };
  }
  return { len: 0, unbounded: false };
};

/**
 * Detect an unbounded quantifier applied to a group that already contains one,
 * e.g. `(a+)+` or `(\w*)*`. That shape makes the engine explore exponentially
 * many splits on a non-matching input. Alternation overlap like `(a|a)+` is not
 * covered here; the search budget in `searchEntries` is the backstop.
 */
const hasNestedQuantifier = (pattern: string): boolean => {
  const groups: boolean[] = []; // per open group: contains an unbounded quantifier
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") { groups.push(false); continue; }
    if (c === ")") {
      const inner = groups.pop() ?? false;
      const q = quantifierAt(pattern, i + 1);
      if (inner && q.unbounded) return true;
      if (groups.length) groups[groups.length - 1] ||= inner || q.unbounded;
      i += q.len;
      continue;
    }
    const q = quantifierAt(pattern, i);
    if (q.unbounded && groups.length) {
      groups[groups.length - 1] = true;
      i += q.len - 1;
    }
  }
  return false;
};

/** Try to compile as regex; fall back to escaped literal. Patterns with nested
 *  unbounded quantifiers are treated as literals rather than compiled. */
const safeRegex = (pattern: string): RegExp => {
  if (hasNestedQuantifier(pattern)) return new RegExp(escapeRegex(pattern), "i");
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};

/**
 * Wall-clock budget for one search. A normal query over 400 entries takes ~10ms,
 * so this only trips on pathological patterns that survive `hasNestedQuantifier`.
 * Aborting loudly beats returning a silently truncated match count.
 *
 * This is a per-entry checkpoint, not a hard per-call ceiling: JavaScript cannot
 * interrupt a running `RegExp.test`, so a single pathological entry still runs to
 * completion and the overshoot is caught on the next iteration. That bounds the
 * damage to one entry instead of the whole corpus, which is the point — the
 * unbounded case was N entries multiplied by the per-entry cost.
 */
const SEARCH_BUDGET_MS = 3000;

const startBudget = (): (() => void) => {
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  return () => {
    if (Date.now() > deadline) {
      throw new Error(
        `Search aborted: query exceeded ${SEARCH_BUDGET_MS}ms. Simplify the pattern — ` +
        "nested quantifiers such as (a+)+ can make matching blow up.",
      );
    }
  };
};

/** Detect if the query looks like a single regex pattern (contains regex metacharacters). */
const looksLikeRegex = (query: string): boolean =>
  /[|*+?{}()[\]\\^$.]/.test(query);

/** Build a regex for snippet highlighting — matches first available term. */
const snippetRegex = (terms: string[]): RegExp => {
  const alts = terms.map((t) => safeRegex(t).source);
  return new RegExp(alts.join("|"), "i");
};

// ── Stopwords for natural language queries ──
const STOPWORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "of", "in", "to", "for",
  "with", "on", "at", "from", "by", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "about", "it", "its", "that",
  "this", "what", "which", "who", "whom", "these", "those",
]);

/** Remove stopwords, keep meaningful terms. */
const filterStopwords = (terms: string[]): string[] => {
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
  // If all terms were stopwords, return original (don't lose everything)
  return meaningful.length > 0 ? meaningful : terms;
};

/** Count how many distinct terms match the haystack. */
const countMatches = (hay: string, terms: string[]): number => {
  let count = 0;
  for (const t of terms) {
    if (safeRegex(t).test(hay)) count++;
  }
  return count;
};

// ── BM25-lite scoring ──
const BM25_K = 1.2;
const BM25_B = 0.75;

/** Count occurrences of a regex pattern in text. */
const termFreq = (text: string, pattern: RegExp): number => {
  const matches = text.match(new RegExp(pattern.source, "gi"));
  return matches ? matches.length : 0;
};

interface BM25Context {
  n: number;         // total docs
  avgDl: number;     // average doc length (words)
  df: Map<string, number>; // term -> number of docs containing it
}

/** Precompute IDF and avgDl across all docs. */
const buildBM25Context = (docs: string[], terms: string[], checkBudget: () => void): BM25Context => {
  const n = docs.length;
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const doc of docs) {
    checkBudget();
    totalLen += doc.split(/\s+/).length;
    for (const t of terms) {
      if (safeRegex(t).test(doc)) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }

  return { n, avgDl: totalLen / Math.max(n, 1), df };
};

/** BM25 score for a single doc against query terms, plus the calibration
 *  inputs the Bayesian posterior needs: total term frequency across terms,
 *  distinct normalized matched terms (coverage parity), and the doc-length
 *  ratio. Same pass — no re-scanning. */
const bm25Score = (doc: string, terms: string[], ctx: BM25Context): { score: number; tf: number; distinctTerms: number; docLenRatio: number } => {
  const dl = doc.split(/\s+/).length;
  let score = 0;
  let totalTf = 0;
  const seenTerms = new Set<string>();

  for (const t of terms) {
    const termTf = termFreq(doc, safeRegex(t));
    if (termTf === 0) continue;
    totalTf += termTf;
    seenTerms.add(t.toLowerCase());

    const docFreq = ctx.df.get(t) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((ctx.n - docFreq + 0.5) / (docFreq + 0.5) + 1);
    const tfNorm = (termTf * (BM25_K + 1)) / (termTf + BM25_K * (1 - BM25_B + BM25_B * dl / ctx.avgDl));
    score += idf * tfNorm;
  }

  return { score, tf: totalTf, distinctTerms: seenTerms.size, docLenRatio: ctx.avgDl > 0 ? dl / ctx.avgDl : 1 };
};

/** Line-based snippet: ±contextLines around first regex match. */
const lineSnippet = (text: string, regex: RegExp, contextLines = 2): string | undefined => {
  const lines = text.split("\n");
  let matchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) return undefined;

  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end);

  const parts: string[] = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  parts.push(...slice);
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return parts.join("\n");
};

/**
 * Aggregate character budget for ALL toolCall arguments appended to one
 * message's searchable text — a single shared budget across every toolCall
 * in the message, not per call, so N toolCalls can't multiply the bound and
 * make one message's contribution to the BM25 doc corpus unbounded.
 *
 * Head-only cap: content past this budget is not indexed via toolCall
 * arguments at all. This is an honest tradeoff, not a proxy for full
 * coverage — a Write/Edit tool result commonly only acknowledges success
 * (e.g. "wrote 400 lines"), so a fact buried past the cap in a giant
 * argument is not guaranteed to be searchable elsewhere either.
 */
const TOOL_ARGS_BUDGET = 2000;

/**
 * Tool name of the recall tool itself (src/tools/recall.ts). A search
 * operation must not match its own query or its own prior output: the
 * vcc_recall invocation is persisted as an ordinary assistant toolCall (its
 * `{ query }` argument, excluded below in `toolCallArgsText`) followed by an
 * ordinary toolResult message (its `N matches for "<query>"` text, excluded
 * in `fullText`) — without both exclusions a repeated query keeps matching
 * its own prior invocation/output and the hit count grows on every search.
 * This is a targeted introspection invariant for one named tool, not a
 * general allowlist/blocklist over tool names or tool results.
 */
const RECALL_TOOL_NAME = "vcc_recall";

/** Text of every toolCall's arguments in a message's content, for search —
 *  bounded once, in aggregate, by TOOL_ARGS_BUDGET. Excludes the recall
 *  tool's own arguments (see RECALL_TOOL_NAME). */
const toolCallArgsText = (content: Message["content"]): string => {
  if (!content || typeof content === "string") return "";
  const raw = content
    .filter((part) => part.type === "toolCall")
    .filter((part) => part.name?.toLowerCase() !== RECALL_TOOL_NAME)
    .map((part) => extractToolCallArgsText(part.arguments))
    .filter(Boolean)
    .join("\n");
  return clip(raw, TOOL_ARGS_BUDGET);
};

/**
 * Build full searchable text for a message: text parts plus toolCall
 * arguments (bash command, Write/Edit content, etc.) so a match that only
 * exists in a tool call's arguments is still findable and its snippet is
 * derived from the same text.
 *
 * The recall tool's own toolResult is excluded (searchable text ""): it
 * echoes back `N matches for "<query>"` from the *previous* recall call, so
 * indexing it would make a repeated query self-match and grow with every
 * search. This only affects search indexing — browse/no-query returns
 * entries before fullText runs (see `searchEntries`), and #N expand reads
 * the message/entry directly, not through this function, so the toolResult
 * is still fully visible there.
 */
const fullText = (msg: Message): string => {
  if ((msg as any).role === "bashExecution") {
    return `${(msg as any).command ?? ""} ${(msg as any).output ?? ""}`;
  }
  if (msg.role === "toolResult" && msg.toolName?.toLowerCase() === RECALL_TOOL_NAME) {
    return "";
  }
  const text = textOf(msg.content);
  const thinking = thinkingOf(msg.content);
  const argsText = toolCallArgsText(msg.content);
  return [text, thinking, argsText].filter(Boolean).join("\n");
};

/**
 * Compute file indicators from a message, counting non-empty content lines
 * per content-bearing file call. Shape-based — no tool-name allowlist.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function getFileIndicators(msg: Message): { toolName: string; path: string; lineCount: number }[] {
  if (!msg?.content || typeof msg.content === "string") return [];
  const indicators: { toolName: string; path: string; lineCount: number }[] = [];
  for (const part of msg.content) {
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const args = part.arguments as Record<string, unknown>;
    if (!isContentBearing(args)) continue;
    const path = ["path", "filePath", "file_path", "file"]
      .map((k) => args[k])
      .find((v): v is string => typeof v === "string")!;
    const totalText = extractToolCallText(args);
    const nonEmpty = totalText.split("\n").filter((l) => l.trim().length > 0);
    indicators.push({
      toolName: part.name || "",
      path,
      lineCount: nonEmpty.length,
    });
  }
  return indicators;
}

/**
 * Aggregate file operations across all entries for mode:touched.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function getTouchedFiles(
  messages: Message[],
  rendered: RenderedEntry[],
): TouchedFile[] {
  const map = new Map<string, TouchedFile>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const indicators = getFileIndicators(msg);
    for (const fm of indicators) {
      const index = rendered[i]?.index ?? i;
      if (!map.has(fm.path)) {
        map.set(fm.path, { path: fm.path, entries: [] });
      }
      (map.get(fm.path) as TouchedFile).entries.push({ index, toolName: fm.toolName });
    }
  }
  return Array.from(map.values());
}

/**
 * Absolute Bayesian posterior floor for MULTI-TERM natural-language queries
 * only: after sorting by BM25 score, drop hits whose calibrated P(relevance)
 * is below this threshold. Absolute (not relative) because the posterior
 * already normalizes away corpus size and document length — that is the
 * point of the score→probability transform (`bayesian-probability.ts`).
 * Raw BM25 magnitudes vary across sessions, so no fixed score threshold
 * behaves consistently; posteriors are comparable, which is also what the
 * cross-session merge needs.
 *
 * Applied only when the query has >=2 DISTINCT effective terms after
 * stopword filtering and case/duplicate normalization (see the
 * `effectiveTermCount >= 2` gate `searchEntriesDetailed` uses before calling
 * `applyProbabilityFloor`). Distinct, not raw count: "auth auth" or
 * "Auth AUTH" is semantically a single-term query and must bypass the gate
 * like any other single term — repeating or casing a word doesn't turn it
 * into the multi-term OR-tail noise this gate targets. The normalization is
 * gate-only; it doesn't change `terms` or the BM25 scoring itself, which
 * already matches case-insensitively. For a genuine single term, every hit's
 * occurrence already satisfies the whole query — its BM25 score differences
 * reflect term frequency and document length, not multi-term OR-tail noise,
 * so filtering by it there risks real matches for no corresponding noise
 * reduction. (The bypass is structural, pinned by the single-term tests in
 * `tests/search-entries.test.ts`; a seeded bench of 540 trials against the
 * prior relative floor — old module resurrected from git, planted relevant
 * docs in OR-tail noise — confirmed 1.0 planted recall for both filters with
 * strictly less noise kept under the new gate, and top-1 == ungated in all
 * 540 trials. See `docs/bayesian-recall-gate.md` §Evidence.)
 *
 * The top-scoring hit always survives by construction:
 * `applyProbabilityFloor` keeps the first entry unconditionally, so a
 * non-empty scored[] can never be filtered to zero even if a tuning
 * override raises the threshold above the top hit's posterior. (Note
 * posterior(L, p) = p at L = 0.5, so a top likelihood >= 0.5 alone does
 * NOT imply posterior >= 0.5 — the unconditional keep-first is the real
 * guarantee, not the calibration.)
 *
 * Coverage parity is the second survival rule (see `applyProbabilityFloor`):
 * a doc matching as many distinct query terms as the best hit survives even
 * when its posterior sits below the cutoff. Without this, a uniformly good
 * result set — every doc matches every term, all posteriors lukewarm under
 * median-anchored calibration — would collapse to the top hit alone, worse
 * than the relative floor this gate replaces.
 */
const BAYESIAN_PROBABILITY_FLOOR = 0.5;

/**
 * Hard cap on total SEARCH results, applied to both the natural-language
 * (post-gate) and regex result paths so pagination stays bounded regardless
 * of how noisy or broad a query is.
 *
 * Evidence (same bench/corpora as the tail gate, gate disabled to
 * isolate the cap's effect; run 1 = 161 queries, run 2 = 222 queries):
 * uncapped result counts ranged up to 380 (median 32 / 29.5, p90 119 /
 * 115.9). cap=50 sits ABOVE the corpus's own median in both runs but BELOW
 * its p90 — it leaves the typical (median) query unclipped while still
 * bounding the long tail: only 46/161 (29%) and 66/222 (30%) of queries were
 * truncated by it, versus 90/161 (56%) and 124/222 (56%) for cap=25, which
 * would also clip plenty of unremarkable ~30-match queries well under what
 * "noisy" implies. cap=50 also bounds the worst case (380) down by 87%.
 * Those runs measured the prior relative floor (0.20 multi-term-only); the
 * cap applies post-gate either way, so the basis stands unchanged. Under the
 * new absolute gate a seeded 540-trial bench likewise shows 0 zero-hit
 * regressions and top-1 == ungated in all 540 trials.
 */
const SEARCH_RESULT_CAP = 50;
/**
 * Tuning overrides for `searchEntriesDetailed`. Exists only so targeted
 * tests can exercise the real scoring/capping pipeline against candidate
 * constants — production call sites (`searchEntries`, the recall tool)
 * never pass this and always get `BAYESIAN_PROBABILITY_FLOOR`/`SEARCH_RESULT_CAP`.
 */
export interface SearchTuning {
  probabilityFloor?: number;
  cap?: number;
}

/** Drop scored hits that are BOTH below the absolute posterior `floor` AND
 *  cover fewer distinct query terms than the best hit (`coverage < maxCoverage`).
 *  Either disjunct keeps a hit: high posterior (absolute relevance) or full
 *  query coverage — a doc matching every term is never OR-tail, even in a
 *  lukewarm homogeneous corpus where median-anchored calibration puts every
 *  posterior below the cutoff. The top hit (index 0, highest BM25 score)
 *  always passes unconditionally, so this can never turn a non-empty
 *  `scored` into an empty result. Sort stays by raw BM25 score, never by
 *  posterior: the composite prior varies per doc, so posterior order can
 *  differ from BM25 order, and rank assertions pin BM25 order. */
const applyProbabilityFloor = (
  scored: Array<{ hit: SearchHit; score: number; probability: number; distinctTerms: number }>,
  floor: number,
  maxCoverage: number,
): Array<{ hit: SearchHit; score: number; probability: number; distinctTerms: number }> => {
  if (scored.length === 0) return scored;
  return scored.filter((s, i) => i === 0 || s.probability >= floor || s.distinctTerms >= maxCoverage);
};

/**
 * Bound `hits` to `cap` entries, reporting the pre-cap count so callers can
 * signal truncation honestly instead of understating "total matches".
 *
 * Order preserved, never re-sorted: for the BM25 path that's already
 * highest-score-first, so `slice(0, cap)` keeps the top `cap` hits. For the
 * regex path there is no score — hits are collected in entry/chronological
 * iteration order, so `slice(0, cap)` keeps the OLDEST `cap` matches, not
 * the most recent or most relevant ones. That is an explicit, documented
 * preservation choice for this change, not a new selection/ranking policy —
 * changing which matches a truncated regex search keeps (e.g. newest-first)
 * is a separate decision, out of scope here.
 */
const capHits = (hits: SearchHit[], cap: number): SearchResult => {
  const totalBeforeCap = hits.length;
  const capped = totalBeforeCap > cap ? hits.slice(0, cap) : hits;
  return { hits: capped, totalBeforeCap, truncated: capped.length < totalBeforeCap };
};

/**
 * Full search with truncation metadata. `searchEntries` below is a thin
 * `.hits`-only wrapper kept for existing call sites; use this directly when
 * a caller (the recall tool) needs to report a capped result set honestly.
 */
export const searchEntriesDetailed = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
  tuning?: SearchTuning,
): SearchResult => {
  if (!query?.trim()) return { hits: entries, totalBeforeCap: entries.length, truncated: false };

  const probabilityFloor = tuning?.probabilityFloor ?? BAYESIAN_PROBABILITY_FLOOR;
  const cap = tuning?.cap ?? SEARCH_RESULT_CAP;
  const rawQuery = query.trim();
  const checkBudget = startBudget();

  // If the query looks like a single regex pattern (contains metacharacters),
  // treat the whole thing as one pattern — don't split into terms.
  //
  // The detection is deliberately loose, so ordinary prose trips it: a trailing
  // "?" or "." turns the whole sentence into one pattern that must match
  // verbatim. On real sessions that path returned nothing 47.5% of the time
  // versus 1.1% for term search. Mode detection must never silently lose
  // results, so an empty regex result falls through to term search below.
  //
  // No posterior-gate filtering here: regex matches are boolean (matched or
  // not), there's no probability to threshold. Only the hard cap applies.
  if (looksLikeRegex(rawQuery)) {
    const regex = safeRegex(rawQuery);
    const hits: SearchHit[] = [];
    for (let i = 0; i < entries.length; i++) {
      checkBudget();
      const e = entries[i];
      const msg = messages[i];
      const text = msg ? fullText(msg) : e.summary;
      const filePart = e.files?.join(" ") ?? "";
      const hay = `${e.role} ${text} ${filePart}`;
      if (regex.test(hay)) {
        const snip = lineSnippet(text, regex);
        hits.push({ ...e, snippet: snip, matchCount: 1 });
      }
    }
    if (hits.length > 0) return capHits(hits, cap);
  }

  // Natural language / multi-word query: BM25 scoring
  const rawTerms = rawQuery.split(/\s+/);
  const terms = filterStopwords(rawTerms);
  const snipRe = snippetRegex(terms);

  // Build all docs for BM25 context
  const docs: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = msg ? fullText(msg) : e.summary;
    const filePart = e.files?.join(" ") ?? "";
    docs.push(`${e.role} ${text} ${filePart}`);
  }

  const ctx = buildBM25Context(docs, terms, checkBudget);

  const scored: Array<{ hit: SearchHit; score: number; tf: number; distinctTerms: number; docLenRatio: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    checkBudget();
    const e = entries[i];
    const hay = docs[i];
    const mc = countMatches(hay, terms);
    if (mc === 0) continue;
    const { score, tf, distinctTerms, docLenRatio } = bm25Score(hay, terms, ctx);
    const text = messages[i] ? fullText(messages[i]) : e.summary;
    const snip = lineSnippet(text, snipRe);
    scored.push({
      hit: { ...e, snippet: snip, matchCount: mc },
      score,
      tf,
      distinctTerms,
      docLenRatio,
    });
  }

  // Calibrate: sigmoid midpoint/shift from this query's own score spread,
  // then one posterior per doc. The per-doc single transform is an
  // approximation of per-term posterior fusion — sufficient for a noise
  // gate, never used for ranking (the sort key below stays raw BM25).
  const params = estimateLikelihoodParams(scored.map((s) => s.score)) ?? { alpha: 1, beta: 0 };
  const calibrated = scored.map((s) => ({
    ...s,
    probability: scoreToProbability(s.score, s.tf, s.docLenRatio, params.alpha, params.beta),
  }));
  for (const s of calibrated) s.hit.probability = s.probability;
  // Coverage parity bar: the most distinct query terms any hit matches. Docs
  // covering the query as fully as the best doc are never tail, even when
  // their posterior sits below the absolute cutoff (homogeneous corpora).
  let maxCoverage = 0;
  for (const s of calibrated) if (s.distinctTerms > maxCoverage) maxCoverage = s.distinctTerms;

  // Sort by BM25 score desc, then drop the noisy low-probability tail
  // (multi-term queries only — see BAYESIAN_PROBABILITY_FLOOR), then
  // apply the hard cap.
  calibrated.sort((a, b) => b.score - a.score);
  // Gate on DISTINCT normalized terms, not raw term count: "auth auth" or
  // "Auth AUTH" is semantically a single-term query and must bypass the
  // gate like any other single term — repeating or casing a word doesn't
  // turn it into the multi-term OR-tail noise this gate targets. This is a
  // gate-only normalization; it does not change `terms` itself or the BM25
  // scoring above, which already matches case-insensitively.
  const effectiveTermCount = new Set(terms.map((t) => t.toLowerCase())).size;
  const gated = effectiveTermCount >= 2 ? applyProbabilityFloor(calibrated, probabilityFloor, maxCoverage) : calibrated;
  return capHits(gated.map((s) => s.hit), cap);
};

export const searchEntries = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
): SearchHit[] => searchEntriesDetailed(entries, messages, query).hits;
