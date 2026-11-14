import { useState } from 'react';

/** One read of a detail record, as `useKeptDetail` sees it. */
export type DetailRead<Ready, Failure> =
  | { readonly kind: 'ready'; readonly ready: Ready }
  /** The record is being read (again). */
  | { readonly kind: 'loading' }
  /** A read that failed for a reason worth retrying: connection, outage, a newer app version. */
  | { readonly failure: Failure; readonly kind: 'failed' }
  /** A read that must never show an earlier record: access denied, the record is gone, nothing to read. */
  | { readonly kind: 'final' };

/** The record a detail shows: the current read, or the one shown before a reload that has not succeeded. */
export interface KeptDetail<Ready, Failure> {
  readonly ready: Ready;
  /** Why the reload of the shown record failed; absent while the record is current or still reloading. */
  readonly reloadFailure?: Failure;
}

export interface KeptDetailOptions<Ready, Failure> {
  /** The record and the scope it was read in; another key never shows what was kept for this one. */
  readonly key: string;
  readonly read: DetailRead<Ready, Failure>;
  /** Ready states are rebuilt on every render from the same store values; this compares those values. */
  readonly same: (left: Ready, right: Ready) => boolean;
}

/**
 * Keeps an editor of a record mounted, with its unsaved drafts, while a RELOAD of that same record is on its way or
 * has failed: a failed reload is reported in `reloadFailure`, never by replacing the editor. Nothing is held for a
 * first read (a failure there shows as such), for another `key` (another record or scope never shows the previous
 * record's data), or past a `final` read such as a denied one.
 */
export const useKeptDetail = <Ready, Failure>({
  key,
  read,
  same,
}: KeptDetailOptions<Ready, Failure>): KeptDetail<Ready, Failure> | null => {
  const [held, setHeld] = useState<{ readonly key: string; readonly ready: Ready } | null>(null);
  if (read.kind === 'ready') {
    if (held?.key !== key || !same(held.ready, read.ready)) {
      setHeld({ key, ready: read.ready });
    }
    return { ready: read.ready };
  }
  if (held === null) {
    return null;
  }
  if (held.key !== key || read.kind === 'final') {
    setHeld(null);
    return null;
  }
  return read.kind === 'failed' ? { ready: held.ready, reloadFailure: read.failure } : { ready: held.ready };
};
