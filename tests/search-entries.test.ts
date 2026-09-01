// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { searchEntries, searchEntriesDetailed } from "../extensions/vcc-core/core/search-entries";
import type { RenderedEntry } from "../extensions/vcc-core/core/render-entries";
import type { Message } from "@oh-my-pi/pi-ai";

const entries: RenderedEntry[] = [
  { index: 0, role: "user", summary: "Fix login bug" },
  { index: 1, role: "assistant", summary: "Reading auth.ts" },
  { index: 2, role: "tool_result", summary: "[Read] code here" },
  { index: 3, role: "assistant", summary: "Found the root cause in auth module" },
];

const messages: Message[] = [
  { role: "user", content: "Fix login bug" } as any,
  { role: "assistant", content: [{ type: "text", text: "Reading auth.ts" }] } as any,
  { role: "toolResult", content: [{ type: "text", text: "[Read] code here" }] } as any,
  { role: "assistant", content: [{ type: "text", text: "Found the root cause in auth module" }] } as any,
];

describe("searchEntries", () => {
  it("returns all for empty query", () => {
    expect(searchEntries(entries, messages)).toEqual(entries);
    expect(searchEntries(entries, messages, "")).toEqual(entries);
  });

  it("filters by single term", () => {
    const r = searchEntries(entries, messages, "login");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  it("returns empty for no match", () => {
    expect(searchEntries(entries, messages, "xyz123")).toEqual([]);
  });

  it("finds keyword beyond clip boundary in full content", () => {
    const longText = "A".repeat(400) + " hidden_keyword here";
    const longEntries: RenderedEntry[] = [
      { index: 0, role: "user", summary: "A".repeat(300) },
    ];
    const longMsgs: Message[] = [
      { role: "user", content: longText } as any,
    ];
    const r = searchEntries(longEntries, longMsgs, "hidden_keyword");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("hidden_keyword");
  });

  it("returns snippet around matched term", () => {
    const r = searchEntries(entries, messages, "root");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toBeDefined();
    expect(r[0].snippet).toContain("root");
  });

  // ── regex support ──

  it("supports regex pattern: alternation", () => {
    const r = searchEntries(entries, messages, "login|auth");
    expect(r).toHaveLength(3); // "login bug", "auth.ts", "auth module"
    expect(r.map((h) => h.index).sort()).toEqual([0, 1, 3]);
  });

  it("supports regex pattern: wildcard", () => {
    const r = searchEntries(entries, messages, "Read.*auth");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(1);
  });

  it("falls back to escaped literal for invalid regex", () => {
    const extraEntries: RenderedEntry[] = [
      { index: 0, role: "user", summary: "test (foo" },
      { index: 1, role: "assistant", summary: "no match here" },
    ];
    const extraMsgs: Message[] = [
      { role: "user", content: "error with (foo pattern" } as any,
      { role: "assistant", content: [{ type: "text", text: "no match here" }] } as any,
    ];
    const r = searchEntries(extraEntries, extraMsgs, "(foo");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  it("regex is case-insensitive", () => {
    const r = searchEntries(entries, messages, "FIX|ROOT");
    expect(r).toHaveLength(2);
  });

  // ── natural language queries (OR logic + ranking) ──

  it("natural language query uses OR logic", () => {
    // "root cause auth" -- matches entries containing ANY of these terms
    const r = searchEntries(entries, messages, "root cause auth");
    expect(r.length).toBeGreaterThanOrEqual(2); // #3 has all 3, #1 has auth
    // Best match (highest BM25) should come first
    expect(r[0].index).toBe(3); // "Found the root cause in auth module" matches all 3
  });

  it("natural language ranks by BM25 score", () => {
    const r = searchEntries(entries, messages, "root cause auth");
    // Top result has more terms matched = higher BM25 score
    expect(r[0].matchCount!).toBeGreaterThanOrEqual(r[r.length - 1].matchCount!);
  });

  it("filters stopwords from queries", () => {
    // "the root cause of it" → stopwords: the, of, it → meaningful: root, cause
    const r = searchEntries(entries, messages, "the root cause of it");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(3);
  });

  it("keeps all terms if all are stopwords", () => {
    // When all terms are stopwords, keep them (don't drop everything)
    // "the" appears in "Found the root cause" so it matches
    const r = searchEntries(entries, messages, "the");
    expect(r.length).toBeGreaterThan(0);
  });

  // ── line-based snippet ──

  it("snippet shows context lines around match", () => {
    const multiline = "line 0\nline 1\nline 2 TARGET\nline 3\nline 4\nline 5";
    const e: RenderedEntry[] = [{ index: 0, role: "user", summary: "test" }];
    const m: Message[] = [{ role: "user", content: multiline } as any];
    const r = searchEntries(e, m, "TARGET");
    expect(r).toHaveLength(1);
    const snip = r[0].snippet!;
    expect(snip).toContain("line 2 TARGET");
    expect(snip).toContain("line 0");
    expect(snip).toContain("line 4");
    expect(snip).not.toContain("line 5");
  });

  it("snippet handles match at beginning", () => {
    const multiline = "TARGET here\nline 1\nline 2\nline 3";
    const e: RenderedEntry[] = [{ index: 0, role: "user", summary: "test" }];
    const m: Message[] = [{ role: "user", content: multiline } as any];
    const r = searchEntries(e, m, "TARGET");
    const snip = r[0].snippet!;
    expect(snip).toContain("TARGET here");
    expect(snip).toContain("line 2");
    expect(snip).not.toContain("line 3");
  });
});

describe("searchEntries regex safety", () => {
  const corpus = (n: number) => {
    const entries: any[] = [];
    const messages: any[] = [];
    for (let i = 0; i < n; i++) {
      const body = "a".repeat(40) + "b";
      entries.push({ index: i, role: "user", summary: body, files: [] });
      messages.push({ role: "user", content: [{ type: "text", text: body }] });
    }
    return { entries, messages };
  };

  it("treats nested-quantifier patterns as literals instead of hanging", () => {
    const { entries, messages } = corpus(20);
    const t0 = Date.now();
    const hits = searchEntries(entries, messages, "(a+)+$");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(hits.length).toBe(0); // matched literally, not as a pattern
  });

  it("still honours legitimate regex queries", () => {
    const entries: any[] = [
      { index: 0, role: "user", summary: "deploy to staging", files: [] },
      { index: 1, role: "user", summary: "deploy to prod", files: [] },
    ];
    const messages: any[] = entries.map((e) => ({
      role: "user",
      content: [{ type: "text", text: e.summary }],
    }));
    const hits = searchEntries(entries, messages, "stag(ing|e)");
    expect(hits.length).toBe(1);
    expect(hits[0].index).toBe(0);
  });
});

describe("searchEntries mode fallback", () => {
  const texts = [
    "We decided to drop the Redis cache because invalidation kept breaking staging.",
    "The auth flow now uses short-lived tokens refreshed by the gateway.",
    "Ran the migration script; it failed on the users table and we rolled back.",
  ];
  const entries: any[] = texts.map((t, i) => ({ index: i, role: "user", summary: t, files: [] }));
  const messages: any[] = texts.map((t) => ({ role: "user", content: [{ type: "text", text: t }] }));

  it("falls back to term search when punctuation forces the regex path", () => {
    // A trailing "?" makes looksLikeRegex treat the whole sentence as one pattern.
    expect(searchEntries(entries, messages, "why did we drop the cache?").length)
      .toBe(searchEntries(entries, messages, "why did we drop the cache").length);
  });

  it("keeps regex results when the pattern actually matches", () => {
    const hits = searchEntries(entries, messages, "auth|migration");
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.matchCount === 1)).toBe(true); // regex path, not term path
  });

  it("returns nothing when neither mode matches", () => {
    expect(searchEntries(entries, messages, "kubernetes").length).toBe(0);
  });
});

describe("searchEntries toolCall arguments", () => {
  it("finds a bash command that exists only in toolCall arguments", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Running the test suite" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command: "grep -rn UNIQUEMARKER42 src" } }],
    } as any];
    const r = searchEntries(e, m, "UNIQUEMARKER42");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
    expect(r[0].snippet).toContain("UNIQUEMARKER42");
    expect(r[0].snippet).toContain("grep");
  });

  it("finds Write content that exists only in toolCall arguments", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Writing config" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{
        type: "toolCall", name: "Write",
        arguments: { path: "config.json", content: '{ "featureFlag": "ZEBRA_STRIPE_MODE" }' },
      }],
    } as any];
    const r = searchEntries(e, m, "ZEBRA_STRIPE_MODE");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("ZEBRA_STRIPE_MODE");
  });

  it("finds Edit oldText/newText that exist only in toolCall arguments", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Editing file" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{
        type: "toolCall", name: "Edit",
        arguments: { path: "a.ts", oldText: "const x = 1;", newText: "const QUOKKA_TOKEN = 2;" },
      }],
    } as any];
    const r = searchEntries(e, m, "QUOKKA_TOKEN");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("QUOKKA_TOKEN");
  });

  it("finds edits[] array oldText/newText that exist only in toolCall arguments", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Editing file" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{
        type: "toolCall", name: "Edit",
        arguments: { path: "a.ts", edits: [{ oldText: "old", newText: "const NARWHAL_FLAG = true;" }] },
      }],
    } as any];
    const r = searchEntries(e, m, "NARWHAL_FLAG");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("NARWHAL_FLAG");
  });

  it("does not index a toolCall argument past the aggregate message budget (head-only cap)", () => {
    // Needle sits ~5000 chars into a single arg field, well past the ~2000-char
    // per-message toolCall-args budget — it must not be indexed.
    const giant = "A".repeat(5000) + " NEEDLE_PAST_THE_CAP";
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Writing large file" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{ type: "toolCall", name: "Write", arguments: { content: giant } }],
    } as any];
    expect(searchEntries(e, m, "NEEDLE_PAST_THE_CAP")).toHaveLength(0);
  });

  it("aggregates multiple toolCalls under ONE message-level budget, not per-call", () => {
    // Two toolCalls, each individually well under a 2000-char cap (~1500
    // chars), so a *per-call* cap would let both through in full. Only an
    // *aggregate* per-message budget clips the combined text — proving the
    // fix for the reviewed invariant (N toolCalls must not multiply the bound).
    const call1 = { command: "EARLY_MARKER " + "A".repeat(1490) }; // ~1503 chars
    const call2 = { command: "B".repeat(1490) + " LATE_MARKER_XYZ" }; // ~1507 chars
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Two big bash calls" }];
    const m: Message[] = [{
      role: "assistant",
      content: [
        { type: "toolCall", name: "bash", arguments: call1 },
        { type: "toolCall", name: "bash", arguments: call2 },
      ],
    } as any];
    const early = searchEntries(e, m, "EARLY_MARKER");
    expect(early).toHaveLength(1);
    expect(early[0].snippet).toContain("EARLY_MARKER");
    // Combined raw text (call1 + "\n" + call2) is ~3011 chars; LATE_MARKER_XYZ
    // sits at the tail of call2, past the shared 2000-char budget.
    expect(searchEntries(e, m, "LATE_MARKER_XYZ")).toHaveLength(0);
  });

  it("keeps a giant toolCall argument's indexed/snippet contribution bounded", () => {
    // Needle sits near the start (within the cap) — it's found, and the
    // snippet built from that indexed text stays bounded even though the
    // underlying argument is 20k+ chars.
    const giant = "NEEDLE_NEAR_START " + "B".repeat(20_000);
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Writing large file" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{ type: "toolCall", name: "Write", arguments: { content: giant } }],
    } as any];
    const r = searchEntries(e, m, "NEEDLE_NEAR_START");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("NEEDLE_NEAR_START");
    // Bounded: the snippet must never approach the raw 20k-char argument size.
    expect(r[0].snippet!.length).toBeLessThan(2500);
  });

  it("excludes the recall tool's own arguments from search (no self-hit)", () => {
    // A vcc_recall invocation is persisted as an ordinary assistant toolCall.
    // Its own { query } argument must not echo the search term back as a
    // guaranteed self-hit — that would pollute every search's result count.
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Searching" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{ type: "toolCall", name: "vcc_recall", arguments: { query: "SELF_HIT_MARKER" } }],
    } as any];
    expect(searchEntries(e, m, "SELF_HIT_MARKER")).toHaveLength(0);
  });

  it("excludes only the recall tool call, not a sibling toolCall in the same message", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Searching then running" }];
    const m: Message[] = [{
      role: "assistant",
      content: [
        { type: "toolCall", name: "vcc_recall", arguments: { query: "SELF_HIT_MARKER" } },
        { type: "toolCall", name: "bash", arguments: { command: "echo SIBLING_MARKER" } },
      ],
    } as any];
    expect(searchEntries(e, m, "SELF_HIT_MARKER")).toHaveLength(0);
    const r = searchEntries(e, m, "SIBLING_MARKER");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("SIBLING_MARKER");
  });

  it("excludes the recall tool call case-insensitively", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "assistant", summary: "Searching" }];
    const m: Message[] = [{
      role: "assistant",
      content: [{ type: "toolCall", name: "VCC_Recall", arguments: { query: "SELF_HIT_MARKER_2" } }],
    } as any];
    expect(searchEntries(e, m, "SELF_HIT_MARKER_2")).toHaveLength(0);
  });

  it("does not regress plain text search when toolCall args are also present", () => {
    const r = searchEntries(entries, messages, "login");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });
});

describe("searchEntries recall toolResult exclusion", () => {
  // A vcc_recall call is [toolCall args (assistant)] -> [toolResult text].
  // The toolCall-args side is covered above; these cover the toolResult side
  // — its "N matches for \"<query>\">" text must not self-match a repeat query.

  it("excludes the recall tool's own toolResult from search (no growth on repeat query)", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "tool_result", summary: '[vcc_recall] 1 matches for "MARKER"' }];
    const m: Message[] = [{
      role: "toolResult", toolName: "vcc_recall",
      content: [{ type: "text", text: '1 matches for "MARKER" (page 1/1)' }],
    } as any];
    expect(searchEntries(e, m, "MARKER")).toHaveLength(0);
  });

  it("keeps an ordinary (non-recall) toolResult searchable", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "tool_result", summary: "[Read] file contents" }];
    const m: Message[] = [{
      role: "toolResult", toolName: "Read",
      content: [{ type: "text", text: "export const MARKER_VALUE = 1;" }],
    } as any];
    const r = searchEntries(e, m, "MARKER_VALUE");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("MARKER_VALUE");
  });

  it("does not affect browse/no-query results — entries are returned unchanged", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "tool_result", summary: '[vcc_recall] 1 matches for "MARKER"' }];
    const m: Message[] = [{
      role: "toolResult", toolName: "vcc_recall",
      content: [{ type: "text", text: '1 matches for "MARKER"' }],
    } as any];
    expect(searchEntries(e, m)).toEqual(e);
    expect(searchEntries(e, m, "")).toEqual(e);
  });

  it("excludes the recall toolResult case-insensitively", () => {
    const e: RenderedEntry[] = [{ index: 0, role: "tool_result", summary: '[VCC_Recall] 1 matches for "MARKER2"' }];
    const m: Message[] = [{
      role: "toolResult", toolName: "VCC_Recall",
      content: [{ type: "text", text: '1 matches for "MARKER2"' }],
    } as any];
    expect(searchEntries(e, m, "MARKER2")).toHaveLength(0);
  });
});

describe("searchEntriesDetailed relative noise floor", () => {
  // Query matches all 4 terms multiple times in entry 0, all 4 terms once
  // in entry 1, and only 1 of 4 terms once each in entries 2-4 — a clear
  // score cliff between {0,1} and {2,3,4} under multi-term BM25 OR scoring.
  const graded = [
    "alpha beta gamma delta alpha beta gamma delta alpha beta gamma delta discussion of the redis cache design",
    "alpha beta gamma delta talked about this pairing once in a design review",
    "alpha mentioned once in passing during a long unrelated conversation about something else entirely",
    "beta appears here only one time in a sentence about nothing important at all today",
    "gamma shows up once too in this otherwise unrelated paragraph of text about weather",
  ];
  const gradedEntries: RenderedEntry[] = graded.map((t, i) => ({ index: i, role: "user", summary: t }));
  const gradedMessages: Message[] = graded.map((t) => ({ role: "user", content: t } as any));
  const query = "alpha beta gamma delta";

  it("drops a clearly low-score tail but preserves the surviving hits' order (default floor)", () => {
    // Baseline (floor disabled): every entry matches at least one term.
    const baseline = searchEntriesDetailed(gradedEntries, gradedMessages, query, { relativeFloor: 0, cap: 1e9 });
    expect(baseline.hits.map((h) => h.index)).toEqual([0, 1, 2, 4, 3]);

    // Default floor (no tuning override — the real production constant):
    // the low-score tail (2, 3, 4) is dropped, top order (0, 1) preserved.
    const r = searchEntriesDetailed(gradedEntries, gradedMessages, query);
    expect(r.hits.map((h) => h.index)).toEqual([0, 1]);
    expect(r.totalBeforeCap).toBe(2);
    expect(r.truncated).toBe(false); // floor-filtered, not cap-truncated
  });

  it("never zeroes a non-empty result — a sole, low-score hit still survives", () => {
    const texts = ["nothing relevant here at all", "the redis cache invalidation kept failing in staging"];
    const e: RenderedEntry[] = texts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = texts.map((t) => ({ role: "user", content: t } as any));
    const r = searchEntriesDetailed(e, m, "redis cache invalidation");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].index).toBe(1);
  });

  it("never applies the relative floor to single-term queries — structural, not fixture-specific", () => {
    // Effective term count (after stopword filtering) gates the floor: <2
    // terms skips it entirely, regardless of how aggressive the floor is.
    // Proven with an aggressive floor override (0.9) and a corpus shaped so
    // the low-scoring hit WOULD be cut if the floor applied — it survives
    // only because the single-term gate bypasses filtering altogether.
    const singleTermTexts = [
      "auth ".repeat(20) + "flow rewritten", // 20x occurrences — high score
      "one mention of auth here in an otherwise unrelated changelog entry", // 1x — low score
    ];
    const e: RenderedEntry[] = singleTermTexts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = singleTermTexts.map((t) => ({ role: "user", content: t } as any));
    const r = searchEntriesDetailed(e, m, "auth", { relativeFloor: 0.9, cap: 1e9 });
    expect(r.hits.map((h) => h.index)).toEqual([0, 1]); // both survive: gate bypassed floor entirely

    // Control: the SAME floor override on an equivalent MULTI-term corpus
    // does filter the low-score hit — proving the override mechanism itself
    // works, and that single-term survival above is the gate, not a fluke.
    const multiTermTexts = [
      "alpha beta gamma delta ".repeat(3) + "design review",
      "alpha mentioned once in an unrelated paragraph",
    ];
    const e2: RenderedEntry[] = multiTermTexts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m2: Message[] = multiTermTexts.map((t) => ({ role: "user", content: t } as any));
    const r2 = searchEntriesDetailed(e2, m2, "alpha beta gamma delta", { relativeFloor: 0.9, cap: 1e9 });
    expect(r2.hits.map((h) => h.index)).toEqual([0]); // low-score hit filtered
  });

  it("gates on DISTINCT normalized terms — duplicate/case-duplicate words stay single-term", () => {
    // "auth auth" / "Auth AUTH" is semantically ONE term repeated/recased,
    // not a multi-term query. Same aggressive floor (0.9) and corpus shape
    // as above: the low-score hit must still survive every variant.
    const texts = [
      "auth ".repeat(20) + "flow rewritten",
      "one mention of auth here in an otherwise unrelated changelog entry",
    ];
    const e: RenderedEntry[] = texts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = texts.map((t) => ({ role: "user", content: t } as any));

    for (const q of ["auth auth", "Auth AUTH", "auth Auth auth"]) {
      const r = searchEntriesDetailed(e, m, q, { relativeFloor: 0.9, cap: 1e9 });
      expect(r.hits.map((h) => h.index).sort()).toEqual([0, 1]);
    }
  });
});

describe("searchEntriesDetailed hard result cap", () => {
  const size = 60;
  const bm25Entries: RenderedEntry[] = Array.from({ length: size }, (_, i) => ({
    index: i, role: "user", summary: `zebra_query_tag entry number ${i}`,
  }));
  const bm25Messages: Message[] = bm25Entries.map((e) => ({ role: "user", content: e.summary } as any));

  it("bounds the BM25/natural-language path to SEARCH_RESULT_CAP (50)", () => {
    // Disable the floor so the cap's effect is isolated — all 60 entries
    // are equally strong single-term matches, so none would be floor-filtered.
    const r = searchEntriesDetailed(bm25Entries, bm25Messages, "zebra_query_tag", { relativeFloor: 0 });
    expect(r.totalBeforeCap).toBe(60);
    expect(r.hits).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it("bounds the regex path to SEARCH_RESULT_CAP (50), with default tuning (no override)", () => {
    const regexEntries: RenderedEntry[] = Array.from({ length: size }, (_, i) => ({
      index: i, role: "user", summary: `zebra_query_tag entry number ${i}`,
    }));
    const regexMessages: Message[] = regexEntries.map((e) => ({ role: "user", content: e.summary } as any));
    // "." makes this a regex-mode query (looksLikeRegex), no BM25/floor involved.
    const r = searchEntriesDetailed(regexEntries, regexMessages, "zebra_query_tag.*entry");
    expect(r.totalBeforeCap).toBe(60);
    expect(r.hits).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it("does not truncate when raw hits are under the cap", () => {
    const small = bm25Entries.slice(0, 10);
    const smallMsgs = bm25Messages.slice(0, 10);
    const r = searchEntriesDetailed(small, smallMsgs, "zebra_query_tag");
    expect(r.hits).toHaveLength(10);
    expect(r.totalBeforeCap).toBe(10);
    expect(r.truncated).toBe(false);
  });
});
