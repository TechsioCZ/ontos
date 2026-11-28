// The values of a module-level effect-form form as the draft of one agreements form on screen.
import { useAtomSet, useAtomSubscribe, useAtomValue } from '@app/core-runtime/ui/form';
import { Option } from 'effect';
import type { Atom } from 'effect/reactivity';
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

interface ValuesForm<V> {
  readonly setValues: Atom.Writable<V>;
  readonly values: Atom.Atom<Option.Option<V>>;
}

/** Rendered inside `FormRoot`, which renders its children only once this mount initialized the form. */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

/**
 * The draft a module-level form holds on this mount, and how to put a draft back into it. Until `FormRoot` initialized
 * the form, its atoms can still hold what an earlier mount left, so the draft is `opened` until `gate` (rendered
 * inside `FormRoot`) has mounted.
 */
export const useFormDraft = <V,>(form: ValuesForm<V>, opened: V) => {
  const [ready, setReady] = useState(false);
  const values = useAtomValue(form.values);
  return {
    draft: ready ? Option.getOrElse(values, () => opened) : opened,
    gate: <FormReady onReady={setReady} />,
    ready,
    reset: useAtomSet(form.setValues),
  };
};

type TextValues = Readonly<Record<string, string>>;

const sameText = <V extends TextValues>(left: V, right: V): boolean =>
  Object.keys(left).every((key) => left[key] === right[key]);

/** Where the typed fields of a record draft are, and how a draft takes typed fields. */
export interface DraftFields<D, V extends TextValues> {
  readonly valuesOf: (draft: D) => V;
  readonly withValues: (draft: D, values: V) => D;
}

/**
 * A record draft (`useRecordDraft`) shown in a module-level form: typing changes the draft, and a draft that moves
 * without typing (Zahodit změny, the latest version, a newer server version) is written back into the form. Returns
 * the gate to render inside `FormRoot`.
 */
export const useRecordDraftForm = <D, V extends TextValues>(
  form: ValuesForm<V>,
  record: { readonly draft: D; readonly setDraft: Dispatch<SetStateAction<D>> },
  fields: DraftFields<D, V>,
) => {
  const { draft: values, gate, ready, reset } = useFormDraft(form, fields.valuesOf(record.draft));
  const { setDraft } = record;
  useAtomSubscribe(
    form.values,
    (next) => {
      if (ready && Option.isSome(next)) {
        setDraft((current) =>
          sameText(fields.valuesOf(current), next.value) ? current : fields.withValues(current, next.value),
        );
      }
    },
    { immediate: false },
  );
  // Only a draft that moved is written back: the form's own change already is the draft.
  const shownDraft = useRef(record.draft);
  useEffect(() => {
    if (!ready || shownDraft.current === record.draft) {
      return;
    }
    shownDraft.current = record.draft;
    const next = fields.valuesOf(record.draft);
    if (!sameText(values, next)) {
      reset(next);
    }
  }, [fields, ready, record.draft, reset, values]);
  return gate;
};
