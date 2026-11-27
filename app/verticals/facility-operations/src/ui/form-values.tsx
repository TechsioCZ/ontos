// The values of a facility form while its FormRoot is mounted. A form's atoms outlive a mount, so until this mount
// initialized the form they can still hold what an earlier one left: the values read as the opening values then.
import { useAtomValue } from '@app/core-runtime/ui/form';
import { Option } from 'effect';
import type { Atom } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/** Rendered inside `FormRoot`, which renders its children only once this mount initialized the form. */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => {
    onReady(true);
    return () => {
      onReady(false);
    };
  }, [onReady]);
  return null;
};

export interface FormValues<V> {
  /** This mount initialized the form: `values` are the form's own. */
  readonly initialized: boolean;
  /** Render inside the form's `FormRoot`. */
  readonly ready: ReactNode;
  /** The form's values, or `opened` until this mount initialized the form. */
  readonly values: V;
}

/** The values a form shows on this mount; `opened` are the values its `FormRoot` initializes it with. */
export const useFormValues = <V,>(form: { readonly values: Atom.Atom<Option.Option<V>> }, opened: V): FormValues<V> => {
  const [ready, setReady] = useState(false);
  const values = useAtomValue(form.values);
  return {
    initialized: ready,
    ready: <FormReady onReady={setReady} />,
    values: ready ? Option.getOrElse(values, () => opened) : opened,
  };
};

/**
 * Forms of one shape kept per key, for a form that is on screen once per record (a comment's edit, a record's
 * composer): each key gets its own form the first time it is asked for, and the same one after that.
 */
export const keyedForms = <Form,>(make: () => Form): ((key: string) => Form) => {
  const forms = new Map<string, Form>();
  return (key) => {
    const known = forms.get(key);
    if (known !== undefined) {
      return known;
    }
    const made = make();
    forms.set(key, made);
    return made;
  };
};
