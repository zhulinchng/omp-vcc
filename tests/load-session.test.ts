// @ts-nocheck
import { describe, expect, it, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadSessionMessages } from "./support/load-session";
import { readSourceStat } from "./support/real-sessions";

const dir = mkdtempSync(join(tmpdir(), "omp-vcc-load-session-"));
afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("loadSessionMessages", () => {
  it("parses message entries from JSONL", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "yo" } }),
      "",
    ].join("\n"));
    const loaded = loadSessionMessages(file);
    expect(loaded.messageCount).toBe(2);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0].role).toBe("user");
  });

  it("skips non-message entries and garbage lines", () => {
    const file = join(dir, "mixed.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      "not json {{{",
      JSON.stringify({ type: "compaction", firstKeptEntryId: "x" }),
      JSON.stringify({ type: "message" }),
    ].join("\n"));
    const loaded = loadSessionMessages(file);
    expect(loaded.messageCount).toBe(1);
    expect(loaded.messages).toHaveLength(1);
  });

  it("returns empty on missing file", () => {
    const loaded = loadSessionMessages(join(dir, "does-not-exist.jsonl"));
    expect(loaded).toEqual({ messageCount: 0, skippedCount: 0, messages: [] });
  });

  it("readSourceStat passes size and mtime through", async () => {
    await expect(readSourceStat({ source: "s", copy: "c", size: 42, mtimeMs: 7 }))
      .resolves.toEqual({ size: 42, mtimeMs: 7 });
  });
});
