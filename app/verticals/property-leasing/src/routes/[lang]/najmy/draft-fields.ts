// The fields of an edit panel whose draft follows the server (`useRecordDraft`): the fields are an effect-form form.
// Typing changes the draft; the draft moving without typing (a newer server version, Zahodit změny, Načíst aktuální
// verzi) puts its values back into the fields.
import { useAtomSet, useAtomSubscribe, useAtomValue } from '@app/core-runtime/ui/form';
import { Equal, Option } from 'effect';
import type { Atom } from 'effect/reactivity';
import { useEffect, useRef } from 'react';

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold what an earlier mount left, so a reader takes the values only after `onReady`.
 */
export const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }): null => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

/** The parts of a built effect-form form the draft reads and writes. */
interface FieldsForm<Values> {
  readonly setValues: Atom.Writable<Values>;
  readonly values: Atom.Atom<Option.Option<Values>>;
}

export const useDraftFields = <Values, V>({
  draft,
  form,
  setDraft,
  toDraft,
  toValues,
}: {
  /** The record draft as it is now (`RecordDraft.draft`). */
  readonly draft: V;
  readonly form: FieldsForm<Values>;
  /** `RecordDraft.setDraft`. */
  readonly setDraft: (value: V) => void;
  readonly toDraft: (values: Values) => V;
  readonly toValues: (value: V) => Values;
}): void => {
  const values = useAtomValue(form.values);
  const setValues = useAtomSet(form.setValues);
  // The fields are the draft: a change of the fields changes it at once.
  useAtomSubscribe(
    form.values,
    (next) => {
      if (Option.isSome(next)) {
        setDraft(toDraft(next.value));
      }
    },
    { immediate: false },
  );
  // The draft also moves without typing: the fields follow it.
  const shown = useRef(draft);
  useEffect(() => {
    if (shown.current === draft) {
      return;
    }
    shown.current = draft;
    const wanted = toValues(draft);
    if (Option.exists(values, (current) => !Equal.equals(current, wanted))) {
      setValues(wanted);
    }
  }, [draft, setValues, toValues, values]);
};
