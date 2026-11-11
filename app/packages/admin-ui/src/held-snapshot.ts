import { MutableRef } from 'effect';
import { useState } from 'react';

/** Module event names of `shared-contracts/page-data` (`moduleWriteEvent`, `moduleChangeEvent`); admin-ui does not import that package. */
const moduleWriteEvent = 'ontos:module-write';
const moduleChangeEvent = 'ontos:module-change';
/** Keys one memory keeps; the least recently used one is dropped first. */
const REMEMBERED_KEYS = 30;

/** Memories that already drop their copies on the module events, so each memory listens once. */
const listened = MutableRef.make(new WeakSet<object>());

const listen = (memory: { readonly clear: () => void }): void => {
  if (!('addEventListener' in globalThis) || MutableRef.get(listened).has(memory)) {
    return;
  }
  MutableRef.get(listened).add(memory);
  // Any module's write or live change empties the memory: a reopened reader then waits for a real read.
  globalThis.addEventListener(moduleWriteEvent, () => memory.clear());
  globalThis.addEventListener(moduleChangeEvent, () => memory.clear());
};

export interface HeldSnapshotOptions<Snapshot extends { readonly state: string }> {
  /**
   * Also starts a reader that mounts again from the last ready snapshot of the same key, while its own snapshot is
   * pending. The map belongs to one store and lives in module memory only (browser only); the hook keeps it to the
   * `REMEMBERED_KEYS` most recently used keys and drops it on every module write or live change. Pass it only where
   * the key holds everything that tells the data apart (company, principal, language, page, filters).
   * Without it the hook behaves as it always did.
   */
  readonly memory?: Map<string, Snapshot>;
}

const remember = <Snapshot extends { readonly state: string }>(
  memory: Map<string, Snapshot>,
  key: string,
  snapshot: Snapshot,
): void => {
  if (!('addEventListener' in globalThis)) {
    return;
  }
  listen(memory);
  memory.delete(key);
  // Only a ready read is kept: a pending, failed or refused state never answers a later mount.
  if (snapshot.state !== 'ready') {
    return;
  }
  memory.set(key, snapshot);
  if (memory.size > REMEMBERED_KEYS) {
    const oldest = memory.keys().next();
    if (oldest.done !== true) {
      memory.delete(oldest.value);
    }
  }
};

const recall = <Snapshot extends { readonly state: string }>(
  memory: Map<string, Snapshot>,
  key: string,
): Snapshot | undefined => {
  const value = memory.get(key);
  if (value !== undefined) {
    // Reading a key makes it the most recently used one.
    memory.delete(key);
    memory.set(key, value);
  }
  return value;
};

/**
 * Keeps a detail on screen while its strict page-data store reloads the same record.
 *
 * A store defined with `retainStale: false` reads as `pending` whenever its entry is reloaded: after the 20 s
 * freshness window, after a live change or a settled write, and after an explicit refresh. A reader that renders
 * `pending` as its loading state then replaces the whole detail and remounts it, which loses the scroll position
 * and typed input. This hook answers `pending` with the last ready snapshot of the same `key` instead.
 *
 * The store's safeguards stay intact: a different key (another record, company, principal or tenant) never shows
 * the previous record, and a failed reload, including a refused one, replaces the held value at once.
 *
 * The held snapshot lasts only while the reader stays on its key. Once the reader reads another key, a closed panel
 * (a key with nothing to read) included, coming back shows what the store has, never the snapshot held earlier.
 *
 * With `memory`, a reader that mounts while its snapshot is pending starts from the last ready snapshot of its key,
 * as if it had stayed mounted. Only the mount reads the memory; a reader that changes key behaves as without it.
 */
export const useHeldSnapshot = <Snapshot extends { readonly state: string }>(
  key: string,
  snapshot: Snapshot,
  options?: HeldSnapshotOptions<Snapshot>,
): Snapshot => {
  const memory = options?.memory;
  const [held, setHeld] = useState<{ readonly key: string; readonly snapshot: Snapshot } | undefined>(() => {
    // A mounting reader whose store reads pending starts from what it would have held had it stayed mounted.
    const kept = memory === undefined || snapshot.state !== 'pending' ? undefined : recall(memory, key);
    return kept === undefined ? undefined : { key, snapshot: kept };
  });
  if (snapshot.state !== 'pending') {
    // Store snapshots are stable per entry state, so each settled state is stored once.
    if (held?.key !== key || held.snapshot !== snapshot) {
      setHeld({ key, snapshot });
    }
    if (memory !== undefined) {
      remember(memory, key, snapshot);
    }
    return snapshot;
  }
  if (held === undefined) {
    return snapshot;
  }
  if (held.key !== key) {
    // The reader left the held key while this one is still loading: drop it, so it cannot come back later.
    setHeld(undefined);
    return snapshot;
  }
  return held.snapshot.state === 'ready' ? held.snapshot : snapshot;
};
