// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAllMessages } from "../extensions/vcc-core/core/load-messages";

describe("loadAllMessages", () => {
  it("loads all message entries when no lineage filter is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-all-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        JSON.stringify({ type: "custom", id: "c1", customType: "x", data: {} }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
        JSON.stringify({ type: "message", id: "m3", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "ok" }] } }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = loadAllMessages(file, false);
      expect(loaded.rendered).toHaveLength(3);
      expect(loaded.rawMessages).toHaveLength(3);
      expect(loaded.rendered.map((e) => e.index)).toEqual([0, 1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters messages by allowed lineage entry IDs and preserves original message index", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-filter-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
        JSON.stringify({ type: "message", id: "m3", message: { role: "user", content: "u2" } }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = loadAllMessages(file, false, new Set(["m2"]));
      expect(loaded.rendered).toHaveLength(1);
      expect(loaded.rawMessages).toHaveLength(1);
      expect(loaded.rendered[0].index).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The loader's catch is a last resort, so one malformed content part must not
// reach it: doing so returned `{rendered:[],rawMessages:[]}` and silently
// blanked the ENTIRE session for every recall query and every #N ref.
describe("loadAllMessages: a malformed part must not blank the session", () => {
  const writeSession = (messages: unknown[]) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-malformed-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      [JSON.stringify({ type: "session", id: "s1" }), ...messages.map((m) => JSON.stringify(m))].join("\n") + "\n",
      "utf8",
    );
    return { dir, file };
  };

  it("keeps every entry when a content array holds a null part", () => {
    const { dir, file } = writeSession([
      { type: "message", id: "m1", message: { role: "user", content: "u1" } },
      { type: "message", id: "m2", message: { role: "assistant", content: [null, { type: "text", text: "fixed the parser" }] } },
      { type: "message", id: "m3", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "ok" }] } },
      { type: "message", id: "m4", message: { role: "user", content: "u2" } },
    ]);
    try {
      const loaded = loadAllMessages(file, false);
      expect(loaded.rendered).toHaveLength(4);
      expect(loaded.rawMessages).toHaveLength(4);
      expect(loaded.rendered.map((e) => e.index)).toEqual([0, 1, 2, 3]);
      expect(loaded.rendered[1].summary).toContain("fixed the parser");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps every entry when a toolCall carries no arguments", () => {
    const { dir, file } = writeSession([
      { type: "message", id: "m1", message: { role: "user", content: "u1" } },
      { type: "message", id: "m2", message: { role: "assistant", content: [{ type: "toolCall", name: "Read" }] } },
      { type: "message", id: "m3", message: { role: "user", content: "u2" } },
      { type: "message", id: "m4", message: { role: "user", content: "u3" } },
    ]);
    try {
      expect(loadAllMessages(file, false).rendered).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps every entry when a content value is a truthy non-array", () => {
    for (const bad of [{}, 42, true]) {
      const { dir, file } = writeSession([
        { type: "message", id: "m1", message: { role: "user", content: "u1" } },
        { type: "message", id: "m2", message: { role: "assistant", content: bad } },
        { type: "message", id: "m3", message: { role: "user", content: "u2" } },
        { type: "message", id: "m4", message: { role: "user", content: "u3" } },
      ]);
      try {
        const loaded = loadAllMessages(file, false);
        expect(loaded.rendered).toHaveLength(4);
        expect(loaded.rendered[1].summary).toBe("");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
