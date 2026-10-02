// @ts-nocheck
// Step 4 + Step 5 regressions.
//
// Step 5 (critical): omp's `SessionBeforeCompactEvent` carries NO `reason` and NO
// `willRetry` (shared-events.ts:66-76) — the only in-time source is
// `auto_compaction_start`, emitted BEFORE `session_before_compact`
// (session-maintenance.ts:4353 → :1707). `incomplete` is omp's length-truncated
// turn recovery reason. The old mapping dropped it and hardcoded
// `willRetry: false`, so omp-vcc CANCELLED the host's recovery compaction: the
// handler hit `return { cancel: true }`, the host threw CompactionCancelledError,
// and the truncated turn got neither a recovery compaction nor an agent retry.
//
// Step 4 (high): the growth-guard toast estimated `String(charCount)` through the
// token estimator, so a ~20k-char summary was announced as "~2 tok" instead of
// ~5k — the only user-facing explanation of a refusal, wrong by ~2500x.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  getLastCompactionStats,
  isRecoveryReason,
  OMP_VCC_COMPACT_INSTRUCTION,
} from "../extensions/vcc-core/hook";
import {
  estimateScriptAwareTokens,
  estimateTokensFromChars,
} from "../extensions/vcc-core/core/token-estimate";

let tmpDir: string;
let CONFIG_PATH: string;
let origOmp: string | undefined;
let origPi: string | undefined;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vcc-recovery-"));
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

// Captures every registered handler so the real event ORDER the host uses can be
// replayed: auto_compaction_start fires first, then session_before_compact.
function createMockPi() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const ctx = { hasUI: true, ui: { notify: (msg: string, level: string) => { notifyCalls.push({ msg, level }); } } };
  const pi: any = {
    on: (n: string, h: any) => { handlers.set(n, h); },
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  return {
    pi,
    notifyCalls,
    fire: (name: string, event: any) => handlers.get(name)!(event, ctx),
    invokeBefore: (event: any) => handlers.get("session_before_compact")!(event, ctx),
  };
}

const T = Date.now();

const makeEvent = (
  branchEntries: any[],
  customInstructions?: string,
  extra: Record<string, unknown> = {},
  prep: Record<string, unknown> = {},
  tokensBefore = 85000,
) => ({
  type: "session_before_compact",
  customInstructions,
  branchEntries,
  preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore, ...prep },
  signal: new AbortController().signal,
  ...extra,
});

// A prefix so small that a Files-heavy summary dwarfs it → growth guard trips.
const tinyPrefix = () => ([
  { id: "c0", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc_0", name: "read", arguments: { path: "src/mod0.ts" } }], timestamp: T } },
  { id: "r0", type: "message", message: { role: "toolResult", toolCallId: "tc_0", toolName: "read", content: [{ type: "text", text: "ok" }], timestamp: T } },
]);

const giantTail = () => {
  const line = (i: number) => `0x${(i * 2654435761 % 4294967296).toString(16).padStart(8, "0")}|sess:${i}|q=${(i * 1.618).toFixed(6)}|{err:E${1000 + (i % 8999)}}\n`;
  let text = "";
  for (let i = 0; text.length < 190_000; i++) text += line(i);
  return { id: "u9", type: "message", message: { role: "user", content: text, timestamp: T } };
};

const sessionFileOps = () => ({
  read: Array.from({ length: 60 }, (_, i) => `src/explore${i}.ts`),
  written: Array.from({ length: 25 }, (_, i) => `src/feat${i}.ts`),
  edited: Array.from({ length: 15 }, (_, i) => `src/fix${i}.ts`),
});

const growthTripEvent = () =>
  makeEvent([...tinyPrefix(), giantTail()], undefined, {}, { fileOps: sessionFileOps() });

describe("isRecoveryReason", () => {
  test("covers both omp recovery reasons and nothing else", () => {
    expect(isRecoveryReason("overflow")).toBe(true);
    expect(isRecoveryReason("incomplete")).toBe(true);
    expect(isRecoveryReason("threshold")).toBe(false);
    expect(isRecoveryReason("manual")).toBe(false);
    expect(isRecoveryReason(undefined)).toBe(false);
    expect(isRecoveryReason(null)).toBe(false);
  });
});

describe("step 5: omp `incomplete` recovery defers instead of cancelling", () => {
  test("auto_compaction_start(incomplete) + growth trip → defer, not cancel", async () => {
    const h = createMockPi();
    registerBeforeCompactHook(h.pi);
    h.fire("auto_compaction_start", { reason: "incomplete", action: "context-full" });
    const result: any = await h.invokeBefore(growthTripEvent());

    expect(result).toBeUndefined();
    const toast = h.notifyCalls.find((n) => n.msg.includes("would grow context"));
    expect(toast).toBeDefined();
    expect(toast!.msg).toContain("deferring to host compaction");
    expect(toast!.msg).not.toContain("— cancelled");
    // A refused compaction must not leave phantom savings behind.
    expect(getLastCompactionStats(h.pi)).toBeNull();
  });

  test("auto_compaction_start(incomplete) + too_few_live_messages → host proceeds", async () => {
    const h = createMockPi();
    registerBeforeCompactHook(h.pi);
    h.fire("auto_compaction_start", { reason: "incomplete", action: "context-full" });
    // 2 live messages → buildOwnCut returns too_few_live_messages, the exact
    // branch that used to cancel the host's recovery.
    const result: any = await h.invokeBefore(
      makeEvent(tinyPrefix(), undefined, {}, { tokensBefore: 40_000 }),
    );
    expect(result).toBeUndefined();
  });

  test("auto_compaction_start(overflow) still defers (no regression)", async () => {
    const h = createMockPi();
    registerBeforeCompactHook(h.pi);
    h.fire("auto_compaction_start", { reason: "overflow", action: "context-full" });
    expect(await h.invokeBefore(growthTripEvent())).toBeUndefined();
  });

  test("auto_compaction_start(threshold) still cancels a growth trip (no regression)", async () => {
    const h = createMockPi();
    registerBeforeCompactHook(h.pi);
    h.fire("auto_compaction_start", { reason: "threshold", action: "context-full" });
    const result: any = await h.invokeBefore(growthTripEvent());
    expect(result?.cancel).toBe(true);
    expect(h.notifyCalls.some((n) => n.msg.includes("— cancelled"))).toBe(true);
  });

  test("pi-host path: reason+willRetry on the event itself still defers", async () => {
    // pi's SessionBeforeCompactEvent really does carry reason/willRetry.
    const h = createMockPi();
    registerBeforeCompactHook(h.pi);
    const result: any = await h.invokeBefore(
      makeEvent([...tinyPrefix(), giantTail()], undefined, { reason: "incomplete", willRetry: true }, { fileOps: sessionFileOps() }),
    );
    expect(result).toBeUndefined();
    expect(h.notifyCalls.some((n) => n.msg.includes("deferring"))).toBe(true);
  });

  test("explicit /omp-vcc still cancels a growth trip (no regression)", async () => {
    const h = createMockPi();
    registerBeforeCompactHook(h.pi);
    const result: any = await h.invokeBefore(
      makeEvent([...tinyPrefix(), giantTail()], OMP_VCC_COMPACT_INSTRUCTION, {}, { fileOps: sessionFileOps() }),
    );
    expect(result?.cancel).toBe(true);
  });
});

describe("step 4: growth-guard toast reports real token counts", () => {
  test("summary cost is announced at char-count scale, not String(charCount) scale", async () => {
    const h = createMockPi();
    registerBeforeCompactHook(h.pi);
    h.fire("auto_compaction_start", { reason: "threshold", action: "context-full" });
    await h.invokeBefore(growthTripEvent());

    const toast = h.notifyCalls.find((n) => n.msg.includes("would grow context"));
    expect(toast).toBeDefined();
    const match = toast!.msg.match(/summary adds ~([\d.]+)k? tok/);
    expect(match).not.toBeNull();

    const raw = match![1];
    const k = raw.endsWith("k");
    const value = Number.parseFloat(k ? raw.slice(0, -1) : raw);
    const tokens = k ? value * 1000 : value;

    // The Files section alone is ~1.7k chars, so the summary is well over 300
    // tokens. The old expression printed 2 tok for every input.
    expect(tokens).toBeGreaterThan(300);
  });

  test("a 20k-char summary is not tokenized as the decimal string \"20000\"", () => {
    // Pure reproduction of the defect: the old expression tokenized the decimal
    // string of the char count, so 20000 chars → "20000" → 2 tokens.
    expect(estimateScriptAwareTokens(String(20_000))).toBeLessThan(5);
    expect(estimateTokensFromChars(20_000, 4)).toBe(5000);
  });
});
