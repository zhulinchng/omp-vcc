// Ambient types for dual omp/pi compatibility — zero-build TS loading
// Import specifier is rewritten by host (legacy-pi-compat.ts) for Pi.
// This file enables tsc --noEmit without a build step and satisfies imports
// from generated extensions/tools/hooks without installing the host package.
declare module "@oh-my-pi/pi-coding-agent" {
  export interface ExtensionContext {
    logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; debug(...args: unknown[]): void };
    ui: { notify(msg: string, level?: string): void; setWidget?: unknown; setHeader?: unknown; [key: string]: unknown };
    cwd: string;
    mode?: string;
    hasUI?: boolean;
    sessionManager: {
      getSessionFile(): string | undefined;
      getBranch(fromId?: string): any[];
      getEntries(): any[];
    };
    compact(instructionsOrOptions?: string | any): Promise<void>;
    sendMessage?: any;
    sendUserMessage?: any;
    [key: string]: unknown;
  }
  export interface ExtensionCommandContext extends ExtensionContext {
    compact(instructionsOrOptions?: string | any): Promise<void>;
  }
  export interface ExtensionAPI {
    registerTool(tool: unknown): void;
    registerCommand(name: string, opts: unknown): void;
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
    zod: {
      object(shape: Record<string, unknown>): any;
      string(): any;
      number(): any;
      boolean(): any;
      enum(values: string[]): any;
      array(item: unknown): any;
      optional(item: unknown): any;
    };
    arktype: unknown;
    typebox: unknown;
    ui?: unknown;
    logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; debug(...args: unknown[]): void };
    cwd: string;
    hasUI: boolean;
    getFlag(name: string): unknown;
    sendMessage?(message: unknown, options?: unknown): void;
    sendUserMessage?(content: unknown, options?: unknown): void | Promise<void>;
    [key: string]: unknown;
  }
  export type HookFactory = (pi: ExtensionAPI) => void | Promise<void>;
  export type CustomToolFactory = (pi: { zod: ExtensionAPI["zod"] }) => unknown;
  export const zod: ExtensionAPI["zod"];
  export function convertToLlm(messages: any[]): any[];
}

declare module "@oh-my-pi/pi-coding-agent/session/messages" {
  export function convertToLlm(messages: any[]): any[];
  export const USER_INTERRUPT_LABEL: string;
  export const SILENT_ABORT_MARKER: string;
  export type CustomMessage<T = unknown> = any;
}

declare module "@oh-my-pi/pi-ai" {
  export type Message = any;
  export type TextContent = any;
  export type ImageContent = any;
  export type ToolCallContent = any;
}

declare module "@earendil-works/pi-coding-agent" {
  export * from "@oh-my-pi/pi-coding-agent";
}
declare module "@earendil-works/pi-coding-agent/session/messages" {
  export * from "@oh-my-pi/pi-coding-agent/session/messages";
}
declare module "@earendil-works/pi-ai" {
  export * from "@oh-my-pi/pi-ai";
}
declare module "@mariozechner/pi-coding-agent" {
  export * from "@oh-my-pi/pi-coding-agent";
}
declare module "@mariozechner/pi-ai" {
  export * from "@oh-my-pi/pi-ai";
}

// Node shims for smoke/tests without @types/node
declare const process: { exitCode?: number; argv: string[]; exit(code?: number): never; env: Record<string, string | undefined> };
declare module "node:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => unknown): void;
  export const assert: { ok(value: unknown, msg?: string): void; equal(a: unknown, b: unknown, msg?: string): void; deepEqual(a: unknown, b: unknown, msg?: string): void };
}
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
  export function rmSync(path: string, opts?: unknown): void;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, opts?: unknown): void;
  export function existsSync(path: string): boolean;
}
declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
}
declare module "node:url" {
  export function pathToFileURL(path: string): { href: string };
}
declare module "node:module" {
  export function createRequire(filename: string): (id: string) => any;
}
