// @ts-nocheck
import { beforeAll, describe, expect, it } from "bun:test";
import { buildCompactReport } from "../extensions/vcc-core/core/report";
import { prepareSessionSamples, readSourceStat, type SessionSample } from "./support/real-sessions";
import { loadSessionMessages } from "./support/load-session";

let samples: SessionSample[] = [];

beforeAll(async () => {
  samples = await prepareSessionSamples(2);
});

function syntheticLargeSession(): { messageCount: number; messages: any[] } {
  // Generate a deterministic large session (100 turns) when no real Pi sessions exist,
  // so CI still exercises large-session report/lineage code (reviewer finding: vacuous suite).
  const messages: any[] = [];
  for (let i = 0; i < 100; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `User prompt ${i}: fix auth token handling in src/auth.ts` }] });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `Thought ${i}` }],
      toolCalls: [{ name: "read", arguments: { path: `src/file${i}.ts` } }],
    });
    messages.push({ role: "toolResult", content: [{ type: "text", text: `file${i}.ts content line 1\nline 2` }], toolCallId: `call_${i}` });
  }
  return { messageCount: messages.length, messages };
}

describe("real session integration", () => {
  it("compiles copied large sessions without mutating originals", async () => {
    if (samples.length === 0) {
      const loaded = syntheticLargeSession();
      const report = buildCompactReport({ messages: loaded.messages as any });
      expect(loaded.messageCount).toBeGreaterThan(0);
      expect(report.summary.length).toBeGreaterThan(0);
      expect(report.summary).toContain("[");
      expect(report.compression.charsBefore).toBeGreaterThan(0);
      expect(report.recall.probes.length).toBeGreaterThan(0);
      return;
    }
    for (const sample of samples) {
      const before = await readSourceStat(sample);
      const loaded = loadSessionMessages(sample.copy);
      const report = buildCompactReport({ messages: loaded.messages });
      const after = await readSourceStat(sample);

      expect(loaded.messageCount).toBeGreaterThan(0);
      expect(loaded.skippedCount).toBeGreaterThanOrEqual(0);
      expect(report.summary.length).toBeGreaterThan(0);
      expect(report.summary).toContain("[");
      expect(report.before.preview.length).toBeGreaterThan(0);
      expect(report.after.summaryPreview.length).toBeGreaterThan(0);
      expect(report.compression.charsBefore).toBeGreaterThan(0);
      expect(report.recall.probes.length).toBeGreaterThan(0);
      expect(after).toEqual(before);
    }
  });

  it("uses read-only copied fixtures", () => {
    if (samples.length === 0) return;
    for (const sample of samples) {
      expect(sample.copy).not.toBe(sample.source);
      expect(sample.copy.includes("pi-vcc-sessions-")).toBe(true);
    }
  });
});
