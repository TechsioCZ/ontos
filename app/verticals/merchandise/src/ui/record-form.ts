// An effect-form form whose values a record draft owns (`useRecordDraft`): the record keeps the draft, its explicit
// save, conflicts and rebases; the form holds what the controls show. Each follows the other.
import { useAtomSet, useAtomSubscribe } from '@app/core-runtime/ui/form';
import { Option } from 'effect';
import type { Atom } from 'effect/reactivity';
import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/** The parts of a built form the record follows. */
interface RecordForm<Values> {
  readonly setValues: Atom.Writable<Values>;
  readonly values: Atom.Atom<Option.Option<Values>>;
}

interface RecordFormOptions<Values, Draft> {
  /** The record's draft, as `useRecordDraft` returns it (the same object until the draft changes). */
  readonly draft: Draft;
  /** The draft the form's values stand for; `current` is the record's draft before them. */
  readonly draftOf: (values: Values, current: Draft) => Draft;
  readonly form: RecordForm<Values>;
  readonly setDraft: Dispatch<SetStateAction<Draft>>;
  readonly valuesOf: (draft: Draft) => Values;
}

/**
 * Keeps `form` and the record draft that owns its values in step: every edit in the form becomes the record's draft,
 * and any other draft of the record (a reloaded record, Zahodit změny, a rebase, the latest version) is put into the
 * form. Call it inside the form's `FormRoot`.
 */
export const useRecordForm = <Values, Draft>({
  draft,
  draftOf,
  form,
  setDraft,
  valuesOf,
}: RecordFormOptions<Values, Draft>): void => {
  const setValues = useAtomSet(form.setValues);
  // The draft this form last wrote into the record.
  const written = useRef(draft);
  useAtomSubscribe(
    form.values,
    (next) => {
      if (Option.isSome(next)) {
        setDraft((current) => {
          written.current = draftOf(next.value, current);
          return written.current;
        });
      }
    },
    { immediate: false },
  );
  useEffect(() => {
    if (draft !== written.current) {
      written.current = draft;
      setValues(valuesOf(draft));
    }
  }, [draft, setValues, valuesOf]);
};
