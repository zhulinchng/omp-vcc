// @ts-nocheck
import { statSync } from "fs";
import type { Message } from "@oh-my-pi/pi-ai";
import { renderMessage, type RenderedEntry } from "./render-entries.ts";
import { scanSessionEntries } from "./session-lines.ts";

export interface LoadedMessages {
  rendered: RenderedEntry[];
  rawMessages: Message[];
  /** Entry IDs aligned with rendered/rawMessages; missing IDs use an empty sentinel. */
  entryIds: string[];
}

export interface LoadMessagesDebugEvent {
  kind: "session-parse-errors";
  sessionFile: string;
  parseErrors: number;
}

export type LoadMessagesDebugSink = (event: LoadMessagesDebugEvent) => void;

const CACHE_TTL_MS = 2_000;
const CACHE_CAPACITY = 3;

interface CacheEntry {
  createdAt: number;
  mtimeMs: number;
  value: LoadedMessages;
}

const cache = new Map<string, CacheEntry>();

const cacheKey = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
): string => {
  const lineage = allowedEntryIds
    ? JSON.stringify(Array.from(allowedEntryIds).sort())
    : "*";
  return JSON.stringify([sessionFile, full, lineage]);
};

const cached = (
  key: string,
  now: number,
  mtimeMs: number,
): LoadedMessages | undefined => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.createdAt >= CACHE_TTL_MS || hit.mtimeMs !== mtimeMs) {
    cache.delete(key);
    return undefined;
  }

  // Refresh insertion order for the three-entry LRU.
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
};

const remember = (key: string, value: LoadedMessages, mtimeMs: number): void => {
  cache.delete(key);
  cache.set(key, { createdAt: Date.now(), mtimeMs, value });
  if (cache.size > CACHE_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
};

const emitParseDiagnostic = (
  sink: LoadMessagesDebugSink | undefined,
  sessionFile: string,
  parseErrors: number,
): void => {
  if (!sink || parseErrors === 0) return;
  try {
    sink({
      kind: "session-parse-errors",
      sessionFile: sessionFile.slice(0, 1_024),
      parseErrors,
    });
  } catch {
    // Diagnostics must never affect session loading.
  }
};

export const loadAllMessages = (
  sessionFile: string,
  full: boolean,
  allowedEntryIds?: Set<string>,
  debugSink?: LoadMessagesDebugSink,
): LoadedMessages => {
  const key = cacheKey(sessionFile, full, allowedEntryIds);
  let mtimeMs: number | undefined;
  try {
    mtimeMs = statSync(sessionFile).mtimeMs;
  } catch {
    // The scanner below preserves the existing empty-result behavior for
    // missing/unreadable files while distinguishing ENOENT for its own callers.
  }

  if (mtimeMs !== undefined) {
    const hit = cached(key, Date.now(), mtimeMs);
    if (hit) return hit;
  }

  const rendered: RenderedEntry[] = [];
  const rawMessages: Message[] = [];
  const entryIds: string[] = [];
  let messageIndex = 0;
  let parseErrors = 0;
  let missing = false;

  try {
    const scan = scanSessionEntries<any>(sessionFile, (entry) => {
      if (entry?.type !== "message") return;

      if (entry.message) {
        const allowed = !allowedEntryIds || allowedEntryIds.has(entry.id);
        if (allowed) {
          rendered.push(renderMessage(entry.message, messageIndex, full));
          rawMessages.push(entry.message);
          entryIds.push(typeof entry.id === "string" ? entry.id : "");
        }
      }
      messageIndex++;
    });
    missing = scan.missing;
    parseErrors = scan.parseErrors;
  } catch {
    return { rendered: [], rawMessages: [], entryIds: [] };
  }

  emitParseDiagnostic(debugSink, sessionFile, parseErrors);
  const value = { rendered, rawMessages, entryIds };
  if (!missing && mtimeMs !== undefined) remember(key, value, mtimeMs);
  return value;
};
