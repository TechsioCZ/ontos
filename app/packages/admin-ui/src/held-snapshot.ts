import { useState } from 'react';

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
 */
export const useHeldSnapshot = <Snapshot extends { readonly state: string }>(
  key: string,
  snapshot: Snapshot,
): Snapshot => {
  const [held, setHeld] = useState<{ readonly key: string; readonly snapshot: Snapshot }>();
  if (snapshot.state !== 'pending') {
    // Store snapshots are stable per entry state, so each settled state is stored once.
    if (held?.key !== key || held.snapshot !== snapshot) {
      setHeld({ key, snapshot });
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
