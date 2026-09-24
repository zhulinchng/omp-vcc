// @ts-nocheck

/** Minimal persisted-session entry shape used by the global index. */
export interface PersistedSessionEntry {
  type?: unknown;
  id?: unknown;
}

/** A fail-closed mapping from unique message entry IDs to global positions. */
export interface GlobalIndex {
  /** Number of persisted entries whose type is exactly "message". */
  messageCount: number;
  /** Unique, non-empty string message IDs mapped to 1-based global positions. */
  indexById: Map<string, number>;
}

/**
 * Build global message positions from persisted session entries.
 *
 * Every message entry consumes a position, including entries without an ID.
 * A repeated ID is removed permanently: malformed branches must not resolve
 * to either occurrence. Missing and non-string IDs never enter the map.
 */
export const buildGlobalIndex = (
  entries: Iterable<PersistedSessionEntry>,
): GlobalIndex => {
  const indexById = new Map<string, number>();
  const seenIds = new Set<string>();
  let messageCount = 0;

  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    messageCount++;

    const id = entry.id;
    if (typeof id !== "string" || id.length === 0 || seenIds.has(id)) {
      if (typeof id === "string" && id.length > 0) indexById.delete(id);
      continue;
    }

    seenIds.add(id);
    indexById.set(id, messageCount);
  }

  return { messageCount, indexById };
};
