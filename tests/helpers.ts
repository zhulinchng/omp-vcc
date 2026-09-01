// Helpers for @zhu/omp-vcc
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export interface RecordedUiCalls {
  setWidget: Array<{ key: string; content: unknown; options: unknown }>;
  setHeader: Array<{ factory: unknown }>;
  notify: Array<{ message: string; type: string }>;
}

export function makeMockApi(overrides: Record<string, unknown> = {}) {
  const calls: RecordedUiCalls = { setWidget: [], setHeader: [], notify: [] };
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  return {
    cwd: "/tmp",
    hasUI: true,
    ui: {
      setWidget: (key: string, content: unknown, opts?: unknown) => calls.setWidget.push({ key, content, options: opts }),
      setHeader: (factory: unknown) => calls.setHeader.push({ factory }),
      notify: (message: string, type: string = "info") => calls.notify.push({ message, type }),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    on: (event: string, handler: (e: unknown, ctx: unknown) => void | Promise<void>) => handlers.set(event, handler),
    registerTool: () => {},
    registerCommand: () => {},
    getFlag: () => undefined,
    ...overrides,
    __calls: calls,
    __handlers: handlers,
  } as unknown as ExtensionAPI & { __calls: RecordedUiCalls; __handlers: Map<string, unknown> };
}

export function makeMockCtx(overrides: Record<string, unknown> = {}) {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    ui: { notify: () => {}, setWidget: () => {}, setHeader: () => {} },
    mode: "tui" as const,
    hasUI: true,
    cwd: "/tmp/demo",
    ...overrides,
  } as unknown as Record<string, unknown>;
}
