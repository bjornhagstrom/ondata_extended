/**
 * After a write, reads go to the live service, past every cache, for a while.
 *
 * A vocabulary written by vocab_apply_changes is marked for FRESH_MS (the live answers' cache TTL): until then its
 * snapshot is not used and its live answers are neither read from nor written to the cache. Every cached answer is
 * then older than the write by more than its TTL, so none outlives it; the snapshot file, rewritten every minute at
 * the source, has caught up too. In memory, per process or Worker isolate: another isolate may answer from its cache
 * until that cache expires, as before any write.
 */

export const FRESH_MS = 300_000;
const MAX_MARKED = 100;
const writtenAt = new Map<string, number>();

const keyOf = (baseUrl: string) => (baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

/** Marks the vocabulary at `baseUrl` as just written. */
export function markWritten(baseUrl: string, now = Date.now()): void {
  for (const [key, at] of writtenAt) if (now - at >= FRESH_MS) writtenAt.delete(key);
  writtenAt.delete(keyOf(baseUrl));
  while (writtenAt.size >= MAX_MARKED) writtenAt.delete(writtenAt.keys().next().value!);
  writtenAt.set(keyOf(baseUrl), now);
}

/** Whether reads of the vocabulary at `baseUrl` must go live, past the caches. */
export function mustReadFresh(baseUrl: string, now = Date.now()): boolean {
  const at = writtenAt.get(keyOf(baseUrl));
  return at !== undefined && now - at < FRESH_MS;
}

/** Forget every mark; for tests. */
export function __resetFreshForTests(): void {
  writtenAt.clear();
}
