// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { buildOwnCut, resolveSmartKeepUserTurns } from "../extensions/vcc-core/hook";
import { compileRanked } from "../extensions/vcc-core/core/summarize";
import { userMsg, assistantText } from "./fixtures";
import { calibrateCharsPerToken, collectUsageStats } from "../extensions/vcc-core/core/token-estimate";
const NOTE_SENTINEL = "to search for prior work, decisions, and context";

const countNotes = (summary: string): number => summary.split(NOTE_SENTINEL).length - 1;

const cycleMessages = (tag: string) => [
  userMsg(`${tag} implement auth refresh`),
  assistantText(`${tag} implemented token refresh in src/auth.ts`),
];

describe("compaction-gaps — RECALL_NOTE dedup", () => {
  it("chains 3 compactions with exactly one trailing note", () => {
    const s1 = compileRanked({ messages: cycleMessages("first") });
    expect(countNotes(s1)).toBe(1);
    const s2 = compileRanked({ messages: cycleMessages("second"), previousSummary: s1 });
    expect(countNotes(s2)).toBe(1);
    const s3 = compileRanked({ messages: cycleMessages("third"), previousSummary: s2 });
    expect(countNotes(s3)).toBe(1);
    expect(s3.trimEnd().endsWith("Do not redo work already completed.")).toBe(true);
  });

  it("strips a legacy wrapped note from previousSummary", () => {
    const wrapped =
      "Use `vcc_recall` to search for prior work, decisions, and context from\nbefore this summary. Do not redo work already completed.";
    const prev = `[Session Goal]\n- Ship auth\n\n---\n\nprior brief line\n\n---\n\n${wrapped}`;
    const out = compileRanked({ messages: cycleMessages("fresh"), previousSummary: prev });
    expect(countNotes(out)).toBe(1);
  });
});

describe("compaction-gaps — section tag anchoring", () => {
  const fresh = () => [
    userMsg("ship the auth refresh"),
    assistantText("shipped auth refresh, touched src/auth.ts"),
  ];

  it("ignores mid-line [Tag] inside a value line", () => {
    const prev =
      `[Session Goal]\n- Fix [Commits] parser edge case\n- Ship auth\n\n` +
      `[Commits]\n- abc123 fix parser\n\n---\n\nprior brief`;
    const out = compileRanked({ messages: fresh(), previousSummary: prev });
    expect(out).toContain("- abc123 fix parser");
    expect(out).toContain("- Fix [Commits] parser edge case");
    // Goal line must not leak into the merged Commits section.
    const commits = out.slice(out.lastIndexOf("[Commits]")).split("---")[0];
    expect(commits).toContain("abc123 fix parser");
    expect(commits).not.toContain("Ship auth");
  });
  it("does not parse a line-start [Tag] inside the brief as a section", () => {
    const prev =
      `[Session Goal]\n- Ship auth\n\n---\n\nsome prior work\n[Session Goal]\n- hallucinated goal`;
    const out = compileRanked({ messages: fresh(), previousSummary: prev });
    // Headers region must hold exactly one Session Goal section without the ghost line
    // (the raw brief transcript still preserves the original line verbatim).
    const head = out.split("\n\n---\n\n")[0];
    expect(head.match(/\[Session Goal\]/g)?.length ?? 0).toBe(1);
    expect(head).not.toContain("hallucinated goal");
  });
});

describe("compaction-gaps — oversized keep keeps the tail", () => {
  // Entry shape mirrors tests/before-compact.test.ts.
  const m = (id: string, role: "user" | "assistant", content = "x") => ({
    id,
    type: "message",
    message: { role, content },
  });
  const twoTurns = () => [
    m("u1", "user", "one"),
    m("a1", "assistant", "reply one"),
    m("u2", "user", "two"),
    m("a2", "assistant", "reply two"),
  ];

  it("keep == total turns keeps all turns instead of compact-all", () => {
    const r = buildOwnCut(twoTurns(), 2, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u1");
    expect(r.messages).toHaveLength(0);
    expect(r.keptUserTurns).toBe(2);
    expect(r.totalUserTurns).toBe(2);
    expect(r.keepFallbackToCompactAll).toBe(false);
  });

  it("huge keep keeps all turns instead of compact-all", () => {
    const r = buildOwnCut(twoTurns(), 10 ** 30, true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u1");
    expect(r.keptUserTurns).toBe(2);
    expect(r.keepFallbackToCompactAll).toBe(false);
  });

  it("keep == total with pre-first-user content still summarizes the prefix", () => {
    const entries = [
      m("a0", "assistant", "autonomous preamble"),
      ...twoTurns(),
    ];
    const r = buildOwnCut(entries, 2, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(false);
    expect(r.firstKeptEntryId).toBe("u1");
    expect(r.messages).toHaveLength(1);
    expect(r.keptUserTurns).toBe(2);
  });

  it("no user messages still compacts all (autonomous explicit)", () => {
    const r = buildOwnCut(
      [m("a1", "assistant", "a"), m("a2", "assistant", "b"), m("a3", "assistant", "c")],
      2,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compactAll).toBe(true);
    expect(r.firstKeptEntryId).toBe("");
  });
});

describe("compaction-gaps — custom_message tail measurement", () => {
  const m = (id: string, role: "user" | "assistant", content = "x") => ({
    id,
    type: "message",
    message: { role, content },
  });
  // ~N tokens at the 4 chars/token heuristic.
  const tokenContent = (n: number): string => "a".repeat(n * 4);

  it("fat custom_message tail blocks smart-keep growth like message content", () => {
    const entries = [
      m("u1", "user", tokenContent(3)),
      m("a1", "assistant", tokenContent(3)),
      m("u2", "user", tokenContent(3)),
      m("a2", "assistant", tokenContent(3)),
      m("u3", "user", tokenContent(3)),
      m("a3", "assistant", tokenContent(3)),
      // custom_message entries join the live window via toLiveMessage.
      { id: "c1", type: "custom_message", customType: "test-memo", content: tokenContent(30), timestamp: Date.now() },
    ];
    const r = resolveSmartKeepUserTurns({
      branchEntries: entries,
      requestedKeepUserTurns: null,
      explicit: false,
      smartKeepTail: true,
      minTokens: 10,
      maxTokens: 40,
    });
    // Tail = u2+a2+c1 = 36 tokens > min 10 -> no growth. (Buggy: custom missed,
    // tail read as 6 tokens -> grew to keep:2.)
    expect(r.keepUserTurns).toBe(1);
    expect(r.smartAdjusted).toBe(false);
  });
});

describe("compaction-gaps — files section cross-cycle survival", () => {
  // Long absolute paths: the "- Modified: ..." line exceeds the 120-col wrap,
  // exercising continuation-line rejoining in the merge.
  const twelve = Array.from(
    { length: 12 },
    (_, i) => `/repo/src/modules/authentication/refresh-handler-${String(i).padStart(2, "0")}.ts`,
  );
  const msgs = (tag: string) => [
    userMsg(`${tag} touch auth handlers`),
    assistantText(`${tag} updated the refresh handlers`),
  ];
  const withFiles = (tag: string, files: string[]) =>
    compileRanked({ messages: msgs(tag), fileOps: { modifiedFiles: files } });

  it("12 modified files survive 3 compactions with names intact", () => {
    const s1 = withFiles("first", twelve);
    const s2 = compileRanked({ messages: msgs("second"), previousSummary: s1 });
    const s3 = compileRanked({ messages: msgs("third"), previousSummary: s2 });
    // Display collapses to "(in prefix)" form; every basename must survive.
    expect(s3).toContain("(in /repo/src/modules/authentication/)");
    for (const f of twelve) {
      expect(s3).toContain(f.slice("/repo/src/modules/authentication/".length));
    }
  });

  it("20 flat names then grouped overflow, not a bare lossy count", () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `/repo/src/modules/authentication/refresh-handler-${String(i).padStart(2, "0")}.ts`,
    );
    const out = withFiles("many", many);
    expect(out).toContain("more under /repo/src/modules/authentication/");
    expect(out).not.toMatch(/\(\+\d+ more\)(?! under)/);
    for (const f of many) {
      expect(out).toContain(f.slice("/repo/src/modules/authentication/".length));
    }
  });
});

describe("compaction-gaps — hard-break path survival", () => {
  it("a single-token path longer than the wrap width survives cycles byte-identical", () => {
    const long = `/repo/src/${"a".repeat(130)}.ts`;
    const msgs = (tag: string) => [
      userMsg(`${tag} touch the long file`),
      assistantText(`${tag} updated it`),
    ];
    const s1 = compileRanked({ messages: msgs("one"), fileOps: { modifiedFiles: [long] } });
    const s2 = compileRanked({ messages: msgs("two"), previousSummary: s1 });
    const s3 = compileRanked({ messages: msgs("three"), previousSummary: s2 });
    // Display always rewraps a >120-char token, so compare at the logical
    // level: hard-break markers rejoin without a space. Pre-fix the merge
    // rejoined with a space, corrupting the path.
    const logical = (s: string) => s.replace(/\\\n[ \t]*/g, "").replace(/\n[ \t]+/g, " ");
    expect(logical(s1)).toContain(long);
    expect(logical(s2)).toContain(long);
    expect(logical(s3)).toContain(long);
  });
});

describe("compaction-gaps — grouped file overflow", () => {
  const files = (n: number, dir = "/repo/src/modules/authentication") =>
    Array.from({ length: n }, (_, i) => `${dir}/refresh-handler-${String(i).padStart(2, "0")}.ts`);
  const msgs = (tag: string) => [
    userMsg(`${tag} touch handlers`),
    assistantText(`${tag} updated them`),
  ];

  it("25 files survive 3 cycles via grouped overflow, not a bare count", () => {
    const twentyFive = files(25);
    const s1 = compileRanked({ messages: msgs("one"), fileOps: { modifiedFiles: twentyFive } });
    // Overflow names are preserved under directory groups, not dropped.
    expect(s1).toContain("more under /repo/src/modules/authentication/");
    const s2 = compileRanked({ messages: msgs("two"), previousSummary: s1 });
    const s3 = compileRanked({ messages: msgs("three"), previousSummary: s2 });
    for (const f of twentyFive) {
      expect(s3).toContain(f.slice("/repo/src/modules/authentication/".length));
    }
  });

  it("overflow past the total cap degrades to an honest bare count", () => {
    const many = files(120);
    const base = (f: string) => f.slice("/repo/src/modules/authentication/".length);
    const s1 = compileRanked({ messages: msgs("many"), fileOps: { modifiedFiles: many } });
    expect(s1).toContain(base(many[0]));
    expect(s1).toContain(base(many[99]));
    expect(s1).not.toContain(base(many[119]));
    expect(s1).toContain("(+20 more)");
  });
});

describe("compaction-gaps — custom content reaches the brief", () => {
  const custom = (content: string) => ({ role: "custom", customType: "memory-inject", content });

  it("custom-only input compiles to a non-empty summary carrying the text", () => {
    const out = compileRanked({ messages: [custom("INJECTED_CTX_CUSTOM")] });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("INJECTED_CTX_CUSTOM");
  });

  it("custom content survives a chained compaction", () => {
    const s1 = compileRanked({ messages: [custom("INJECTED_CTX_CUSTOM"), userMsg("go")] });
    const s2 = compileRanked({ messages: [userMsg("next")], previousSummary: s1 });
    expect(s2).toContain("INJECTED_CTX_CUSTOM");
  });
});
describe("compaction-gaps — wrapped value-line survival", () => {
  it("a goal line longer than the wrap width merges whole", () => {
    const goal = "Refactor the authentication refresh flow to handle concurrent token expiry across all active sessions gracefully";
    const prev = `[Session Goal]\n- ${goal}\n\n---\n\nprior brief`;
    const out = compileRanked({ messages: [userMsg("continue the work")], previousSummary: prev });
    expect(out).toContain(goal);
  });
});

describe("compaction-gaps — headerless brief merge", () => {
  it("a headerless previous summary still contributes its brief", () => {
    // Sessions with no goals/files/commits compile to brief-only summaries.
    // Stripping the trailing note must not orphan that brief (briefOf found
    // nothing after the only separator, so the merge went empty).
    const filler = (tag: string) => [
      userMsg(`${tag} ` + "x".repeat(200)),
      assistantText(`${tag} ` + "y".repeat(200)),
    ];
    const s1 = compileRanked({ messages: filler("first") });
    expect(s1.split("\n\n---\n\n").length).toBe(2);
    const s2 = compileRanked({ messages: filler("second"), previousSummary: s1 });
    expect(s2.length).toBeGreaterThan(0);
    expect(s2).toContain("second");
    // Previous brief tail survives alongside fresh brief.
    expect(s2).toContain("first");
  });
});
describe("compaction-gaps — usage-stats calibration guards", () => {
  const latin = "the quick brown fox jumps over the lazy dog. ".repeat(40);
  const cjk = "敏捷的棕色狐狸跳过了懒惰的狗，上下文压缩需要准确的估计。".repeat(20);

  it("latin content with overhead-dominated usage falls back to 4", () => {
    const s = collectUsageStats([
      { role: "user", content: latin, usage: { input: 40000, output: 0 } },
    ] as any);
    expect(s.calibration.charsPerToken).toBe(4);
  });

  it("cjk content with undercounted usage falls back to 2", () => {
    // ~540 chars over 100 tokens (raw 5.4): trusting raw overestimates cpt
    // (under-compaction). Pre-fix this calibrated to 5.4.
    const s = collectUsageStats([
      { role: "user", content: cjk, usage: { input: 100, output: 0 } },
    ] as any);
    expect(s.calibration.charsPerToken).toBe(2);
  });
});

describe("compaction-gaps — calibration slice/tokens mismatch guards", () => {
  const latin = "the quick brown fox jumps over the lazy dog. ".repeat(40);
  const cjk = "敏捷的棕色狐狸跳过了懒惰的狗，上下文压缩需要准确的估计。".repeat(40);

  it("latin slice with overhead-dominated tokens falls back to 4", () => {
    // Slice chars / full-context tokens: raw 0.1 would clamp to 2 and halve
    // every token estimate (over-compaction). The Latin prior restores 4.
    expect(calibrateCharsPerToken(4000, 40000, latin).charsPerToken).toBe(4);
  });

  it("cjk slice with undercounted tokens falls back to 2", () => {
    // Raw 3.75 contradicts the CJK prior (~1.5-2): tokensBefore undercounts
    // the slice, so trusting raw would shrink estimates (under-compaction).
    expect(calibrateCharsPerToken(1500, 400, cjk).charsPerToken).toBe(2);
  });

  it("legit dense latin ratio is trusted", () => {
    expect(calibrateCharsPerToken(12000, 4000, latin).charsPerToken).toBe(3);
  });

  it("cjk slice with overhead-dominated tokens still clamps, never heuristic", () => {
    // Raw 0.1 on CJK: the floor still applies (no evidence against it).
    expect(calibrateCharsPerToken(400, 4000, cjk).charsPerToken).toBe(2);
  });

  it("no sample keeps legacy clamp behavior", () => {
    expect(calibrateCharsPerToken(4000, 40000).charsPerToken).toBe(2);
    expect(calibrateCharsPerToken(1500, 400).charsPerToken).toBe(3.75);
  });
});

describe("compaction-gaps — overflow edge cases", () => {
  const msgs = (tag: string) => [
    userMsg(`${tag} touch files`),
    assistantText(`${tag} updated them`),
  ];
  const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);

  it("overflow groups span multiple directories and survive a cycle", () => {
    const a = Array.from({ length: 25 }, (_, i) => `/repo/src/a/mod-${String(i).padStart(2, "0")}.ts`);
    const b = Array.from({ length: 10 }, (_, i) => `/repo/tests/b/spec-${String(i).padStart(2, "0")}.ts`);
    const all = [...a, ...b];
    const s1 = compileRanked({ messages: msgs("multi"), fileOps: { modifiedFiles: all } });
    expect(s1).toContain("more under /repo/src/a/");
    expect(s1).toContain("more under /repo/tests/b/");
    const s2 = compileRanked({ messages: msgs("multi2"), previousSummary: s1 });
    for (const f of all) {
      expect(s2).toContain(base(f));
    }
  });

  it("created files overflow groups too", () => {
    const created = Array.from({ length: 25 }, (_, i) => `/repo/src/new/created-${String(i).padStart(2, "0")}.ts`);
    const s1 = compileRanked({ messages: msgs("new"), fileOps: { createdFiles: created } });
    expect(s1).toContain("- Created (+5 more under /repo/src/new/):");
    for (const f of created) {
      expect(s1).toContain(base(f));
    }
  });

  it("legacy bare (+N more) suffix keeps names, drops only the count", () => {
    const prev = `[Session Goal]\n- Ship\n\n[Files And Changes]\n- Modified: /repo/a.ts, /other/b.ts (+5 more)\n\n---\n\nbrief`;
    const out = compileRanked({ messages: [userMsg("go")], previousSummary: prev });
    expect(out).toContain("/repo/a.ts");
    expect(out).toContain("/other/b.ts");
    expect(out).not.toMatch(/\(\+5 more\)(?! under)/);
  });

  it("a 300-char token rejoins across chained markers", () => {
    const long = `/repo/src/${"b".repeat(280)}.ts`;
    const s1 = compileRanked({ messages: msgs("c1"), fileOps: { modifiedFiles: [long] } });
    const s2 = compileRanked({ messages: msgs("c2"), previousSummary: s1 });
    const s3 = compileRanked({ messages: msgs("c3"), previousSummary: s2 });
    const logical = (s: string) => s.replace(/\\\n[ \t]*/g, "").replace(/\n[ \t]+/g, " ");
    expect(logical(s3)).toContain(long);
  });

  it("custom content that sanitizes to empty contributes nothing", () => {
    expect(compileRanked({ messages: [{ role: "custom", content: "   " }] })).toBe("");
  });

  it("bash execution content samples for the usage guard", () => {
    const s = collectUsageStats([
      {
        role: "bashExecution",
        command: "the quick brown fox jumps over the lazy dog. ".repeat(40),
        output: "ok",
        usage: { input: 40000, output: 0 },
      },
    ] as any);
    expect(s.calibration.charsPerToken).toBe(4);
  });

  it("cjk fraction below threshold follows the latin prior", () => {
    const mixed = "hello world ".repeat(30) + "敏捷狐狸";
    expect(calibrateCharsPerToken(400, 4000, mixed).charsPerToken).toBe(4);
  });
});

describe("compaction-gaps — prefix-flip reconstruction", () => {
  it("marked-form names rebuild full paths when fresh files flip the prefix", () => {
    // Catches off-by-one prefix slicing: collapsed "/repo/src/" must rebuild
    // "/repo/src/a.ts", not "repo/src/a.ts".
    const prev = `[Session Goal]\n- Ship\n\n[Files And Changes]\n- Modified (in /repo/src/): a.ts, b.ts\n\n---\n\nbrief`;
    const out = compileRanked({
      messages: [userMsg("go")],
      fileOps: { modifiedFiles: ["/other/c.ts"] },
      previousSummary: prev,
    });
    expect(out).toContain("/repo/src/a.ts");
    expect(out).toContain("/repo/src/b.ts");
    expect(out).toContain("/other/c.ts");
  });
});
