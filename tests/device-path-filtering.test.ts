// @ts-nocheck
// Host-internal device URIs are not repository files.
//
// `xd://propose` is omp's plan-mode write device, `local://…` its plan artifact
// form. Both used to be classified as Modified files: they landed in
// `[Files And Changes]`, in the recall touched index, and as a brief one-liner
// `* write "xd://propose"` that carries no recoverable information. omp maps
// Write to `written` and merges it into modifiedFiles, so the hook-provided
// fileOps carries the device path too and seeds the same bogus listing.
import { describe, expect, test } from "bun:test";
import { extractPath, isFilesystemPath, PATH_KEYS } from "../extensions/vcc-core/core/tool-args";
import { extractFiles } from "../extensions/vcc-core/extract/files";
import { getFileIndicators, getTouchedFiles } from "../extensions/vcc-core/core/search-entries";
import { compileRanked } from "../extensions/vcc-core/core/summarize";

describe("isFilesystemPath", () => {
  test("accepts repository paths in every common spelling", () => {
    expect(isFilesystemPath("src/http/client.ts")).toBe(true);
    expect(isFilesystemPath("./src/http/client.ts")).toBe(true);
    expect(isFilesystemPath("/abs/path/to/file.ts")).toBe(true);
    expect(isFilesystemPath("rel.ts")).toBe(true);
    expect(isFilesystemPath("a/b.c/d-e_f.ts")).toBe(true);
    expect(isFilesystemPath("Makefile")).toBe(true);
  });

  test("rejects host device URIs", () => {
    for (const uri of ["xd://propose", "local://fix-retry-plan.md", "artifact://spill-1", "ssh://host/path", "proc://job/1", "mcp://server/resource"]) {
      expect(isFilesystemPath(uri)).toBe(false);
    }
  });

  test("rejects anything that is not a non-empty string", () => {
    for (const value of [undefined, null, 0, 5, true, {}, [], ""]) {
      expect(isFilesystemPath(value)).toBe(false);
    }
  });
});

describe("extractPath", () => {
  test("returns a repository path unchanged", () => {
    expect(extractPath({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(extractPath({ file_path: "a/b.ts" })).toBe("a/b.ts");
    expect(extractPath({ filePath: "c.ts" })).toBe("c.ts");
    expect(extractPath({ file: "d/e.ts" })).toBe("d/e.ts");
  });

  test("returns null for a lone device URI", () => {
    expect(extractPath({ path: "xd://propose" })).toBe(null);
    expect(extractPath({})).toBe(null);
    expect(extractPath({ pattern: "x" })).toBe(null);
  });

  test("skips the device URI and falls through to a later real path key", () => {
    // A device target must not shadow a real path carried alongside it.
    expect(extractPath({ path: "xd://propose", file_path: "a/b.ts" })).toBe("a/b.ts");
    expect(extractPath({ path: "artifact://x", file: "c.ts" })).toBe("c.ts");
  });

  test("rejects non-object input", () => {
    expect(extractPath(null)).toBe(null);
    expect(extractPath(undefined)).toBe(null);
    expect(extractPath(42)).toBe(null);
  });

  test("PATH_KEYS is unchanged by the filter", () => {
    expect(PATH_KEYS).toEqual(["path", "file_path", "filePath", "file"]);
  });
});

describe("extractFiles", () => {
  const toolCall = (name: string, args: Record<string, unknown>) => ({ kind: "tool_call", name, args });

  test("a device-URI write tool call is not a modified file", () => {
    const act = extractFiles([toolCall("write", { path: "xd://propose", content: "## Approach\n1. withRetry()\n" })], undefined);
    expect([...act.modified]).toEqual([]);
    expect([...act.read]).toEqual([]);
    expect([...act.created]).toEqual([]);
  });

  test("a real write tool call is still a modified file", () => {
    const act = extractFiles([toolCall("write", { path: "src/http/client.ts", content: "x" })], undefined);
    expect([...act.modified]).toEqual(["src/http/client.ts"]);
  });

  test("hook fileOps carrying a device URI is filtered from every category", () => {
    const act = extractFiles([], {
      readFiles: ["src/http/client.ts", "local://plan.md"],
      modifiedFiles: ["xd://propose", "tests/client.test.ts"],
      createdFiles: ["artifact://x", "new.ts"],
    } as never);
    expect([...act.read]).toEqual(["src/http/client.ts"]);
    expect([...act.modified]).toEqual(["tests/client.test.ts"]);
    expect([...act.created]).toEqual(["new.ts"]);
  });

  test("tool-call and fileOps paths merge without the device URI", () => {
    const act = extractFiles(
      [toolCall("read", { path: "src/a.ts" }), toolCall("write", { path: "xd://propose", content: "p" })],
      { readFiles: [], modifiedFiles: ["src/b.ts"], createdFiles: [] } as never,
    );
    expect([...act.read]).toEqual(["src/a.ts"]);
    expect([...act.modified]).toEqual(["src/b.ts"]);
  });
});

describe("getFileIndicators", () => {
  const call = (path: string) => ({ role: "assistant", content: [{ type: "toolCall", id: "c", name: "write", arguments: { path, content: "body text\nline two" } }] });

  test("a device URI yields no indicator", () => {
    expect(getFileIndicators(call("xd://propose"))).toEqual([]);
    expect(getFileIndicators(call("local://plan.md"))).toEqual([]);
  });

  test("a real path still yields an indicator with its line count", () => {
    const indicators = getFileIndicators(call("tests/client.test.ts"));
    expect(indicators).toHaveLength(1);
    expect(indicators[0].path).toBe("tests/client.test.ts");
    expect(indicators[0].lineCount).toBe(2);
  });

  test("no path key at all yields no indicator", () => {
    expect(getFileIndicators({ role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } }] })).toEqual([]);
    expect(getFileIndicators({ role: "assistant", content: "no content array" })).toEqual([]);
  });
});

describe("getTouchedFiles", () => {
  test("device URIs are excluded while real paths are kept", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/http/client.ts", content: "" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "write", arguments: { path: "xd://propose", content: "plan" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "edit", arguments: { path: "src/http/client.ts", oldText: "a", newText: "b" } }] },
    ];
    const rendered = messages.map((_, index) => ({ index }));
    const touched = getTouchedFiles(messages as never, rendered as never);
    expect(touched.map((t: { path: string }) => t.path)).toEqual(["src/http/client.ts"]);
    expect(touched).toHaveLength(1);
  });

  test("a branch made only of device writes produces an empty touched set", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "xd://propose", content: "plan" } }] },
    ];
    expect(getTouchedFiles(messages as never, messages.map((_, i) => ({ index: i })) as never)).toEqual([]);
  });
});

describe("compileRanked", () => {
  // compileRanked consumes host Message objects (not the persisted
  // {id,type,message} entry wrappers) plus their source indices.
  const entryToMessage = (entry: { message: unknown }) => entry.message;

  test("the ranked summary of a device-write branch has no device path", () => {
    const entries = [
      { message: { role: "user", content: [{ type: "text", text: "Add retry-with-backoff to the HTTP client, with tests." }] } },
      { message: { role: "assistant", content: [
        { type: "text", text: "Reading the client." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/http/client.ts" } },
      ] } },
      { message: { role: "toolResult", toolCallId: "c1", content: "214 lines; no retry." } },
      { message: { role: "assistant", content: [
        { type: "text", text: "Now writing the plan." },
        { type: "toolCall", id: "c2", name: "write", arguments: { path: "xd://propose", content: "## Approach\n1. withRetry()\n" } },
      ] } },
      { message: { role: "assistant", content: [
        { type: "text", text: "Then patch the client." },
        { type: "toolCall", id: "c3", name: "edit", arguments: { file_path: "tests/http/client.test.ts", oldText: "old", newText: "new" } },
      ] } },
    ];
    const summary = compileRanked({
      messages: entries.map(entryToMessage) as never,
      sourceIndices: entries.map((_, index) => index),
    });
    expect(summary).not.toContain("xd://propose");
    expect(summary).not.toContain("local://");
    expect(summary).toContain("src/http/client.ts");
    expect(summary).toContain("tests/http/client.test.ts");
    // The write tool call still appears, just without a bogus target.
    expect(summary).toContain("* write");
    expect(summary).not.toContain('write "xd:');
  });

  test("a real write still shows its path", () => {
    const entries = [
      { message: { role: "user", content: [{ type: "text", text: "Patch the client." }] } },
      { message: { role: "assistant", content: [
        { type: "text", text: "Writing." },
        { type: "toolCall", id: "c1", name: "write", arguments: { path: "src/http/client.ts", content: "export const fetchJson = () => {};" } },
      ] } },
    ];
    const summary = compileRanked({
      messages: entries.map(entryToMessage) as never,
      sourceIndices: entries.map((_, index) => index),
    });
    expect(summary).toContain('write "src/http/client.ts"');
  });
});
