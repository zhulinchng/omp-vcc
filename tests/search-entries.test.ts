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

  it("multi-term query gates the weak single-term tail; OR matching still finds it unfiltered", () => {
    // "root cause auth" — #3 matches all 3 terms, #1 only "auth". The gate
    // keeps the strong match and drops the 1-of-3 tail hit (P<0.5).
    const r = searchEntries(entries, messages, "root cause auth");
    expect(r.map((h) => h.index)).toEqual([3]);
    expect(r[0].probability).toBeGreaterThanOrEqual(0.5);
    // The matching layer itself is still OR: with the gate disabled both match.
    const unfiltered = searchEntriesDetailed(entries, messages, "root cause auth", { probabilityFloor: 0 });
    expect(unfiltered.hits.map((h) => h.index)).toEqual([3, 1]);
    // Best match (highest BM25) still comes first either way.
    expect(unfiltered.hits[0].index).toBe(3);
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

describe("searchEntriesDetailed posterior noise gate", () => {
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

  it("drops a clearly low-probability tail but preserves the surviving hits' order (default gate)", () => {
    // Baseline (gate disabled): every entry matches at least one term, and
    // the ranking is BM25 order, untouched by calibration.
    const baseline = searchEntriesDetailed(gradedEntries, gradedMessages, query, { probabilityFloor: 0, cap: 1e9 });
    expect(baseline.hits.map((h) => h.index)).toEqual([0, 1, 2, 4, 3]);

    // Default gate (no tuning override — the real production constant):
    // the low-probability tail (2, 3, 4) is dropped, top order (0, 1) preserved.
    const r = searchEntriesDetailed(gradedEntries, gradedMessages, query);
    expect(r.hits.map((h) => h.index)).toEqual([0, 1]);
    expect(r.totalBeforeCap).toBe(2);
    expect(r.truncated).toBe(false); // gate-filtered, not cap-truncated
    // Every surviving hit sits at or above the absolute cutoff; every
    // dropped tail hit sits below it.
    for (const h of r.hits) expect(h.probability).toBeGreaterThanOrEqual(0.5);
    for (const h of baseline.hits.slice(2)) expect(h.probability!).toBeLessThan(0.5);
  });

  it("never zeroes a non-empty result — a sole, low-score hit still survives", () => {
    const texts = ["nothing relevant here at all", "the redis cache invalidation kept failing in staging"];
    const e: RenderedEntry[] = texts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = texts.map((t) => ({ role: "user", content: t } as any));
    const r = searchEntriesDetailed(e, m, "redis cache invalidation");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].index).toBe(1);
    expect(r.hits[0].probability).toBeDefined(); // gate attaches probabilities even to sole survivors
  });

  it("never applies the posterior gate to single-term queries — structural, not fixture-specific", () => {
    // Effective term count (after stopword filtering) gates the gate: <2
    // terms skips it entirely, regardless of how aggressive the threshold is.
    // Proven with an aggressive threshold override (0.9) and a corpus shaped so
    // the low-scoring hit WOULD be cut if the gate applied — it survives
    // only because the single-term bypass skips filtering altogether.
    const singleTermTexts = [
      "auth ".repeat(20) + "flow rewritten", // 20x occurrences — high score
      "one mention of auth here in an otherwise unrelated changelog entry", // 1x — low score
    ];
    const e: RenderedEntry[] = singleTermTexts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = singleTermTexts.map((t) => ({ role: "user", content: t } as any));
    const r = searchEntriesDetailed(e, m, "auth", { probabilityFloor: 0.9, cap: 1e9 });
    expect(r.hits.map((h) => h.index)).toEqual([0, 1]); // both survive: single-term bypasses the gate entirely

    // Control: the SAME threshold override on an equivalent MULTI-term corpus
    // does filter the low-probability hit — proving the override mechanism itself
    // works, and that single-term survival above is the bypass, not a fluke.
    const multiTermTexts = [
      "alpha beta gamma delta ".repeat(3) + "design review",
      "alpha mentioned once in an unrelated paragraph",
    ];
    const e2: RenderedEntry[] = multiTermTexts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m2: Message[] = multiTermTexts.map((t) => ({ role: "user", content: t } as any));
    const r2 = searchEntriesDetailed(e2, m2, "alpha beta gamma delta", { probabilityFloor: 0.9, cap: 1e9 });
    expect(r2.hits.map((h) => h.index)).toEqual([0]); // low-score hit filtered
  });

  it("gates on DISTINCT normalized terms — duplicate/case-duplicate words stay single-term", () => {
    // "auth auth" / "Auth AUTH" is semantically ONE term repeated/recased,
    // not a multi-term query. Same aggressive threshold (0.9) and corpus shape
    // as above: the low-probability hit must still survive every variant.
    const texts = [
      "auth ".repeat(20) + "flow rewritten",
      "one mention of auth here in an otherwise unrelated changelog entry",
    ];
    const e: RenderedEntry[] = texts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = texts.map((t) => ({ role: "user", content: t } as any));

    for (const q of ["auth auth", "Auth AUTH", "auth Auth auth"]) {
      const r = searchEntriesDetailed(e, m, q, { probabilityFloor: 0.9, cap: 1e9 });
      expect(r.hits.map((h) => h.index).sort()).toEqual([0, 1]);
    }
  });

  it("an extreme threshold still keeps the top hit — the gate can never empty a result", () => {
    // Partial-coverage tail drops out at any threshold; the top hit survives
    // via keep-first even though its own posterior (≈0.87 — in any 2-doc
    // corpus the top likelihood is exactly sigmoid(1)) sits below the override.
    const texts = [
      "alpha beta gamma delta ".repeat(3) + "design review",
      "alpha mentioned once in an unrelated paragraph",
    ];
    const e: RenderedEntry[] = texts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = texts.map((t) => ({ role: "user", content: t } as any));
    const r = searchEntriesDetailed(e, m, "alpha beta gamma delta", { probabilityFloor: 0.99, cap: 1e9 });
    expect(r.hits.map((h) => h.index)).toEqual([0]);
  });

  it("keeps a uniformly good set via coverage parity even when every posterior is below the cutoff", () => {
    // Six docs each matching all 4 terms once: near-identical scores put the
    // median at the score itself, so every likelihood is 0.5 and every
    // posterior equals its prior (< 0.5) — yet full query coverage means none
    // is OR-tail. The old relative floor kept all six too; without parity the
    // absolute gate would collapse this to the top hit alone.
    const texts = Array.from({ length: 6 }, (_, i) => `alpha beta gamma delta review number ${i} decision`);
    const e: RenderedEntry[] = texts.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = texts.map((t) => ({ role: "user", content: t } as any));
    const r = searchEntriesDetailed(e, m, "alpha beta gamma delta", { cap: 1e9 });
    expect(r.hits.map((h) => h.index)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const h of r.hits.slice(1)) expect(h.probability!).toBeLessThan(0.5);
  });

  it("is deterministic — same query twice yields identical hits and probabilities", () => {
    const a = searchEntriesDetailed(gradedEntries, gradedMessages, query);
    const b = searchEntriesDetailed(gradedEntries, gradedMessages, query);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("collapses a broad weak tail on a large corpus but leaves single-term queries identical", () => {
    const big: string[] = [];
    for (let i = 0; i < 5; i++) big.push(`alpha beta gamma delta `.repeat(3) + `strong design review ${i}`);
    for (let i = 5; i < 60; i++) big.push(`alpha mentioned once in padding ${i} ` + "lorem ipsum dolor sit amet ".repeat(8));
    const e: RenderedEntry[] = big.map((t, i) => ({ index: i, role: "user", summary: t }));
    const m: Message[] = big.map((t) => ({ role: "user", content: t } as any));
    // Multi-term: 60 OR-matches collapse to exactly the 5 strong entries.
    const gated = searchEntriesDetailed(e, m, "alpha beta gamma delta", { cap: 1e9 });
    expect(gated.hits.map((h) => h.index)).toEqual([0, 1, 2, 3, 4]);
    for (const h of gated.hits) expect(h.probability).toBeGreaterThanOrEqual(0.5);
    const disabled = searchEntriesDetailed(e, m, "alpha beta gamma delta", { probabilityFloor: 0, cap: 1e9 });
    expect(disabled.hits).toHaveLength(60);
    // Single-term: the gate is bypassed, override or not — identical lists.
    const s1 = searchEntriesDetailed(e, m, "alpha", { cap: 1e9 });
    const s2 = searchEntriesDetailed(e, m, "alpha", { probabilityFloor: 0, cap: 1e9 });
    expect(s1.hits.map((h) => h.index)).toEqual(s2.hits.map((h) => h.index));
  });
});

describe("searchEntriesDetailed posterior gate hit-rate and edges", () => {
  // Deterministic PRNG so the planted-relevance corpora below are stable.
  const mulberry32 = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed eiusmod tempor incididunt labore dolore magna aliqua enim quis nostrud exercitation ullamco laboris nisi aliquip commodo consequat aute irure reprehenderit voluptate velit cillum fugiat nulla pariatur standup retro backlog ticket".split(" ");
  const QTERMS = ["redis", "cache", "invalidation", "failure"];
  const mkEntries = (texts: string[]) => ({
    e: texts.map((t, i) => ({ index: i, role: "user", summary: t }) as RenderedEntry),
    m: texts.map((t) => ({ role: "user", content: t }) as any as Message),
  });

  it("keeps every planted full-coverage doc across lengths while collapsing the tail", () => {
    // The hit-rate proof: relevant docs (all query terms; one-liner, medium,
    // long, and an adversarial 400-word dilution) planted in 1-term OR-tail
    // noise all survive the default gate; top-1 matches the ungated ranking.
    for (const seed of [11, 22, 33]) {
      const r = mulberry32(seed);
      const pick = (arr: string[]) => arr[Math.floor(r() * arr.length)];
      const fill = (n: number) => Array.from({ length: n }, () => pick(FILLER)).join(" ");
      const sprinkle = (text: string, reps: number) => {
        const w = text.split(" ");
        for (let k = 0; k < reps; k++) for (const t of QTERMS) w.splice(Math.floor(r() * w.length), 0, t);
        return w.join(" ");
      };
      const texts: string[] = [
        sprinkle(fill(8), 1), // short one-liner (length prior minimum)
        sprinkle(fill(45), 2), // medium
        sprinkle(fill(200), 2), // long
        sprinkle(fill(400), 1), // adversarial: full coverage, heavily diluted
      ];
      const planted = new Set([0, 1, 2, 3]);
      while (texts.length < 60) {
        const w = fill(10 + Math.floor(r() * 100)).split(" ");
        w.splice(Math.floor(r() * w.length), 0, pick(QTERMS)); // 1-term tail
        texts.push(w.join(" "));
      }
      const { e, m } = mkEntries(texts);
      const ungated = searchEntriesDetailed(e, m, QTERMS.join(" "), { probabilityFloor: 0, cap: 1e9 });
      const gated = searchEntriesDetailed(e, m, QTERMS.join(" "), { cap: 1e9 });
      const kept = new Set(gated.hits.map((h) => h.index));
      for (const p of planted) expect(kept.has(p)).toBe(true); // 100% planted recall
      expect(gated.hits[0].index).toBe(ungated.hits[0].index); // top-1 never moves
      expect(gated.hits.length).toBeLessThan(ungated.hits.length); // tail collapses
      for (const h of gated.hits) expect(h.probability).toBeDefined();
    }
  });

  it("coverage parity beats the threshold: a non-top full-coverage doc survives floor 0.99", () => {
    // Structural (no calibration knife-edge): doc 1 covers every term, so
    // distinctTerms == maxCoverage keeps it at any threshold; the partial
    // tail still drops.
    const { e, m } = mkEntries([
      "alpha beta gamma delta ".repeat(3) + "design review",
      "alpha beta gamma delta mentioned once in the notes",
      "alpha mentioned once in an unrelated paragraph",
    ]);
    const r = searchEntriesDetailed(e, m, "alpha beta gamma delta", { probabilityFloor: 0.99, cap: 1e9 });
    expect(r.hits.map((h) => h.index)).toEqual([0, 1]);
  });

  it("a uniformly weak corpus stands down: every 1-term match survives", () => {
    // Parity symmetry with the uniform-good case: when the best coverage is
    // 1 term, every 1-term doc covers the query as fully as the best doc, so
    // a homogeneous corpus is preserved rather than massacred.
    const { e, m } = mkEntries([
      "alpha appears here in this note",
      "beta appears here in this note",
      "gamma appears here in this note",
      "delta appears here in this note",
      "alpha appears again in this note",
    ]);
    const r = searchEntriesDetailed(e, m, "alpha beta gamma delta", { cap: 1e9 });
    expect(r.hits.map((h) => h.index).sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("a file-path-only match survives the multi-term gate with a null snippet", () => {
    // Coverage counts the haystack (text + file paths), so a query matching
    // only a file path is full-coverage, never OR-tail. Snippet comes from
    // text alone, so it stays undefined rather than fabricating context.
    const e: RenderedEntry[] = [
      { index: 0, role: "user", summary: "redis cache design review notes" },
      { index: 1, role: "user", summary: "standup notes", files: ["src/redis-cache.ts"] },
      { index: 2, role: "user", summary: "redis mentioned once in unrelated padding " + "lorem ipsum ".repeat(20) },
    ];
    const m: Message[] = [
      { role: "user", content: "redis cache design review notes" } as any,
      { role: "user", content: "standup notes" } as any,
      { role: "user", content: e[2].summary } as any,
    ];
    const r = searchEntriesDetailed(e, m, "redis cache", { cap: 1e9 });
    expect(r.hits.map((h) => h.index).sort()).toEqual([0, 1]);
    expect(r.hits.find((h) => h.index === 1)!.snippet).toBeUndefined();
  });

  it("falls back to the entry summary when messages are shorter than entries", () => {
    const e: RenderedEntry[] = [
      { index: 0, role: "user", summary: "alpha beta gamma design notes" },
      { index: 1, role: "user", summary: "unrelated changelog entry" },
    ];
    const m: Message[] = [{ role: "user", content: "alpha beta gamma design notes" } as any];
    const r = searchEntriesDetailed(e, m, "alpha beta gamma", { cap: 1e9 });
    expect(r.hits.map((h) => h.index)).toEqual([0]);
  });

  it("an all-stopword multi-term query keeps its full-coverage match", () => {
    // All-stopword queries keep their terms (filterStopwords fallback), so
    // the gate applies — and the doc covering every term survives by parity.
    const { e, m } = mkEntries(["the and of together", "nothing relevant here"]);
    const r = searchEntriesDetailed(e, m, "the and of", { cap: 1e9 });
    expect(r.hits.map((h) => h.index)).toEqual([0]);
  });

  it("a stopword-reduced single-effective-term query bypasses the gate structurally", () => {
    // "the auth" reduces to [auth]: one effective term, so even a 0.9 floor
    // keeps the low-probability hit — with its sub-cutoff probability still
    // attached, proving the gate never ran rather than passing everything.
    const { e, m } = mkEntries([
      "the auth flow rewritten",
      "one mention of auth here in unrelated notes",
      "nothing relevant",
    ]);
    const r = searchEntriesDetailed(e, m, "the auth", { probabilityFloor: 0.9, cap: 1e9 });
    expect(r.hits.map((h) => h.index)).toEqual([0, 1]);
    expect(r.hits[1].probability!).toBeLessThan(0.5);
  });

  it("reports gate-then-cap honestly when the gated set still exceeds the cap", () => {
    const texts = Array.from({ length: 60 }, (_, i) => `alpha beta gamma delta review number ${i} decision`);
    const { e, m } = mkEntries(texts);
    const r = searchEntriesDetailed(e, m, "alpha beta gamma delta"); // default cap 50
    expect(r.hits).toHaveLength(50);
    expect(r.totalBeforeCap).toBe(60);
    expect(r.truncated).toBe(true);
  });

  it("regex-path hits carry no posterior probability", () => {
    // The gate never runs for boolean regex matches — probability stays
    // undefined and downstream formatters must tolerate its absence.
    const { e, m } = mkEntries(["fix login bug", "auth module notes"]);
    const r = searchEntriesDetailed(e, m, "login|auth");
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) expect(h.probability).toBeUndefined();
  });

  it("returns empty for an empty corpus, with or without a query", () => {
    expect(searchEntriesDetailed([], [], "alpha beta").hits).toEqual([]);
    expect(searchEntriesDetailed([], [], "").hits).toEqual([]);
  });

  it("the production default is exactly floor 0.5, cap 50", () => {
    // Pins the default tuning values themselves: changing the constant
    // without updating this test (and the tuning docs) fails here.
    const { e, m } = mkEntries([
      "alpha beta gamma delta design review top entry",
      "alpha beta gamma delta mentioned once",
      "alpha mentioned once in an unrelated paragraph",
    ]);
    const def = searchEntriesDetailed(e, m, "alpha beta gamma delta");
    const explicit = searchEntriesDetailed(e, m, "alpha beta gamma delta", { probabilityFloor: 0.5, cap: 50 });
    expect(JSON.stringify(def)).toBe(JSON.stringify(explicit));
  });

  it("raising the floor only ever shrinks the kept set", () => {
    // Threshold + parity + keep-first are all monotone in the floor, so a
    // higher floor can drop tail hits but never admit one a lower floor
    // drops. Structural — holds on any corpus, pinned here on a graded one.
    const { e, m } = mkEntries([
      "alpha beta gamma delta ".repeat(3) + "design review",
      "alpha beta gamma delta mentioned once in the notes",
      "alpha beta planning note for the release",
      "alpha mentioned once in an unrelated paragraph",
      "beta appears here only one time in a sentence about nothing",
    ]);
    const q = "alpha beta gamma delta";
    const at = (f: number) =>
      new Set(searchEntriesDetailed(e, m, q, { probabilityFloor: f, cap: 1e9 }).hits.map((h) => h.index));
    const floors = [0.3, 0.4, 0.5, 0.6, 0.7];
    const sets = floors.map(at);
    for (let i = 0; i + 1 < sets.length; i++)
      for (const idx of sets[i + 1]) expect(sets[i].has(idx)).toBe(true);
    // And the knob actually bites: the strictest floor keeps strictly fewer.
    expect(sets[4].size).toBeLessThan(sets[0].size);
  });

  it("planted recall is flat across the whole tuning band, noise falls with the floor", () => {
    // Guards the no-retuning verdict: relevant docs survive at every floor
    // in the plausible band, so the threshold only moves tail membership.
    for (const seed of [5, 6]) {
      const r = mulberry32(seed);
      const pick = (arr: string[]) => arr[Math.floor(r() * arr.length)];
      const fill = (n: number) => Array.from({ length: n }, () => pick(FILLER)).join(" ");
      const sprinkle = (text: string, reps: number) => {
        const w = text.split(" ");
        for (let k = 0; k < reps; k++) for (const t of QTERMS) w.splice(Math.floor(r() * w.length), 0, t);
        return w.join(" ");
      };
      const texts = [sprinkle(fill(8), 1), sprinkle(fill(45), 2), sprinkle(fill(400), 1)];
      while (texts.length < 40) {
        const w = fill(10 + Math.floor(r() * 80)).split(" ");
        w.splice(Math.floor(r() * w.length), 0, pick(QTERMS));
        texts.push(w.join(" "));
      }
      const { e, m } = mkEntries(texts);
      const sizes: number[] = [];
      for (const f of [0.3, 0.5, 0.7]) {
        const g = searchEntriesDetailed(e, m, QTERMS.join(" "), { probabilityFloor: f, cap: 1e9 });
        const kept = new Set(g.hits.map((h) => h.index));
        for (const p of [0, 1, 2]) expect(kept.has(p)).toBe(true); // recall flat
        sizes.push(g.hits.length);
      }
      expect(sizes[0]).toBeGreaterThanOrEqual(sizes[1]); // noise non-increasing
      expect(sizes[1]).toBeGreaterThanOrEqual(sizes[2]);
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
    // Disable the gate so the cap's effect is isolated — all 60 entries
    // are equally strong single-term matches, so none would be gate-filtered.
    const r = searchEntriesDetailed(bm25Entries, bm25Messages, "zebra_query_tag", { probabilityFloor: 0 });
    expect(r.totalBeforeCap).toBe(60);
    expect(r.hits).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });

  it("bounds the regex path to SEARCH_RESULT_CAP (50), with default tuning (no override)", () => {
    const regexEntries: RenderedEntry[] = Array.from({ length: size }, (_, i) => ({
      index: i, role: "user", summary: `zebra_query_tag entry number ${i}`,
    }));
    const regexMessages: Message[] = regexEntries.map((e) => ({ role: "user", content: e.summary } as any));
    // "." makes this a regex-mode query (looksLikeRegex), no BM25/gate involved.
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
