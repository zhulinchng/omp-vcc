// @ts-nocheck
import { closeSync, openSync, readSync } from "fs";
import { StringDecoder } from "string_decoder";

const READ_BUFFER_BYTES = 64 * 1024;

export interface ScanSessionEntriesResult<T> {
  /** True only when opening the file failed with ENOENT. */
  missing: boolean;
  /** Number of malformed, nonblank JSONL lines encountered. */
  parseErrors: number;
  /** Present when no per-line callback was supplied. */
  entries?: T[];
}

export type SessionEntryCallback<T> = (entry: T) => void;

/**
 * Stream persisted JSONL entries without reading the session as one string.
 * Blank lines are ignored. Malformed nonblank lines are counted and skipped;
 * filesystem errors other than a missing file propagate to the caller.
 */
export const scanSessionEntries = <T = unknown>(
  filePath: string,
  onEntry?: SessionEntryCallback<T>,
): ScanSessionEntriesResult<T> => {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { missing: true, parseErrors: 0 };
    }
    throw error;
  }

  const entries = onEntry ? undefined : ([] as T[]);
  let parseErrors = 0;
  let remainder = "";
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let position = 0;

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;

    let entry: T;
    try {
      entry = JSON.parse(line) as T;
    } catch {
      parseErrors++;
      return;
    }
    if (onEntry) onEntry(entry);
    else entries.push(entry);
  };

  try {
    let bytesRead: number;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, position)) > 0) {
      position += bytesRead;
      const chunk = decoder.write(buffer.subarray(0, bytesRead));
      let cursor = 0;
      let newline = chunk.indexOf("\n");
      while (newline !== -1) {
        consumeLine(remainder + chunk.slice(cursor, newline));
        remainder = "";
        cursor = newline + 1;
        newline = chunk.indexOf("\n", cursor);
      }
      remainder += chunk.slice(cursor);
    }
    remainder += decoder.end();
    if (remainder) consumeLine(remainder);
  } finally {
    closeSync(fd);
  }

  return { missing: false, parseErrors, ...(entries ? { entries } : {}) };
};
