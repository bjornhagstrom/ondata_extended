/**
 * After a write, reads go to the live service, past every cache, for a while.
 *
 * A vocabulary written (or perhaps written) by vocab_apply_changes is marked for FRESH_MS, the longest time any live
 * answer is cached (TemaTres's scheme data, an hour): until then its snapshot is not used and its live answers are
 * neither read from nor written to the cache. Every cached answer is then older than the write by more than its TTL,
 * so none outlives it; the snapshot file, rewritten every minute at the source, has long caught up. The source line's
 * memory reads the scheme again once after a write (`writtenAt`). In memory, per process or Worker isolate: another
 * isolate may answer from its cache until that cache expires, as before any write.
 */

export const FRESH_MS = 3_600_000;
const MAX_MARKED = 100;
const marks = new Map<string, number>();

const keyOf = (baseUrl: string) => (baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

/** Marks the vocabulary at `baseUrl` as just written. */
export function markWritten(baseUrl: string, now = Date.now()): void {
  for (const [key, at] of marks) if (now - at >= FRESH_MS) marks.delete(key);
  marks.delete(keyOf(baseUrl));
  while (marks.size >= MAX_MARKED) marks.delete(marks.keys().next().value!);
  marks.set(keyOf(baseUrl), now);
}

/** When the vocabulary at `baseUrl` was last written, if within FRESH_MS. */
export function writtenAt(baseUrl: string, now = Date.now()): number | undefined {
  const at = marks.get(keyOf(baseUrl));
  return at !== undefined && now - at < FRESH_MS ? at : undefined;
}

/** Whether reads of the vocabulary at `baseUrl` must go live, past the caches. */
export function mustReadFresh(baseUrl: string, now = Date.now()): boolean {
  return writtenAt(baseUrl, now) !== undefined;
}

/** Forget every mark; for tests. */
export function __resetFreshForTests(): void {
  marks.clear();
}
