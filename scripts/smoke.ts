// Smoke checks for @zhulinchng/omp-vcc — host-free, zero deps
import extension from "../extensions/main.ts";
import { buildOwnCut } from "../extensions/vcc-core/hook.ts";
import { calibrateCharsPerToken } from "../extensions/vcc-core/core/token-estimate.ts";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (!condition) {
    failures++;
    console.error(`FAIL ${name}${detail ? ": " + detail : ""}`);
  } else {
    console.log(`ok ${name}`);
  }
}

console.log("1. extension loads and registers");
try {
  const handlers = new Map<string, unknown>();
  const tools: any[] = [];
  const commands: any[] = [];
  const chain: any = {
    describe: () => chain,
    optional: () => chain,
  };
  const mockZod: any = {
    object: (s: any) => s,
    string: () => chain,
    number: () => chain,
    boolean: () => chain,
    enum: () => chain,
    array: () => chain,
  };
  const mockPi: any = {
    on: (event: string, handler: unknown) => handlers.set(event, handler),
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, opts: any) => commands.push({ name, opts }),
    zod: mockZod,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };

  await (extension as any)(mockPi);

  check(
    "session_before_compact hooked",
    handlers.has("session_before_compact"),
  );
  check("context hooked", handlers.has("context"));
  check("session_compact hooked", handlers.has("session_compact"));
  check(
    "vcc_recall registered",
    tools.some((t) => t.name === "vcc_recall"),
  );
  check(
    "omp-vcc command registered",
    commands.some((c) => c.name === "omp-vcc"),
  );
  check(
    "vcc-recall command registered",
    commands.some((c) => c.name === "vcc-recall"),
  );
  check(
    "pi-vcc alias registered",
    commands.some((c) => c.name === "pi-vcc"),
  );
} catch (e) {
  check("extension loads", false, String(e));
}

console.log("2. vcc-core pipeline smoke");
try {
  const result = buildOwnCut(
    [
      {
        id: "m1",
        type: "message",
        message: { role: "user", content: "hello" },
      },
      {
        id: "m2",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
      {
        id: "m3",
        type: "message",
        message: { role: "user", content: "world" },
      },
      {
        id: "m4",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "reply" }],
        },
      },
    ] as any,
    1,
  );
  check("buildOwnCut ok", (result as any).ok === true);
  const cal = calibrateCharsPerToken(1000, 250);
  check("calibrateCharsPerToken", cal.charsPerToken === 4);
} catch (e) {
  check("vcc-core pipeline", false, String(e));
}

console.log(
  failures === 0
    ? "\nAll smoke checks passed."
    : `\n${failures} smoke check(s) FAILED.`,
);
process.exitCode = failures === 0 ? 0 : 1;
