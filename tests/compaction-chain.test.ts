// @ts-nocheck
import { describe, expect, test } from "bun:test";
import {
  APPEND_SEGMENT_CUSTOM_TYPE,
  APPEND_TRAILING_CUSTOM_TYPE,
  buildAppendOnlyDetails,
  collectActiveSegments,
  compactionThresholds,
  coverageForMessages,
  decideAppendMode,
  isPiVccAppendDetails,
  projectAppendOnlyContext,
} from "../extensions/vcc-core/core/compaction-chain";

const entry = (id: string, role: string, content: unknown = "x") => ({
  id,
  type: "message",
  message: { role, content },
});

const coverage = (first: string, last: string, kept: string) => ({
  firstCoveredEntryId: first,
  lastCoveredEntryId: last,
  firstKeptEntryId: kept,
  sourceMessageCount: 2,
});

const details = (sequence: number, chainStart: boolean, trailing: string, first = "a", last = "b", kept = "c") => ({
  compactor: "omp-vcc",
  version: 3,
  summaryMode: "append",
  chainStart,
  segment: { sequence, summary: `segment ${sequence}`, coverage: coverage(first, last, kept), tokensBefore: 100 },
  trailingSummary: trailing,
  sections: ["Session Goal"],
  sourceMessageCount: 2,
  previousSummaryUsed: sequence > 1,
});

const compaction = (id: string, value: Record<string, unknown>, firstKeptEntryId = "c") => ({
  id,
  type: "compaction",
  firstKeptEntryId,
  summary: value.trailingSummary,
  details: value,
});

describe("append compaction chain", () => {
  test("validates and collects contiguous active segments", () => {
    const first = details(1, true, "fallback one", "a", "b", "c");
    const second = details(2, false, "fallback two", "c", "d", "e");
    const branch = [
      entry("a", "user"), entry("b", "assistant"), entry("c", "user"), entry("d", "assistant"), entry("e", "user"),
      compaction("c1", first), compaction("c2", second, "e"),
    ];
    const chain = collectActiveSegments(branch, { fallbackSummary: "fallback two" });
    expect(chain?.segments.map((segment) => segment.sequence)).toEqual([1, 2]);
    expect(chain?.fallbackSummary).toBe("fallback two");

    const malformed = structuredClone(branch);
    const malformedDetails = malformed[6].details as { segment: { sequence: number } };
    malformedDetails.segment.sequence = 4;
    expect(collectActiveSegments(malformed)).toBeNull();
  });

  test("coverage fails closed on missing selected ids", () => {
    expect(coverageForMessages({ selectedIds: ["a", undefined], firstKeptEntryId: "c" })).toBeNull();
    expect(coverageForMessages({ selectedIds: ["a", "b"], firstKeptEntryId: "c" })).toEqual(coverage("a", "b", "c"));
  });

  test("builds chain-start and next sequence details", () => {
    const first = buildAppendOnlyDetails({
      segment: { summary: "one", coverage: coverage("a", "b", "c"), tokensBefore: 90 },
      chainStart: true,
      trailingSummary: "fallback",
      sections: ["Session Goal"],
      sourceMessageCount: 2,
      previousSummaryUsed: false,
    });
    expect(isPiVccAppendDetails(first)).toBe(true);
    const firstChain = collectActiveSegments([entry("a", "user"), entry("b", "assistant"), entry("c", "user"), compaction("c1", first)]);
    const second = buildAppendOnlyDetails({
      segment: { summary: "two", coverage: coverage("c", "d", "e"), tokensBefore: 80 },
      chainStart: false,
      trailingSummary: "fallback 2",
      sections: ["Session Goal"],
      sourceMessageCount: 2,
      previousSummaryUsed: true,
      previous: firstChain,
    });
    expect(second?.segment.sequence).toBe(2);
  });

  test("projects exactly one exact fallback match without mutating input", () => {
    const first = details(1, true, "fallback", "a", "b", "c");
    const chain = collectActiveSegments([entry("a", "user"), entry("b", "assistant"), entry("c", "user"), compaction("c1", first)], { fallbackSummary: "fallback" });
    const messages = [
      { role: "user", content: "before" },
      { role: "branchSummary", summary: "fallback" },
      { role: "user", content: "after" },
    ];
    const projected = projectAppendOnlyContext({ messages, chain, fallbackSummary: "fallback" });
    expect(projected).toHaveLength(4);
    expect(projected[1]).toMatchObject({ customType: APPEND_SEGMENT_CUSTOM_TYPE, display: false, content: "segment 1" });
    expect(projected[2]).toMatchObject({ customType: APPEND_TRAILING_CUSTOM_TYPE, display: false, content: "fallback" });
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: "branchSummary", summary: "fallback" });

    const duplicate = projectAppendOnlyContext({ messages: [messages[1], messages[1]], chain, fallbackSummary: "fallback" });
    expect(duplicate).toHaveLength(2);
  });

  test("uses exact no-window and context-window threshold policy", () => {
    expect(compactionThresholds(undefined, 1_000)).toEqual({ chainThreshold: 34_000, minimumSaving: 24_000 });
    expect(compactionThresholds(272_000, 12_000)).toEqual({
      contextWindow: 272_000,
      chainThreshold: 34_000,
      contextThreshold: 136_000,
      minimumSaving: 24_000,
      capacity: 260_000,
    });
    expect(compactionThresholds(Number.NaN)).toEqual({ chainThreshold: 34_000, minimumSaving: 24_000 });
  });

  test("does not claim full context without a trusted estimate", () => {
    const decision = decideAppendMode({ chainTokens: 40_000, rebaseChainTokens: 10_000, pressure: true });
    expect(decision.mode).toBe("append");
    expect(decision.fullContextTokens).toBeUndefined();
    expect(decideAppendMode({ manual: true, chainTokens: 10, rebaseChainTokens: 20 }).chainStart).toBe(true);
    expect(decideAppendMode({ overflow: true, chainTokens: 50, rebaseChainTokens: 20 }).mode).toBe("rebase");
  });
});
