// @ts-nocheck
// Synthetic session builders — deterministic ids, no LLM needed
// Matches host SessionEntry shape consumed by hook.ts:collectLiveMessages and core/load-messages.ts

export type SessionRole = "user" | "assistant" | "toolResult";

let _idCounter = 0;
function nextId(prefix = "m"): string {
  _idCounter += 1;
  return `${prefix}${_idCounter}`;
}
export function resetIdCounter(): void { _idCounter = 0; }

export function msg(id: string, role: SessionRole, content: string | unknown[] = "x"): Record<string, unknown> {
  const text = typeof content === "string" ? content : content;
  return { id, type: "message", message: { role, content: text } };
}

export function comp(id: string, firstKeptEntryId?: string): Record<string, unknown> {
  return { id, type: "compaction", firstKeptEntryId, summary: "old summary", timestamp: "2026-01-01T00:00:00.000Z" };
}

export function branchSummary(id: string, summary: string, fromId = "f1"): Record<string, unknown> {
  return { id, type: "branch_summary", summary, fromId, timestamp: "2026-01-01T00:00:00.000Z" };
}

export function resetBoundary(id: string): Record<string, unknown> {
  return { id, type: "reset_boundary", timestamp: "2026-01-01T00:00:00.000Z" };
}

export interface BuildSessionOpts {
  turns?: number; // number of user turns
  charsPerTurn?: number; // chars per user+assistant pair
  withCompaction?: { firstKeptEntryId?: string } | boolean;
  withResetBoundary?: boolean;
  withToolResults?: boolean;
  withSystemReminder?: boolean;
  withAnsi?: boolean;
}

export function buildSession(opts: BuildSessionOpts = {}): Record<string, unknown>[] {
  resetIdCounter();
  const turns = opts.turns ?? 5;
  const chars = opts.charsPerTurn ?? 200;
  const entries: Record<string, unknown>[] = [];
  if (opts.withCompaction) {
    const cfg = typeof opts.withCompaction === "object" ? opts.withCompaction : {};
    // orphan sentinel case: firstKeptEntryId = "" or non-existent
    entries.push(comp(nextId("c"), cfg.firstKeptEntryId ?? "m2"));
    entries.push(msg(nextId(), "user", "pre-compaction old message that should be superseded if not orphan"));
  }
  if (opts.withResetBoundary) {
    entries.push(resetBoundary(nextId("r")));
  }
  for (let i = 0; i < turns; i++) {
    const userContent = "x".repeat(chars) + ` turn${i} goal: implement feature ${i}`;
    const withExtras: string[] = [userContent];
    if (opts.withSystemReminder && i === 1) withExtras.push("<system-reminder>ignore this</system-reminder>");
    if (opts.withAnsi && i === 2) withExtras.push("\u001b[31mred\u001b[0m text");
    entries.push(msg(nextId(), "user", withExtras.join(" ")));
    entries.push(msg(nextId(), "assistant", `assistant reply ${i} with some content ` + "y".repeat(Math.floor(chars / 2))));
    if (opts.withToolResults && i % 2 === 0) {
      entries.push(msg(nextId(), "toolResult", `tool result ${i} output truncated`));
      entries.push(msg(nextId(), "assistant", `follow-up after tool ${i}`));
    }
  }
  return entries;
}

export function buildOrphanSession(): Record<string, unknown>[] {
  resetIdCounter();
  return [
    msg(nextId(), "user", "old pre-compaction message"),
    msg(nextId(), "assistant", "old assistant"),
    comp(nextId("c"), "ORPHAN_ID"),
    msg(nextId(), "user", "new turn 1 hello"),
    msg(nextId(), "assistant", "reply 1"),
    msg(nextId(), "user", "new turn 2 world"),
    msg(nextId(), "assistant", "reply 2"),
  ];
}

export function buildTooFewSession(): Record<string, unknown>[] {
  return [
    msg("m1", "user", "a"),
    msg("m2", "assistant", "b"),
  ];
}

export function buildToolResultBoundarySession(): Record<string, unknown>[] {
  resetIdCounter();
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    entries.push(msg(nextId(), "user", `user ${i} ` + "x".repeat(500)));
    entries.push(msg(nextId(), "assistant", `assistant ${i}`));
  }
  // tail ends with toolResult — budget cut must snap off it
  entries.push(msg(nextId(), "user", "final user that makes tail large " + "x".repeat(40000)));
  entries.push(msg(nextId(), "assistant", "assistant calls tool"));
  entries.push(msg(nextId(), "toolResult", "x".repeat(60000)));
  return entries;
}

export function buildLargeSessionForBriefCap(turns = 120): Record<string, unknown>[] {
  resetIdCounter();
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < turns; i++) {
    entries.push(msg(nextId(), "user", `user turn ${i} goal approach file src/file${i}.ts` + " body".repeat(20)));
    entries.push(msg(nextId(), "assistant", `assistant ${i} thinking and text` + " content".repeat(30)));
  }
  return entries;
}

export function buildRecallSession(): Record<string, unknown>[] {
  resetIdCounter();
  const entries: Record<string, unknown>[] = [];
  // 30 entries covering recall cases
  entries.push(msg(nextId(), "user", "redis cache integration goal"));
  entries.push(msg(nextId(), "assistant", "will use redis cache for session storage"));
  entries.push(msg(nextId(), "user", "hook inject feature request"));
  entries.push(msg(nextId(), "assistant", "implementing hook and inject pipeline"));
  for (let i = 4; i < 20; i++) {
    entries.push(msg(nextId(), "user", `turn ${i} touching src/auth.ts file change`));
    entries.push(msg(nextId(), "assistant", `edited src/auth.ts and src/db.ts in turn ${i}`));
  }
  entries.push(msg(nextId(), "user", "distinct #12 marker for drill-down test with unique phrase zebrasparkle"));
  entries.push(msg(nextId(), "assistant", "noted zebrasparkle marker"));
  // add some tool results to test role preservation
  entries.push(msg(nextId(), "toolResult", "tool output for file ops"));
  // add branch_summary to test lineage vs all
  entries.push(branchSummary(nextId("b"), "branch summary before fork"));
  entries.push(msg(nextId(), "user", "off-lineage user message after branch that should be filtered in lineage mode but visible in all"));
  return entries;
}
