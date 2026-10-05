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

// The merge filter is STRUCTURAL. It used to also reject any line containing
// "<skill", but the writer's collapse is line-anchored, so an ordinary
// instruction mentioning a skill mid-line survived extraction and was then
// silently deleted on the next merge cycle.
describe("Session Goal: a line mentioning a skill survives the merge", () => {
  // The tag is CLOSED: `collapseSkillText` treats an unclosed `<skill ...>` as
  // extending to the end of the string, which is the injected-context shape.
  const INSTRUCTION = 'always run the <skill name="lint">lint rules</skill> checks before committing';
  const first = () => compile({
    messages: [{ role: "user", content: INSTRUCTION }],
    sourceIndices: [0],
  });

  it("keeps an instruction containing a mid-line skill tag", () => {
    expect(first()).toContain("before committing");
  });

  it("collapses the tag instead of leaking it into the section", () => {
    const out = first();
    expect(out).toContain("[skill: lint]");
    expect(out).not.toContain("<skill");
  });

  it("still carries the line through a second compaction cycle", () => {
    const second = compile({
      messages: [{ role: "user", content: "next" }],
      previousSummary: first(),
      sourceIndices: [0],
    });
    expect(second).toContain("before committing");
    expect(second).toContain("[skill: lint]");
    expect(second).not.toContain("<skill");
  });

  // The block-scoped collapse treats an UNTERMINATED opening tag as extending
  // to the end of the input, so applying it per line deleted the rest of the
  // instruction. The writers and the merge both use the line-scoped form.
  it("keeps the instruction tail when a skill tag is unterminated", () => {
    const out = compile({
      messages: [{ role: "user", content: 'always run the <skill name="lint"> checks before committing' }],
      sourceIndices: [0],
    });
    expect(out).toContain("[skill: lint]");
    expect(out).toContain("checks before committing");
    expect(out).not.toContain("<skill");
  });

  it("still drops a CLOSED block body while keeping the tail", () => {
    const out = compile({
      messages: [{ role: "user", content: 'always run the <skill name="lint">body rules</skill> checks before committing' }],
      sourceIndices: [0],
    });
    expect(out).toContain("[skill: lint]");
    expect(out).toContain("checks before committing");
    expect(out).not.toContain("body rules");
    expect(out).not.toContain("<skill");
  });

  // A summary written by the PRE-fix writer can still carry a raw mid-line tag.
  // The removed content-blind guard was the only thing that scrubbed it, so the
  // merge collapsed nothing and the raw tag would persist forever.
  it("collapses a legacy raw tag on the merged previous side", () => {
    const merged = compile({
      messages: [{ role: "user", content: "next" }],
      // A well-formed previous summary: the header section plus the brief
      // separator, or the merge path is never reached.
      previousSummary: '[Session Goal]\n- always run the <skill name="lint"> checks before committing\n\n---\n\n[user]\nOriginal goal',
      sourceIndices: [0],
    });
    expect(merged).toContain("[skill: lint]");
    expect(merged).toContain("checks before committing");
    expect(merged).not.toContain("<skill");
  });

  it("still drops a bare skill tag that is not part of a real instruction", () => {
    const out = compile({
      messages: [{ role: "user", content: '<skill name="lint">\nbody\n</skill>' }],
      sourceIndices: [0],
    });
    expect(out).not.toContain("<skill");
  });
});

describe("extractCommits: host casing and the bashExecution shape", () => {
  it("matches the bash tool name case-insensitively", () => {
    const sha = "a1b2c3d";
    for (const name of ["bash", "Bash", "BASH"]) {
      expect(extractCommits([
        { kind: "tool_call", name, args: { command: 'git commit -m "real work"' } },
        { kind: "tool_result", name, text: `[main ${sha}] real work` },
      ])).toEqual([{ hash: sha, message: "real work" }]);
    }
  });

  it("reads a kind:'bash' block, whose own output carries the hash", () => {
    expect(extractCommits([
      { kind: "bash", command: 'git commit -m "feat: add parser"', output: "[main 9f2a1b3] feat: add parser" },
    ])).toEqual([{ hash: "9f2a1b3", message: "feat: add parser" }]);
  });

  it("reports a kind:'bash' commit with no hash when the output has none", () => {
    expect(extractCommits([
      { kind: "bash", command: 'git commit -m "wip"', output: "nothing to commit, working tree clean" },
    ])).toEqual([{ hash: undefined, message: "wip" }]);
  });

  it("does not pair a kind:'bash' commit with a later tool_result", () => {
    expect(extractCommits([
      { kind: "bash", command: 'git commit -m "wip"', output: "" },
      { kind: "tool_result", name: "bash", text: "[main deadbee] unrelated" },
    ])).toEqual([{ hash: undefined, message: "wip" }]);
  });

  it("normalizes a host bashExecution message into an extractable commit", () => {
    const blocks = normalize([
      { role: "bashExecution", command: 'git commit -m "feat: port"', output: "[main abc1234] feat: port" },
    ] as never, [0]);
    expect(extractCommits(blocks)).toEqual([{ hash: "abc1234", message: "feat: port" }]);
  });
});

describe("Files And Changes: a newline inside a path cannot corrupt the section", () => {
  it("normalizes newlines on render and keeps the list splittable", () => {
    expect(escapePathCommas("/repo/src/a\nb.ts")).toBe("/repo/src/a b.ts");
    expect(escapePathCommas("/repo/a\r\nb.ts")).toBe("/repo/a b.ts");
    // Compose the list the way renderFileCategoryLines does: each path escaped,
    // then joined on ", ".
    const rendered = [escapePathCommas("/repo/src/a\nb.ts"), escapePathCommas("/repo/ok.ts")].join(", ");
    expect(splitEscapedPathList(rendered)).toEqual(["/repo/src/a b.ts", "/repo/ok.ts"]);
  });

  it("round-trips a newline path through a second compaction without losing the tail", () => {
    const fileOps = { modifiedFiles: ["/repo/src/bro\nken.ts", "/repo/src/ok.ts"] };
    const first = compile({ messages: [{ role: "user", content: "edit" }], fileOps, sourceIndices: [0] });
    expect(first).toContain("ok.ts");

    const second = compile({
      messages: [{ role: "user", content: "again" }],
      previousSummary: first,
      fileOps: {},
      sourceIndices: [0],
    });
    expect(second).toContain("ok.ts");
    expect(second).not.toContain("/repo/src/bro\n");
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

  // The private `toolLineIdx` set is bookkeeping; these assert the RENDERED
  // result instead, which is what a reader of the summary actually sees.
  it("does not merge a real call into an identical prose line (no invented x2)", () => {
    const sec = assistantSection(proseThenCalls(["auth"]));
    expect(sec.lines.some((l) => /x2$/.test(l))).toBe(false);
    // Exactly ONE line is a merged call+result — the real call. The prose line
    // that happens to read `* Read "auth.ts"` carries no result suffix, so it
    // was never classified as a tool line.
    const withResult = sec.lines.filter((l) => l.includes("result #"));
    expect(withResult).toHaveLength(1);
    expect(withResult[0]).toBe('* Read "auth.ts" (#1, result #2)');
    expect(sec.lines).toEqual([
      "Summary so far:",
      '* Read "auth.ts" (#0)',
      '* Read "auth.ts" (#1, result #2)',
    ]);
  });

  it("keeps provenance for every real call so the per-turn cap still fires", () => {
    const sec = assistantSection(proseThenCalls(["file8", "file0", "file1", "file2", "file3", "file4", "file5", "file6", "file7"]));
    expect(sec.lines.some((l) => /x2$/.test(l))).toBe(false);
    // 9 real calls: the cap keeps 8, and each survivor still carries its own
    // result — which is what proves provenance survived the cap.
    expect(sec.lines.filter((l) => l.includes("result #"))).toHaveLength(8);
    expect(sec.lines).toContain("* (1 earlier tool-call entries omitted)");
    // The prose line is untouched by the cap.
    expect(sec.lines).toContain('* Read "file8.ts" (#0)');
  });
});
