// A people dialog as the shared save bar and leave guard see it, derived from its effect-form state. Picking and typing
// change only the form; Uložit submits it once; a refusal keeps the values on screen with the server's reason; Zrušit
// and leaving the page with typed input ask first; an untouched dialog closes at once.
import { draftSavable, draftUnsaved, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SavableDraft, SaveState, UnsavedChangesGuard } from '@app/admin-ui';
import { useAtomSet, useAtomSubscribe, useAtomValue } from '@app/core-runtime/ui/form';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Equal, Option, Schema } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import type { Atom } from 'effect/reactivity';
import { useRef, useState } from 'react';

import type { PeopleOutcome } from './people-client.ts';

/**
 * Nothing was changed: the server refused the change, with its reason as the person reads it, or the values do not
 * make a change this dialog can send (Enter in an incomplete form), and nothing was sent.
 */
export class PeopleChangeNotSent extends Schema.TaggedError<PeopleChangeNotSent>()('PeopleChangeNotSent', {
  refusal: Schema.Option(Schema.String),
}) {}

/** The values make no change the dialog can send. */
export const incompleteChange = new PeopleChangeNotSent({ refusal: Option.none() });

/** The value of a people command that went through, or its refusal. */
export const acceptedValue = <A>(outcome: PeopleOutcome<A>): Effect.Effect<A, PeopleChangeNotSent> =>
  outcome.status === 'ok'
    ? Effect.succeed(outcome.value)
    : Effect.fail(new PeopleChangeNotSent({ refusal: Option.some(outcome.message) }));

/** A refusal is the form's own error, shown by the save bar; an incomplete form names nothing. */
export const peopleSubmitErrors = ({ refusal }: PeopleChangeNotSent) =>
  Option.match(refusal, { onNone: () => [], onSome: (message) => [{ message, path: '' as const }] });

/** The parts of a built people form the save reads. */
interface DialogForm<V, A> {
  readonly reset: Atom.Writable<void, void>;
  readonly rootError: Atom.Atom<Option.Option<string>>;
  readonly submit: Atom.AtomResultFn<void, A, unknown>;
  readonly submitCount: Atom.Atom<number>;
  readonly values: Atom.Atom<Option.Option<V>>;
}

export interface PeopleDialogSave {
  readonly guard: UnsavedChangesGuard;
  readonly record: SavableDraft;
  /** The refusal of the last save, while it still stands. */
  readonly refusal: string | null;
}

/**
 * The save bar status of one dialog form: untouched opening values are `idle`; a submitted value keeps the outcome of
 * its submit (`saved`, or `error` to send again) until it changes; any other value is `dirty` or `invalid`.
 */
export const usePeopleDialogSave = <V, A>({
  equals = Equal.equals,
  form,
  onSaved,
  opened,
  valid,
}: {
  /** Whether two values are the same change; structural equality by default. */
  readonly equals?: (left: V, right: V) => boolean;
  readonly form: DialogForm<V, A>;
  /** The submit went through: the dialog hands its result on. */
  readonly onSaved: (value: A) => void;
  /** The values the dialog opens with, which are not typed input. */
  readonly opened: V;
  /** Whether Uložit can send these values. */
  readonly valid: (values: V) => boolean;
}): PeopleDialogSave => {
  const values = Option.getOrElse(useAtomValue(form.values), () => opened);
  const result = useAtomValue(form.submit);
  const submitCount = useAtomValue(form.submitCount);
  const rootError = useAtomValue(form.rootError);
  const submit = useAtomSet(form.submit);
  const reset = useAtomSet(form.reset);
  // The values of the latest submit: the controls are locked while it runs, so they are the values it sent.
  const [sent, setSent] = useState({ count: submitCount, values });
  if (sent.count !== submitCount) {
    setSent({ count: submitCount, values });
  }
  const submitted = submitCount > 0 && equals(values, sent.values);
  const restingState = (): SaveState => {
    if (equals(values, opened)) {
      return 'idle';
    }
    return valid(values) ? 'dirty' : 'invalid';
  };
  const submittedState = (): SaveState => {
    if (AsyncResult.isSuccess(result)) {
      return 'saved';
    }
    if (AsyncResult.isFailure(result) && valid(values)) {
      return 'error';
    }
    return restingState();
  };
  const currentState = (): SaveState => {
    if (result.waiting) {
      return 'saving';
    }
    return submitted ? submittedState() : restingState();
  };
  const status = currentState();
  // Whoever started a save and acts on how it ended (the leave question's Uložit, then leaving).
  const waiting = useRef<{ readonly done: Set<(status: SaveState) => void>; saving: boolean }>({
    done: new Set(),
    saving: false,
  });
  useAtomSubscribe(
    form.submit,
    (next) => {
      if (next.waiting || AsyncResult.isInitial(next)) {
        return;
      }
      if (AsyncResult.isSuccess(next)) {
        onSaved(next.value);
      }
      const ended: SaveState = AsyncResult.isSuccess(next) ? 'saved' : 'error';
      const done = [...waiting.current.done];
      waiting.current.done.clear();
      waiting.current.saving = false;
      for (const answer of done) {
        answer(ended);
      }
    },
    { immediate: false },
  );
  const record: SavableDraft = {
    afterSave: (done) => {
      if (waiting.current.saving) {
        waiting.current.done.add(done);
        return;
      }
      done(status);
    },
    canSave: draftSavable(status),
    dirty: draftUnsaved(status),
    save: () => {
      if (waiting.current.saving || !draftSavable(status)) {
        return;
      }
      waiting.current.saving = true;
      submit();
    },
    status,
  };
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: () => reset() });
  return { guard, record, refusal: status === 'error' ? Option.getOrNull(rootError) : null };
};
