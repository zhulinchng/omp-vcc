// @ts-nocheck
// pi convertToLlm compat: shim resolution order + wiring through the
// session_before_compact handler. The pipeline renders bashExecution/custom
// natively, but only the host convertToLlm drops !!-excluded spans and maps
// branchSummary entries to text — identity leaks the former and drops the
// latter.
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  registerBeforeCompactHook,
  resolveConvertToLlm,
  __setConvertToLlmForTests,
} from "../extensions/vcc-core/hook";

let tmpDir: string;
let CONFIG_PATH: string;
let origOmp: string | undefined;
let origPi: string | undefined;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-convert-compat-"));
  CONFIG_PATH = join(tmpDir, "omp-vcc-config.json");
  origOmp = process.env.OMP_VCC_CONFIG_PATH;
  origPi = process.env.PI_VCC_CONFIG_PATH;
  process.env.OMP_VCC_CONFIG_PATH = CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
  writeFileSync(CONFIG_PATH, JSON.stringify({}));
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

afterEach(() => {
  __setConvertToLlmForTests(null);
});

function createMockPi() {
  let beforeHandler: ((event: any, ctx: any) => any) | undefined;
  const ctx = { ui: { notify: () => {} } };
  return {
    pi: {
      on: (eventName: string, h: (e: any, c: any) => any) => {
        if (eventName === "session_before_compact") beforeHandler = h;
      },
    } as any,
    invokeBefore: (event: any) => beforeHandler!(event, ctx),
  };
}

const msg = (id: string, role: string, content: unknown) => ({ id, type: "message", message: { role, content } });
const prep = { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 10000 };

// pi-faithful converter: mirrors pi-core convertToLlm for the roles the
// identity fallback mishandles (bashExecution has no .content; branchSummary
// carries .summary; !!-excluded spans must be dropped).
const piFaithfulConvert = (messages: any[]): any[] =>
  messages.flatMap((m: any) => {
    if (!m || typeof m !== "object") return [m];
    if (m.role === "bashExecution") {
      if (m.excludeFromContext) return [];
      return [{ role: "user", content: `Ran \`${m.command}\`\n\`\`\`\n${m.output}\n\`\`\`` }];
    }
    if (m.role === "branchSummary") return [{ role: "user", content: `Branch summary: ${m.summary}` }];
    if (m.role === "custom") return [{ role: "user", content: m.content }];
    return [m];
  });

describe("resolveConvertToLlm", () => {
  test("prefers @earendil-works root when present", () => {
    const earendil = (m: any[]) => m;
    const omp = (m: any[]) => m;
    const got = resolveConvertToLlm((id: string) => {
      if (id === "@earendil-works/pi-coding-agent") return { convertToLlm: earendil };
      return { convertToLlm: omp };
    });
    expect(got).toBe(earendil);
  });

  test("falls through to omp root when earendil specifier misses", () => {
    const omp = (m: any[]) => m;
    const got = resolveConvertToLlm((id: string) => {
      if (id === "@earendil-works/pi-coding-agent") throw new Error("Cannot find module");
      if (id === "@oh-my-pi/pi-coding-agent") return { convertToLlm: omp };
      throw new Error("Cannot find module");
    });
    expect(got).toBe(omp);
  });

  test("skips modules without a convertToLlm export", () => {
    const legacy = (m: any[]) => m;
    const got = resolveConvertToLlm((id: string) => {
      if (id === "@earendil-works/pi-coding-agent") return {};
      if (id === "@oh-my-pi/pi-coding-agent") return {};
      if (id === "@oh-my-pi/pi-coding-agent/session/messages") return { convertToLlm: legacy };
      throw new Error("Cannot find module");
    });
    expect(got).toBe(legacy);
  });

  test("returns null when every candidate misses (caller keeps identity)", () => {
    const got = resolveConvertToLlm((_id: string) => {
      throw new Error("Cannot find module");
    });
    expect(got).toBeNull();
  });
});

describe("identity fallback contract (omp behavior)", () => {
  test("identity preserves transcript byte-for-byte including pi-only roles", () => {
    const transcript = [
      { role: "bashExecution", command: "ls", output: "a", timestamp: 1 },
      { role: "custom", customType: "x", content: "hi", timestamp: 2 },
      { role: "user", content: "hello" },
    ];
    const identity = (m: any[]) => m;
    expect(identity(transcript)).toBe(transcript);
  });
});

describe("session_before_compact convertToLlm wiring", () => {
  // Six user turns + assistant replies so keep:1 leaves a multi-message prefix;
  // the bash entry sits inside the summarized prefix.
  const branchWithBash = () => [
    msg("u1", "user", "deploy pipeline kickoff"),
    msg("a1", "assistant", "ack one"),
    { id: "b1", type: "message", message: { role: "bashExecution", command: "deploy-staging-42", output: "ok", timestamp: 3 } },
    msg("u2", "user", "second topic"),
    msg("a2", "assistant", "ack two"),
    msg("u3", "user", "third topic"),
    msg("a3", "assistant", "ack three"),
    msg("u4", "user", "fourth topic"),
    msg("a4", "assistant", "ack four"),
    msg("u5", "user", "fifth topic"),
    msg("a5", "assistant", "ack five"),
    msg("u6", "user", "latest question"),
  ];

  test("bash command text reaches the summary when host convertToLlm is resolved", () => {
    __setConvertToLlmForTests(piFaithfulConvert as any);
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const res: any = invokeBefore({
      type: "session_before_compact",
      customInstructions: "__omp_vcc__ keep:1",
      branchEntries: branchWithBash(),
      preparation: prep,
    });
    expect(res?.compaction).toBeDefined();
    expect(res.compaction.summary).toContain("deploy-staging-42");
  });

  test("identity fallback leaks !!-excluded spans (control: why resolution matters)", () => {
    __setConvertToLlmForTests(null);
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const branch = branchWithBash();
    branch.splice(2, 0, {
      id: "b0",
      type: "message",
      message: { role: "bashExecution", command: "secret-token-echo-77", output: "s3cr3t", excludeFromContext: true, timestamp: 2 },
    });
    const res: any = invokeBefore({
      type: "session_before_compact",
      customInstructions: "__omp_vcc__ keep:1",
      branchEntries: branch,
      preparation: prep,
    });
    expect(res?.compaction).toBeDefined();
    // Identity has no excludeFromContext notion (the pipeline renders
    // bashExecution natively), so the hidden span leaks into the summary.
    expect(res.compaction.summary).toContain("secret-token-echo-77");
  });

  test("!!-excluded bash spans stay out of the summary", () => {
    __setConvertToLlmForTests(piFaithfulConvert as any);
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const branch = branchWithBash();
    branch.splice(2, 0, {
      id: "b0",
      type: "message",
      message: { role: "bashExecution", command: "secret-token-echo-77", output: "s3cr3t", excludeFromContext: true, timestamp: 2 },
    });
    const res: any = invokeBefore({
      type: "session_before_compact",
      customInstructions: "__omp_vcc__ keep:1",
      branchEntries: branch,
      preparation: prep,
    });
    expect(res?.compaction).toBeDefined();
    expect(res.compaction.summary).not.toContain("secret-token-echo-77");
    expect(res.compaction.summary).not.toContain("s3cr3t");
  });

  test("branch summaries contribute text when converted", () => {
    __setConvertToLlmForTests(piFaithfulConvert as any);
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const branch = [
      { id: "bs1", type: "branch_summary", summary: "greek-theta-branch-11", fromId: "u1", timestamp: "2026-01-01T00:00:00.000Z" },
      ...branchWithBash(),
    ];
    const res: any = invokeBefore({
      type: "session_before_compact",
      customInstructions: "__omp_vcc__ keep:1",
      branchEntries: branch,
      preparation: prep,
    });
    expect(res?.compaction).toBeDefined();
    expect(res.compaction.summary).toContain("greek-theta-branch-11");
  });
});
