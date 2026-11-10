// A people form as the shared save bar and leave guard see it. Uložit never writes by itself: it opens the page's
// confirmation of the change, and only its confirm button sends the command. The values sent stay on screen; the
// page's feedback then tells whether they were saved.
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { useUnsavedChangesGuard } from '@app/admin-ui';
import type { SavableDraft, SaveState, UnsavedChangesGuard } from '@app/admin-ui';
import { Equal, Option } from 'effect';
import { useState } from 'react';

import type { PeopleFeedback, PeoplePendingChange } from './people-view-model.ts';

/** The save bar's status of values that were confirmed and sent, from the page's feedback of the last command. */
const sentState = (feedback: PeopleFeedback): SaveState => {
  if (feedback === 'saving' || feedback === 'saved' || feedback === 'conflict') {
    return feedback;
  }
  return feedback === 'idle' ? 'saving' : 'error';
};

export interface PeopleFormSave {
  readonly guard: UnsavedChangesGuard;
  /** Uložit: opens the confirmation of the change. */
  readonly handleSave: () => void;
  readonly saveState: SaveState;
}

export const usePeopleFormSave = <V>({
  empty,
  feedback,
  onDiscard,
  onReview,
  valid,
  value,
}: {
  /** The form as it opens, which is not typed input. */
  readonly empty: V;
  readonly feedback: PeopleFeedback;
  /** Puts the opening values back. */
  readonly onDiscard: () => void;
  /** Opens the confirmation of the change; `onConfirmed` runs once it is accepted and the command is sent. */
  readonly onReview: (onConfirmed: () => void) => void;
  readonly valid: boolean;
  readonly value: V;
}): PeopleFormSave => {
  const [sent, setSent] = useState<Option.Option<V>>(Option.none);
  const untouched = Equal.equals(value, empty);
  const isSent = Option.isSome(sent) && Equal.equals(value, sent.value);
  const editedState: SaveState = valid ? 'dirty' : 'invalid';
  const restingState: SaveState = untouched ? 'idle' : editedState;
  const saveState = isSent ? sentState(feedback) : restingState;
  const handleSave = () => onReview(() => setSent(Option.some(value)));
  const draft: SavableDraft = {
    // The confirmation decides; whoever asked to leave stays on the form until it is answered.
    afterSave: (done) => done(saveState),
    canSave: saveState === 'dirty' || saveState === 'error',
    dirty: !untouched && saveState !== 'saved',
    save: handleSave,
    status: saveState,
  };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => draft.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft,
    navigation: blocker,
    onDiscard: () => {
      setSent(Option.none());
      onDiscard();
    },
  });
  return { guard, handleSave, saveState };
};

/** Opens the page's confirmation of `change`; `onConfirmed` runs once it is accepted and the command is sent. */
export type PeopleReview = (change: PeoplePendingChange, onConfirmed: () => void) => void;

/** What a people form shares with the page: its feedback, the confirmation, and the refresh after a conflict. */
export interface PeopleFormContext {
  readonly feedback: PeopleFeedback;
  readonly onPreview: PeopleReview;
  readonly onRefresh: () => void;
}

/** The change waiting for the page's confirmation; `onConfirmed` tells the form that asked for it that it was sent. */
export type PendingReview = PeoplePendingChange & { readonly onConfirmed?: () => void; readonly revision: string };
