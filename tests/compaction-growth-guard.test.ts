// @ts-nocheck
// Growth guard: a compaction must never MATERIALLY add more than it removes.
// Regression tests for the plan-mode "compact and execute" 85K→87K report
// (kept 1/1 turns, ~47.3k tok, summarized 2): a tiny prefix inherits the
// session-cumulative fileOps, so the Files section alone dwarfs the removed
// prefix (measured 38x: 45-char prefix -> 1735-char summary) while the giant
// kept tail stays verbatim.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  getLastCompactionStats,
  evaluateGrowthGuard,
  OMP_VCC_COMPACT_INSTRUCTION,
  COMPACTION_GROWTH_FIXED_MARGIN_CHARS,
  COMPACTION_GROWTH_RELATIVE_MARGIN,
  COMPACTION_GROWTH_ABSOLUTE_CAP_CHARS,
} from "../extensions/vcc-core/hook";

let tmpDir: string;
let CONFIG_PATH: string;
let origOmp: string | undefined;
let origPi: string | undefined;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vcc-growth-"));
  CONFIG_PATH = join(tmpDir, "config.json");
  origOmp = process.env.OMP_VCC_CONFIG_PATH;
  origPi = process.env.PI_VCC_CONFIG_PATH;
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
  writeFileSync(CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true }));
});

afterAll(() => {
  if (origOmp === undefined) delete process.env.OMP_VCC_CONFIG_PATH;
  else process.env.OMP_VCC_CONFIG_PATH = origOmp;
  if (origPi === undefined) delete process.env.PI_VCC_CONFIG_PATH;
  else process.env.PI_VCC_CONFIG_PATH = origPi;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
});

function createMockPi() {
  let beforeHandler: ((event: any, ctx: any) => any) | undefined;
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const ctx = { hasUI: true, ui: { notify: (msg: string, level: string) => { notifyCalls.push({ msg, level }); } } };
  return {
    pi: { on: (n: string, h: any) => { if (n === "session_before_compact") beforeHandler = h; }, sendMessage: () => {}, sendUserMessage: () => {} } as any,
    invokeBefore: (event: any) => beforeHandler!(event, ctx),
    notifyCalls,
  };
}

const T = Date.now();
// Report shape: 2 tiny prefix messages before one giant kept user turn.
// The prefix carries the session-cumulative fileOps, so the Files section
// (~1.7k chars) exceeds the removed prefix (~45 chars) ~38x.
const tinyPrefix = () => ([
  { id: "c0", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc_0", name: "read", arguments: { path: "src/mod0.ts" } }], timestamp: T } },
  { id: "r0", type: "message", message: { role: "toolResult", toolCallId: "tc_0", toolName: "read", content: [{ type: "text", text: "ok" }], timestamp: T } },
]);
const sessionFileOps = () => ({
  read: Array.from({ length: 60 }, (_, i) => `src/explore${i}.ts`),
  written: Array.from({ length: 25 }, (_, i) => `src/feat${i}.ts`),
  edited: Array.from({ length: 15 }, (_, i) => `src/fix${i}.ts`),
});
// Dense BPE-hostile kept tail (~190k chars; calibration lands on cpt=4, so
// keptTokensEst reads ~47.5k exactly like the report's ~47.3k).
const giantTail = () => {
  const line = (i: number) => `0x${(i * 2654435761 % 4294967296).toString(16).padStart(8, "0")}|sess:${i}|q=${(i * 1.618).toFixed(6)}|{err:E${1000 + (i % 8999)}}\n`;
  let text = "";
  for (let i = 0; text.length < 190_000; i++) text += line(i);
  return { id: "u9", type: "message", message: { role: "user", content: text, timestamp: T } };
};
// Substantive prefix (~2k chars -> ~400-char summary): compressive, proceeds.
const mediumPrefix = () => {
  const plan = "Plan approved: migrate auth to OAuth2. Steps: (1) add login route in src/auth.ts, (2) wire refresh tokens in src/session.ts, (3) cover with tests/auth.test.ts. Constraints: no new deps, keep latency <50ms p99.";
  const out = "src/auth.ts:12-40\nsrc/session.ts:3-25\n" + "PASS tests/auth.test.ts (14 tests, 812ms)\n".repeat(40);
  return ([
    { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: plan }, { type: "toolCall", id: "tc_1", name: "read", arguments: { path: "src/auth.ts" } }], timestamp: T } },
    { id: "a2", type: "message", message: { role: "toolResult", toolCallId: "tc_1", toolName: "read", content: [{ type: "text", text: out }], timestamp: T } },
  ]);
};
const prevSummaryFixture = () =>
  "[Session Goal]\n- Migrate auth to OAuth2\n\n[Files And Changes]\n- Modified: src/auth.ts, src/session.ts\n\n[Commits]\n- abc1234 oauth migration\n\n[Outstanding Context]\n- Refresh rotation pending\n\n[User Preferences]\n- No new deps\n\n---\n\n* Read \"src/auth.ts\" (src/auth.ts:12-40) (#1)\n" +
  "* Edit src/session.ts { old: \"x\" (#2:src/session.ts:3-25) }\n".repeat(60);

const makeEvent = (branchEntries: any[], customInstructions?: string, extra: Record<string, unknown> = {}, prep: Record<string, unknown> = {}, tokensBefore = 85000) => ({
  type: "session_before_compact",
  customInstructions,
  branchEntries,
  preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore, ...prep },
  signal: new AbortController().signal,
  ...extra,
});

describe("compaction growth guard", () => {
  test("growth tolerance constants are pinned", () => {
    expect(COMPACTION_GROWTH_FIXED_MARGIN_CHARS).toBe(512);
    expect(COMPACTION_GROWTH_RELATIVE_MARGIN).toBe(0.25);
    expect(COMPACTION_GROWTH_ABSOLUTE_CAP_CHARS).toBe(4096);
  });

  test("report shape cancels: tiny prefix + cumulative fileOps + giant kept tail", async () => {
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
    const result: any = await invokeBefore(
      makeEvent([...tinyPrefix(), giantTail()], undefined, {}, { fileOps: sessionFileOps() }),
    );
    expect(result?.cancel).toBe(true);
    expect(result?.compaction).toBeUndefined();
    expect(notifyCalls.some((n) => n.msg.includes("would grow context") && n.msg.includes("cancelled"))).toBe(true);
    // No phantom savings recorded for a compaction that never happened.
    expect(getLastCompactionStats(pi)).toBeNull();
  });

  test("kept-tail estimate uses the dense prior on dense tails", async () => {
    // Same session shape as the report (~47.3k tok read at cpt=4): the dense
    // tail sample now selects the dense prior (3), so the kept tail reads
    // ~63k — closer to the host's ~80k+ truth (measured ~2.1 cpt on cl100k).
    // Estimation still cannot see growth alone, which is why the guard
    // compares chars, not estimated tokens.
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    await invokeBefore(makeEvent([...mediumPrefix(), giantTail()]));
    const stats: any = getLastCompactionStats(pi);
    expect(stats?.summarized).toBe(2);
    expect(stats?.keptUserTurns).toBe(1);
    expect(stats?.totalUserTurns).toBe(1);
    expect(stats?.keptTokensEst).toBeGreaterThan(55000);
    expect(stats?.keptTokensEst).toBeLessThan(70000);
  });

  test("compressive prefix proceeds", async () => {
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const tail = giantTail();
    const result: any = await invokeBefore(makeEvent([...mediumPrefix(), tail]));
    expect(result?.compaction).toBeDefined();
    expect(result.compaction.summary.length).toBeGreaterThan(0);
    expect(result.compaction.firstKeptEntryId).toBe(tail.id);
  });

  test("carried previous summary does not false-positive", async () => {
    // Gross summary (~4k chars, mostly carried prev) dwarfs the fresh prefix,
    // but net-new content is small: the guard must compare net-new, not gross.
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const tiny = ([
      { id: "a1", type: "message", message: { role: "assistant", content: "Planning approach drafted.", timestamp: T } },
      { id: "a2", type: "message", message: { role: "assistant", content: "Ready to execute the approved plan.", timestamp: T } },
    ]);
    const result: any = await invokeBefore(makeEvent([...tiny, giantTail()], undefined, {}, { previousSummary: prevSummaryFixture() }));
    expect(result?.compaction).toBeDefined();
    expect(result.compaction.summary).toContain("Migrate auth to OAuth2");
  });

  test("repeat compaction accumulates bounded net-new content (no ratchet)", async () => {
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const first: any = await invokeBefore(makeEvent([...mediumPrefix(), giantTail()], undefined, {}, { previousSummary: prevSummaryFixture() }));
    expect(first?.compaction).toBeDefined();
    const tiny = ([
      { id: "b1", type: "message", message: { role: "assistant", content: "Planning approach drafted.", timestamp: T } },
      { id: "b2", type: "message", message: { role: "assistant", content: "Ready to execute.", timestamp: T } },
    ]);
    const second: any = await invokeBefore(makeEvent([...tiny, giantTail()], undefined, {}, { previousSummary: first.compaction.summary }));
    expect(second?.compaction).toBeDefined();
    // Within-tolerance growth proceeds, but each pass adds only ~100 chars:
    // repeated compactions cannot ratchet the summary upward unboundedly.
    expect(second.compaction.summary.length - first.compaction.summary.length).toBeLessThanOrEqual(1024);
  });

  test("overflow defers to host instead of cancelling", async () => {
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
    const result: any = await invokeBefore(
      makeEvent([...tinyPrefix(), giantTail()], undefined, { reason: "overflow" }, { fileOps: sessionFileOps() }),
    );
    expect(result).toBeUndefined();
    expect(result?.cancel).toBeUndefined();
    expect(notifyCalls.some((n) => n.msg.includes("would grow context") && n.msg.includes("deferring"))).toBe(true);
  });

  test("willRetry defers to host instead of cancelling", async () => {
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const result: any = await invokeBefore(
      makeEvent([...tinyPrefix(), giantTail()], undefined, { willRetry: true }, { fileOps: sessionFileOps() }),
    );
    expect(result).toBeUndefined();
  });

  test("explicit /omp-vcc cancels on growth with a message", async () => {
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
    const result: any = await invokeBefore(
      makeEvent([...tinyPrefix(), giantTail()], OMP_VCC_COMPACT_INSTRUCTION, {}, { fileOps: sessionFileOps() }),
    );
    expect(result?.cancel).toBe(true);
    expect(notifyCalls.some((n) => n.msg.includes("would grow context"))).toBe(true);
  });

  test("normal multi-turn session is unaffected", async () => {
    // Realistic auto-compaction shape: large turns (~8k chars each with tool
    // calls), so the prefix dwarfs the summary and real savings result.
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries: any[] = [];
    for (let t = 0; t < 5; t++) {
      entries.push({ id: `u${t}`, type: "message", message: { role: "user", content: `goal step ${t} ` + "work on auth module, check redis cache ".repeat(150), timestamp: T } });
      entries.push({ id: `a${t}`, type: "message", message: { role: "assistant", content: [{ type: "text", text: `did step ${t} ` + "edited src/auth.ts and ran tests ".repeat(100) }, { type: "toolCall", id: `tc_${t}`, name: "bash", arguments: { command: `bun test tests/auth-${t}.test.ts --coverage` } }], timestamp: T } });
      entries.push({ id: `r${t}`, type: "message", message: { role: "toolResult", toolCallId: `tc_${t}`, toolName: "bash", content: [{ type: "text", text: `PASS tests/auth-${t}.test.ts ` + "(14 tests, 812ms)\n".repeat(60) }], timestamp: T } });
    }
    const result: any = await invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, {}, {}, 90000));
    expect(result?.compaction).toBeDefined();
    const stats: any = getLastCompactionStats(pi);
    expect(stats?.savedPercentEst).toBeGreaterThan(0);
  });

  test("within-tolerance sessions proceed (no churn on noise)", async () => {
    // Small chatty turns: summary (~3k chars) lands within tolerance of the
    // prefix (~3.2k chars), so the historical compact-small-sessions behavior
    // is preserved; the guard only fires on material growth.
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries: any[] = [];
    for (let t = 0; t < 5; t++) {
      entries.push({ id: `u${t}`, type: "message", message: { role: "user", content: `goal step ${t} ` + "work on auth module ".repeat(60), timestamp: T } });
      entries.push({ id: `a${t}`, type: "message", message: { role: "assistant", content: `did step ${t} ` + "edited src/auth.ts and ran tests ".repeat(60), timestamp: T } });
    }
    const result: any = await invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, {}, {}, 90000));
    expect(result?.compaction).toBeDefined();
  });
});

describe("evaluateGrowthGuard predicate — every arm and edge", () => {
  // Handler-level tests can only trip the guard where the real summarizer
  // produces material growth (it compresses well, so large-prefix trips are
  // contrived). The math itself is pinned exactly here instead.
  const cases: Array<[string, number, number, boolean]> = [
    // [name, prefixChars, netNewChars, expectedTrip]
    ["empty both ways", 0, 0, false],
    ["zero prefix with content trips (fixed arm)", 0, 513, true],
    ["zero prefix within fixed tolerance", 0, 512, false],
    ["report class: 45-char prefix, 1735-char summary", 45, 1735, true],
    ["small growth within fixed tolerance", 61, 218, false],
    ["fixed-arm boundary is strict: growth == 512 proceeds", 1000, 1512, false],
    ["fixed-arm boundary: growth == 513 trips", 1000, 1513, true],
    ["relative arm dominates past 2048: tolerance is 25%", 4000, 4999, false],
    ["relative arm: 1001 over 4000 trips", 4000, 5001, true],
    ["rounding: prefix 3000 -> tolerance 750", 3000, 3750, false],
    ["rounding: one char over trips", 3000, 3751, true],
    ["shrinkage never trips", 5000, 1000, false],
    ["net-zero summary never trips", 61, 0, false],
    // Absolute-cap zone (synthetic: unreachable via the real summarizer,
    // whose output scales slower than its input — backstop for pathological
    // blowup, e.g. a future uncapped fileOps section).
    ["absolute cap independent of ratio: 4500 over 20000 trips", 20000, 24500, true],
    ["absolute cap boundary is strict: 4096 over proceeds", 20000, 24096, false],
    ["absolute cap: 4097 over trips", 20000, 24097, true],
    ["huge proportional prefix does not false-fire the cap", 20000, 23000, false],
    ["verdict carries the math for debug", 45, 1735, true],
  ];
  for (const [name, prefix, netNew, trip] of cases) {
    test(name, () => {
      const v = evaluateGrowthGuard(prefix, netNew);
      expect(v.trip).toBe(trip);
      expect(v.netGrowthChars).toBe(netNew - prefix);
      expect(v.toleranceChars).toBe(Math.max(512, Math.round(prefix * 0.25)));
    });
  }
});

describe("compaction growth guard — handler edges", () => {
  test("explicit request during overflow still defers to host (void)", async () => {
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
    const result: any = await invokeBefore(
      makeEvent([...tinyPrefix(), giantTail()], OMP_VCC_COMPACT_INSTRUCTION, { reason: "overflow" }, { fileOps: sessionFileOps() }),
    );
    expect(result).toBeUndefined();
    expect(notifyCalls.some((n) => n.msg.includes("deferring"))).toBe(true);
    expect(getLastCompactionStats(pi)).toBeNull();
  });

  test("defer path records no stats", async () => {
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    await invokeBefore(
      makeEvent([...tinyPrefix(), giantTail()], undefined, { willRetry: true }, { fileOps: sessionFileOps() }),
    );
    expect(getLastCompactionStats(pi)).toBeNull();
  });

  test("micro-session proceeds within fixed tolerance (no refusal churn)", async () => {
    // 3 one-char messages: a ~50-char summary vs a 2-char prefix. Growth is
    // real but within framing noise — refusing would churn explicit tiny
    // compacts for zero benefit.
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = ["m1", "m2", "m3"].map((id, i) => ({
      id, type: "message",
      message: { role: i % 2 ? "assistant" : "user", content: "x", timestamp: T },
    }));
    const result: any = await invokeBefore(makeEvent(entries, OMP_VCC_COMPACT_INSTRUCTION, {}, {}, 5000));
    expect(result?.compaction).toBeDefined();
  });

  test("guard trip writes a debug snapshot with the char math", async () => {
    const { readFileSync, existsSync, unlinkSync } = await import("fs");
    const DEBUG_PATH = "/tmp/omp-vcc-debug.json";
    const prevCfg = readFileSync(CONFIG_PATH, "utf-8");
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true, debug: true }));
      if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
      const { pi, invokeBefore } = createMockPi();
      registerBeforeCompactHook(pi);
      await invokeBefore(
        makeEvent([...tinyPrefix(), giantTail()], undefined, {}, { fileOps: sessionFileOps() }),
      );
      expect(existsSync(DEBUG_PATH)).toBe(true);
      const dbg = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
      expect(dbg.growthGuard).toBe(true);
      expect(dbg.cancelled).toBe(true);
      expect(dbg.prefixChars).toBeGreaterThan(0);
      expect(dbg.netNewSummaryChars).toBeGreaterThan(dbg.prefixChars);
      expect(dbg.toleranceChars).toBe(512);
    } finally {
      writeFileSync(CONFIG_PATH, prevCfg);
      try { unlinkSync(DEBUG_PATH); } catch {}
    }
  });
});
