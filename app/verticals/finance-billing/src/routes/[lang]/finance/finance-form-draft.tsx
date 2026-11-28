// The values of a module-level effect-form form as the draft of one finance form on screen.
import { useAtomSet, useAtomValue } from '@app/core-runtime/ui/form';
import { Option } from 'effect';
import type { Atom } from 'effect/reactivity';
import { useEffect, useState } from 'react';

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
 * the form, its atoms can still hold what an earlier mount left, so the draft is `opened` until `ready` (rendered
 * inside `FormRoot`) has mounted.
 */
export const useFormDraft = <V,>(form: ValuesForm<V>, opened: V) => {
  const [ready, setReady] = useState(false);
  const values = useAtomValue(form.values);
  return {
    draft: ready ? Option.getOrElse(values, () => opened) : opened,
    ready: <FormReady onReady={setReady} />,
    reset: useAtomSet(form.setValues),
  };
};
