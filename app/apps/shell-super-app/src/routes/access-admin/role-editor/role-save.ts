// The role editor as the shared save bar and leave guard see it. The edited cells are the draft; the server preview and
// the confirmation of every named effect are what make it savable, so Uložit stays disabled until they are done.
import type { SavableDraft, SaveState } from '@app/admin-ui';
import { Equal } from 'effect';
import { useRef } from 'react';

import { roleCellSlot } from './model.ts';
import type { RoleCellView, RoleEditorStatus } from './model.ts';

/** Whether two cell sets grant the same: the same slots with the same limits, in any order. */
export const sameRoleCells = (left: readonly RoleCellView[], right: readonly RoleCellView[]): boolean =>
  left.length === right.length &&
  left.every((cell) => right.some((other) => roleCellSlot(other) === roleCellSlot(cell) && Equal.equals(other, cell)));

/** The save bar's status of the role editor. */
export const roleSaveState = (status: RoleEditorStatus, changed: boolean, savable: boolean): SaveState => {
  if (status === 'saving' || status === 'saved' || status === 'conflict') {
    return status;
  }
  if (status === 'forbidden' || status === 'unauthenticated' || status === 'unavailable') {
    return 'error';
  }
  if (!changed) {
    return 'idle';
  }
  return savable ? 'dirty' : 'invalid';
};

/**
 * The editor's draft for the leave guard: unsaved while the cells differ from the saved role, saved by the same commit
 * as Uložit. `onSave` answers whether a commit started and calls `settle` when it ends, for whoever waits for it.
 */
export const useRoleDraft = ({
  changed,
  onSave,
  savable,
  saveState,
}: {
  readonly changed: boolean;
  /** Starts one commit and answers whether it started; the commit calls `settle` when it ends. */
  readonly onSave: (settle: (status: SaveState) => void) => boolean;
  readonly savable: boolean;
  readonly saveState: SaveState;
}): SavableDraft => {
  const inFlight = useRef(false);
  const waiting = useRef<((status: SaveState) => void)[]>([]);
  const settle = (status: SaveState) => {
    inFlight.current = false;
    for (const done of waiting.current.splice(0)) {
      done(status);
    }
  };
  return {
    afterSave: (done) => {
      if (inFlight.current) {
        waiting.current.push(done);
        return;
      }
      done(saveState);
    },
    canSave: savable,
    dirty: changed && saveState !== 'saved',
    save: () => {
      inFlight.current = onSave(settle);
    },
    status: saveState,
  };
};
