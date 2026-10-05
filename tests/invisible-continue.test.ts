// @ts-nocheck
import { describe, expect, it, test, vi } from "bun:test";
import {
  registerBeforeCompactHook,
  triggerInvisibleContinue,
  buildOwnCut,
  AUTO_CONTINUE_CUSTOM_TYPE,
  OMP_VCC_COMPACT_INSTRUCTION,
} from "../extensions/vcc-core/hook";

describe("invisible auto-continue: trigger + context filter", () => {
  it("triggerInvisibleContinue sends a hidden custom message with followUp delivery", () => {
    const calls: { m: any; o: any }[] = [];
    const pi = { sendMessage: (m: any, o: any) => calls.push({ m, o }) } as any;
    triggerInvisibleContinue(pi);

    expect(calls).toHaveLength(1);
    expect(calls[0].o).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(calls[0].m).toMatchObject({
      customType: AUTO_CONTINUE_CUSTOM_TYPE,
      content: [],
      display: false,
    });
  });

  it("context hook filters ONLY our customType; other custom messages pass through untouched", () => {
    let handler: ((event: any) => unknown) | undefined;
    const pi = { on: (e: string, h: any) => { if (e === "context") handler = h; } } as any;
    registerBeforeCompactHook(pi);

    const user = { role: "user", content: [{ type: "text", text: "keep" }] };
    const own = { role: "custom", customType: AUTO_CONTINUE_CUSTOM_TYPE, content: [] };
    const other = { role: "custom", customType: "some-other-ext", content: [{ type: "text", text: "ctx" }] };

    const result = handler?.({ messages: [user, own, other] });
    const filtered = ((result as any)?.messages ?? [user, own, other]) as any[];
    expect(filtered).toEqual([user, other]);
  });

  it("context hook is a pure filter: returns undefined when nothing to remove", () => {
    let handler: ((event: any) => unknown) | undefined;
    const pi = { on: (e: string, h: any) => { if (e === "context") handler = h; } } as any;
    registerBeforeCompactHook(pi);

    const user = { role: "user", content: [{ type: "text", text: "hi" }] };
    const other = { role: "custom", customType: "other-ext", content: [] };
    const result = handler?.({ messages: [user, other] });
    expect(result).toBeUndefined(); // no mutation, no return
  });

  it("filter is idempotent: removing our marker yields empty result deterministically", () => {
    let handler: ((event: any) => unknown) | undefined;
    const pi = { on: (e: string, h: any) => { if (e === "context") handler = h; } } as any;
    registerBeforeCompactHook(pi);

    const own = { role: "custom", customType: AUTO_CONTINUE_CUSTOM_TYPE, content: [] };
    const once = handler?.({ messages: [own] });
    const messages = ((once as any)?.messages ?? []) as any[];
    expect(messages).toEqual([]);
  });

  it("context hook leaves pi-shaped compactionSummary and bashExecution intact", () => {
    let handler: ((event: any) => unknown) | undefined;
    const pi = { on: (e: string, h: any) => { if (e === "context") handler = h; } } as any;
    registerBeforeCompactHook(pi);

    const user = { role: "user", content: "keep" };
    const summary = { role: "compactionSummary", summary: "prior work", tokensBefore: 90000, timestamp: 1 };
    const bash = { role: "bashExecution", command: "ls", output: "a", timestamp: 2 };
    const own = { role: "custom", customType: AUTO_CONTINUE_CUSTOM_TYPE, content: [] };
    const legacy = { role: "custom", customType: "pi-vcc-auto-continue", content: [] };

    const result = handler?.({ messages: [user, summary, bash, own, legacy] });
    expect((result as any)?.messages).toEqual([user, summary, bash]);
  });
});

describe("invisible auto-continue: summarize-path noise", () => {
  it("our continue custom message carries empty content → adds no noise to summarizer input", () => {
    const entries = [
      { id: "u1", type: "message", message: { role: "user", content: "go" } },
      { id: "a1", type: "message", message: { role: "assistant", content: "reply" } },
      {
        id: "c1",
        type: "custom_message",
        customType: AUTO_CONTINUE_CUSTOM_TYPE,
        content: [],
        display: false,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      { id: "u2", type: "message", message: { role: "user", content: "next" } },
      { id: "a2", type: "message", message: { role: "assistant", content: "done" } },
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;

    // The continue message is collected into the live window (harmless) but its
    // content is empty, so it contributes zero text/tokens to the summarizer.
    const custom = cut.messages.find((m: any) => m.content && m.role === "custom");
    expect(custom).toBeDefined();
    const contentLen = Array.isArray(custom.content)
      ? custom.content.length
      : String(custom.content ?? "").length;
    expect(contentLen).toBe(0);
  });
});
// scheduleManaged's stale-session guard compared the RAW `state.sessionId`,
// while its sibling `isCurrentGeneration` used `?? sessionIdOf(ctx)`. Until
// something initialised `state.sessionId` (only advanceSessionGeneration does),
// the guard called every deferred callback stale — so the stats toast and the
// auto-continue were silently dropped for a session the sibling predicate
// called current.
describe("scheduleManaged agrees with isCurrentGeneration", () => {
  const T = Date.now();
  const msg = (id: string, role: string, content: string) => ({ id, type: "message", message: { role, content, timestamp: T } });
  const entries = [
    msg("u0", "user", "do the thing"),
    msg("a0", "assistant", "working"),
    msg("u1", "user", "more"),
    msg("a1", "assistant", "done"),
  ];

  const makePi = () => {
    const sent: any[] = [];
    const pi: any = {
      on: (e: string, f: any) => { pi[e] = f; },
      sent,
      sendMessage: (m: any) => sent.push(m),
      sendUserMessage: (m: any) => sent.push(m),
    };
    registerBeforeCompactHook(pi);
    return pi;
  };

  // A ctx that REPORTS a session id but has never fired a session event, so the
  // per-pi state still has sessionId === undefined.
  const ctxWithSessionId = () => ({
    settings: { get: () => undefined },
    config: { get: () => undefined },
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => "s-123", getEntries: () => entries, getBranch: () => entries },
  });

  it("fires the auto-continue after a threshold compaction", async () => {
    vi.useFakeTimers();
    try {
      const pi = makePi();
      const ctx = ctxWithSessionId();
      const res = await pi["session_before_compact"]({
        type: "session_before_compact",
        branchEntries: entries,
        preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 100_000 },
        // No sentinel: this is the automatic threshold path, the only one where
        // `lastCompactWasPiVcc` stays false and the continue is live.
        customInstructions: "",
        signal: new AbortController().signal,
      }, ctx);
      expect(res?.compaction).toBeDefined();

      await pi["session_compact"]({
        type: "session_compact",
        fromExtension: true,
        reason: "threshold",
        willRetry: false,
        compactionEntry: {
          id: "c1",
          tokensBefore: 100_000,
          tokensAfter: 25_000,
          summary: res.compaction.summary,
          firstKeptEntryId: res.compaction.firstKeptEntryId,
          details: res.compaction.details,
        },
      }, ctx);

      // The continue is scheduled through scheduleManaged with delay 0.
      vi.advanceTimersByTime(1);
      expect(pi.sent.some((m) => m?.customType === AUTO_CONTINUE_CUSTOM_TYPE)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
