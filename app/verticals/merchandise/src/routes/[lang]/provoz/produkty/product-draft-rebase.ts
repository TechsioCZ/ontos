// After a save someone else's change refused: the product is read again, then the draft's own changes go over the
// version they saved. A draft that overlaps nothing they changed is saved again at once; one that does waits behind
// the conflict message until "Načíst aktuální verzi" puts the operator's values over the fresh version.
import type { SaveState } from '@app/admin-ui';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { DraftMerge } from './product-draft-merge.ts';

/** Rebased saves of one draft that go out by themselves; a catalogue that keeps changing leaves it to the operator. */
const AUTOMATIC_REBASES = 3;

/**
 * A save refused because the product changed since the version it named: the draft version it was based on and that
 * product version (`productVersionOf`). `save` came from a save and is saved again once rebased, unless it overlaps someone else's change;
 * `keep` came from "Načíst aktuální verzi" and is only put back; `held` overlaps and waits for that button.
 */
export interface Refusal<V> {
  readonly base: V;
  readonly from: number;
  readonly mode: 'held' | 'keep' | 'save';
}

/** What a save refused over someone else's change records: the next read rebases the draft and saves it again. */
export const refusedSave = <V>(base: V, from: number): Refusal<V> => ({ base, from, mode: 'save' });

export interface DraftRebaseOptions<V> {
  /** The version the draft is based on and the product version its save names, for a conflict no save recorded. */
  readonly current: () => Omit<Refusal<V>, 'mode'>;
  /** Puts the operator's draft over the newer server version; `base` is the version the draft was based on. */
  readonly merge: (base: V, mine: V, theirs: V) => DraftMerge<V>;
  /** Re-reads the product. */
  readonly onReload: () => void;
  /** The refused save, recorded by the form's save (`refusedSave`); cleared once the draft is rebased. */
  readonly refusal: RefObject<Refusal<V> | undefined>;
  /** The product version the page read (`productVersionOf`); a refused save waits for a newer one. */
  readonly revision: number;
  /** The Save button. */
  readonly save: () => void;
  /** The product as the page has it now, in the draft's shape. */
  readonly server: V;
  /** The page still shows a read older than this form's last save: nothing is rebased until the newer read lands. */
  readonly stale: boolean;
  readonly status: SaveState;
  /** Continues from `server` (the conflict ends) with `merged` as the unsaved draft, based on the page's revision. */
  readonly take: (server: V, merged: V) => void;
  /** The form's draft. */
  readonly value: V;
}

/**
 * Rebases a draft after a refused save and returns "Načíst aktuální verzi". Call it after the form's draft hook: a
 * rebased draft is saved in an effect that has to run after the draft controller took the new draft in its own.
 */
export const useDraftRebase = <V>(options: DraftRebaseOptions<V>): (() => void) => {
  const { merge, onReload, refusal, revision, server, stale, status, take, value } = options;
  // Rebased saves that went out by themselves since the last save that went through or the operator's own reload.
  const rebases = useRef(0);
  const [retry, setRetry] = useState(false);
  const rebase = (conflict: Refusal<V>, mode: Refusal<V>['mode']) => {
    const { merged, overlap } = merge(conflict.base, value, server);
    const automatic = mode === 'save';
    if (automatic && (overlap || rebases.current >= AUTOMATIC_REBASES)) {
      refusal.current = { ...conflict, mode: 'held' };
      return;
    }
    refusal.current = undefined;
    take(server, merged);
    if (automatic) {
      rebases.current += 1;
      setRetry(true);
    }
  };
  // The read after a refused save landed (or the refusal found a newer read already on the page).
  const rebaseOnRead = useEffectEvent(() => {
    const conflict = refusal.current;
    if (conflict === undefined || conflict.mode === 'held' || stale || revision <= conflict.from) {
      return;
    }
    if (status === 'conflict') {
      rebase(conflict, conflict.mode);
    } else {
      // Discarded, or typed back to the confirmed version: nothing is left to put over the fresh version.
      refusal.current = undefined;
    }
  });
  useEffect(() => {
    rebaseOnRead();
  }, [revision, stale, status]);
  useEffect(() => {
    if (status === 'saved') {
      rebases.current = 0;
    }
  }, [status]);
  // The rebased draft is the form's draft by now: send it.
  const saveRebased = useEffectEvent(() => {
    setRetry(false);
    options.save();
  });
  useEffect(() => {
    if (retry) {
      saveRebased();
    }
  }, [retry]);
  return () => {
    // The operator asked: a later conflict may save again by itself.
    rebases.current = 0;
    const conflict: Refusal<V> = refusal.current ?? { ...options.current(), mode: 'keep' };
    if (!stale && revision > conflict.from) {
      rebase(conflict, 'keep');
      return;
    }
    refusal.current = { ...conflict, mode: 'keep' };
    onReload();
  };
};
