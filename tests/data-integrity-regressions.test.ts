// @ts-nocheck
import { describe, it, expect } from "bun:test";
import { filterNoise } from "../extensions/vcc-core/core/filter-noise.ts";
import { textParts, textOf } from "../extensions/vcc-core/core/content.ts";
import { normalize } from "../extensions/vcc-core/core/normalize.ts";
import { extractCommits } from "../extensions/vcc-core/extract/commits.ts";
import { compile } from "../extensions/vcc-core/core/summarize.ts";
import { escapePathCommas, splitEscapedPathList } from "../extensions/vcc-core/extract/files.ts";
import { buildBriefSections } from "../extensions/vcc-core/core/brief.ts";
import { searchEntriesDetailed } from "../extensions/vcc-core/core/search-entries.ts";

const bashCall = (command: string) => ({ kind: "tool_call", name: "bash", args: { command } });
const bashResult = (text: string) => ({ kind: "tool_result", name: "bash", text });

describe("filterNoise: noise phrases are matched whole, not as substrings", () => {
  it("keeps a user message that merely QUOTES a harness noise string", () => {
    const blocks = [
      { kind: "user", text: "Fix the startup copy. It currently says: Continue from where you left off.", sourceIndex: 0 },
      { kind: "user", text: "Also never commit directly to main.", sourceIndex: 1 },
    ];
    const out = filterNoise(blocks);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("Fix the startup copy. It currently says: Continue from where you left off.");
    expect(out[0].sourceIndex).toBe(0);
    expect(out[1].sourceIndex).toBe(1);
  });

  it("still drops a standalone harness noise message", () => {
    for (const text of ["Continue from where you left off.", "No response requested.", "IMPORTANT: TodoWrite was not called yet."]) {
      expect(filterNoise([{ kind: "user", text, sourceIndex: 0 }])).toHaveLength(0);
    }
    // ...and a noise phrase behind a leading harness wrapper.
    expect(filterNoise([{ kind: "user", text: "<system-reminder>x</system-reminder>\nNo response requested.", sourceIndex: 0 }])).toHaveLength(0);
  });
});

describe("malformed message content degrades instead of throwing", () => {
  it("textParts/textOf tolerate null elements and non-array content", () => {
    expect(textParts([null])).toEqual([]);
    expect(textParts([null, { type: "text", text: "hi" }])).toEqual(["hi"]);
    expect(textParts({ type: "text", text: "x" })).toEqual([]);
    expect(textOf({ type: "text", text: "x" })).toBe("");
  });

  it("normalize tolerates null parts and non-array content", () => {
    expect(normalize([{ role: "assistant", content: [null, { type: "text", text: "hi" }] }], [0]))
      .toEqual([{ kind: "assistant", text: "hi", sourceIndex: 0 }]);
    expect(normalize([{ role: "user", content: [null] }], [0]))
      .toEqual([{ kind: "user", text: "", sourceIndex: 0 }]);
    expect(normalize([{ role: "assistant", content: {} }], [0])).toEqual([]);
  });

  it("a toolCall part without an arguments object never yields undefined args", () => {
    const out = normalize([{ role: "assistant", content: [{ type: "toolCall", name: "bash" }] }], [0]);
    expect(out).toHaveLength(1);
    expect(out[0].args).toEqual({});
  });

  it("a full compile survives a malformed content array (handler must not throw)", () => {
    const out = compile({
      messages: [
        { role: "user", content: [null, { type: "text", text: "real work" }] },
        { role: "assistant", content: [null, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
      ],
      sourceIndices: [0, 1],
    });
    expect(out).toContain("real work");
  });
});

describe("briefOf: a headerless previous summary is not truncated by its own markdown rule", () => {
  const first = () => compile({
    messages: [
      { role: "user", content: "ok" },
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls -la" } }] },
      { role: "toolResult", toolName: "bash", content: "a\nb" },
      { role: "assistant", content: "Findings:\n\n---\n\nThe secret sauce is 42." },
    ],
    sourceIndices: [0, 1, 2, 3],
  });

  it("emits a headerless summary that still carries the whole brief", () => {
    const prev = first();
    expect(prev.startsWith("[Session Goal]")).toBe(false);
    expect(prev).toContain("ok (#0)");
    expect(prev).toContain("ls -la");
  });

  it("merging onto it keeps every earlier line", () => {
    const second = compile({
      messages: [{ role: "user", content: "next" }],
      previousSummary: first(),
      sourceIndices: [0],
    });
    expect(second).toContain("ok (#0)");
    expect(second).toContain("ls -la");
    expect(second).toContain("The secret sauce is 42.");
    expect(second).toContain("next (#0)");
  });
});

describe("extractCommits: quoting forms and hash pairing", () => {
  it("recognises -am, -m\"...\", bare unquoted and --message forms", () => {
    for (const cmd of [
      'git commit -am "wip"',
      'git commit -m"wip"',
      "git commit -m wip",
      'git commit --message "wip"',
      'git commit --message="wip"',
      "git commit --no-verify -m wip",
    ]) {
      expect(extractCommits([bashCall(cmd)])).toEqual([{ hash: undefined, message: "wip" }]);
    }
  });

  it("does not read a longer flag that ends in m as -am", () => {
    expect(extractCommits([bashCall("git commit --amend --no-edit")])).toEqual([]);
    expect(extractCommits([bashCall("git commit --amend -m 'real'")])).toEqual([{ hash: undefined, message: "real" }]);
  });

  it("captures a full 40-character SHA", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(extractCommits([bashCall('git commit -m "x"'), bashResult(`[main ${sha}] x`)]))
      .toEqual([{ hash: sha, message: "x" }]);
    expect(extractCommits([bashCall('git commit -m "x"'), bashResult(`${sha}..${sha}`)]))
      .toEqual([{ hash: sha, message: "x" }]);
  });

  it("never adopts a hash from a different tool's result", () => {
    const blocks = [
      bashCall('git commit -m "real work"'),
      bashCall("git log --oneline"),
      { kind: "tool_result", name: "Read", text: "f0a1b2c deadbeefcafebabe" },
      bashResult("[main a1b2c3d] real work"),
    ];
    expect(extractCommits(blocks)).toEqual([{ hash: undefined, message: "real work" }]);
  });
});

describe("Files And Changes: filenames containing commas survive the merge", () => {
  it("escapes on render and splits only on unescaped commas", () => {
    expect(escapePathCommas("a,b.ts")).toBe("a\\,b.ts");
    expect(splitEscapedPathList("a\\,b.ts, ok.ts")).toEqual(["a,b.ts", "ok.ts"]);
    expect(splitEscapedPathList(escapePathCommas("x,y,z"))).toEqual(["x,y,z"]);
    expect(splitEscapedPathList("")).toEqual([]);
  });

  it("round-trips a comma path through a second compaction without splitting it", () => {
    const fileOps = { modifiedFiles: ["/repo/src/a,b.ts", "/repo/src/ok.ts"] };
    const first = compile({ messages: [{ role: "user", content: "edit" }], fileOps, sourceIndices: [0] });
    expect(first.match(/^- Modified.*$/m)?.[0]).toBe("- Modified (in /repo/src/): a\\,b.ts, ok.ts");

    const second = compile({
      messages: [{ role: "user", content: "again" }],
      previousSummary: first,
      fileOps: {},
      sourceIndices: [0],
    });
    expect(second.match(/^- Modified.*$/m)?.[0]).toBe("- Modified (in /repo/src/): a\\,b.ts, ok.ts");
  });
});

describe("recall: reserving cap room for literal hits keeps truncation honest", () => {
  it("reports truncated and the real total when the first pass was already capped", () => {
    const TAB = "\t";
    const entries: any[] = [];
    const messages: any[] = [];
    for (let i = 0; i < 200; i++) {
      const text = `path C:${TAB}emp entry ${i}`; // matches the REGEX reading (\t = tab)
      entries.push({ index: i, role: "user", summary: text });
      messages.push({ role: "user", content: text });
    }
    const literalText = "path C:\\temp\\build.log"; // matches only the LITERAL reading
    entries.push({ index: 200, role: "user", summary: literalText });
    messages.push({ role: "user", content: literalText });

    const res = searchEntriesDetailed(entries, messages, "path C:\\temp");
    expect(res.hits.length).toBeLessThanOrEqual(50);
    expect(res.truncated).toBe(true);
    expect(res.totalBeforeCap).toBeGreaterThan(50);
    // The literal-only hit must survive the cap.
    expect(res.hits.some((h: any) => h.summary.includes("build.log"))).toBe(true);
  });

  it("a literal pass large enough to reach the cap cannot evict the whole first pass", () => {
    const entries: any[] = [];
    const messages: any[] = [];
    for (let i = 0; i < 200; i++) {
      const text = `fix issue ${i} in the build`;
      entries.push({ index: i, role: "user", summary: text });
      messages.push({ role: "user", content: text });
    }
    for (let k = 0; k < 50; k++) {
      const text = `see C:\\temp\\build.log #${k}`;
      entries.push({ index: 200 + k, role: "user", summary: text });
      messages.push({ role: "user", content: text });
    }
    const res = searchEntriesDetailed(entries, messages, "fix C:\\temp\\build.log");
    const literal = res.hits.filter((h: any) => h.summary.includes("build.log")).length;
    // Both readings stay represented instead of the reservation clearing the
    // first pass out entirely.
    expect(res.hits.length - literal).toBeGreaterThan(0);
    expect(literal).toBeGreaterThan(0);
    expect(res.truncated).toBe(true);
  });
});

describe("brief: assistant prose is never treated as a tool line", () => {
  const proseThenCalls = (paths: string[]) => {
    const blocks: any[] = [{ kind: "assistant", text: `Summary so far:\n* Read "${paths[0]}.ts"`, sourceIndex: 0 }];
    paths.forEach((p, i) => {
      blocks.push({ kind: "tool_call", name: "Read", args: { path: `${p}.ts` }, sourceIndex: 1 + i * 2 });
      blocks.push({ kind: "tool_result", name: "Read", text: "ok", sourceIndex: 2 + i * 2 });
    });
    return blocks;
  };
  const assistantSection = (blocks: any[]) =>
    buildBriefSections(blocks).find((s) => s.header === "[assistant]")!;

  it("does not merge a real call into an identical prose line (no invented x2)", () => {
    const sec = assistantSection(proseThenCalls(["auth"]));
    expect(sec.lines.some((l) => /x2$/.test(l))).toBe(false);
    // Only the one real call is a tool line; the prose line is not.
    expect(sec.toolLineIdx.size).toBe(1);
  });

  it("keeps provenance for every real call so the per-turn cap still fires", () => {
    const sec = assistantSection(proseThenCalls(["file8", "file0", "file1", "file2", "file3", "file4", "file5", "file6", "file7"]));
    expect(sec.lines.some((l) => /x2$/.test(l))).toBe(false);
    // 9 real calls -> 8 kept + the synthetic marker line.
    expect(sec.toolLineIdx.size).toBe(9);
    expect(sec.lines.some((l) => l.includes("earlier tool-call entries omitted"))).toBe(true);
  });
});
