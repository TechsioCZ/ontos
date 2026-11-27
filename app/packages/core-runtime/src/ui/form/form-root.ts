import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { Button } from '@techsio/ui-kit/atoms/button';
import type { ButtonProps } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Equal, Option } from 'effect';
import type { Atom } from 'effect/reactivity';
import { createContext, createElement, use, useState } from 'react';
import type { FC, FormHTMLAttributes, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

// Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
// its elements with `createElement`.

/** True while the form's submit runs: every bound control and the submit button are disabled. */
const PendingContext = createContext(false);

const untranslated = (message: string) => message;
/** Turns a validation or submit message (an i18n key) into the text the person reads. */
const TranslateContext = createContext(untranslated);

/** The translated error, the pending state and the module's translator a bound control reads. */
export const useFormContext = () => ({ pending: use(PendingContext), translate: use(TranslateContext) });

/** True while the enclosing form submits. */
export const useFormPending = (): boolean => use(PendingContext);

/** The parts of a built effect-form form that `FormRoot` drives. */
interface RootForm<Values> {
  readonly Initialize: FC<{ readonly children: ReactNode; readonly defaultValues: Values }>;
  readonly submit: Atom.AtomResultFn<void, unknown, unknown>;
  readonly validate: Atom.AtomResultFn<void, void>;
}

type RootFormProps<Values> = Omit<FormHTMLAttributes<HTMLFormElement>, 'action' | 'onSubmit' | 'children'> & {
  /**
   * True while the form must not submit at all, such as after a commit whose outcome is unknown:
   * the controls and the submit button are disabled and Enter submits nothing.
   */
  readonly blocked?: boolean;
  readonly children: ReactNode;
  readonly defaultValues: Values;
  readonly form: RootForm<Values>;
  /** The module's translator for validation and submit messages, which are i18n keys. */
  readonly translateMessage: (message: string) => string;
};

/**
 * The one `<form>` of module UI: it initializes the effect-form state, submits it on Enter or the
 * submit button and gives bound controls the pending state and the module's translator. Controls are
 * disabled while a submit or an explicit validation runs, so the form-level error always describes
 * the values that were checked.
 */
export const FormRoot = <Values>({
  blocked = false,
  children,
  defaultValues,
  form,
  translateMessage,
  ...formProps
}: RootFormProps<Values>) => {
  const submit = useAtomSet(form.submit);
  const result = useAtomValue(form.submit);
  const validation = useAtomValue(form.validate);
  // A check of the whole form reads the values it started with, so nothing changes while it runs.
  const checking = result.waiting || validation.waiting;
  const pending = checking || blocked;
  const element = createElement(
    'form',
    {
      ...formProps,
      'aria-busy': checking || undefined,
      noValidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        if (!pending) {
          submit();
        }
      },
    },
    jsx(form.Initialize, { children, defaultValues }),
  );
  return createElement(
    PendingContext,
    { value: pending },
    createElement(TranslateContext, { value: translateMessage }, element),
  );
};

/** The submit button of the enclosing `FormRoot`; it shows the pending state of the submit. */
export const SubmitButton = ({ disabled, ...props }: Omit<ButtonProps, 'type' | 'isLoading'>) => {
  const pending = useFormPending();
  return createElement(Button, { ...props, disabled: pending || disabled, isLoading: pending, type: 'submit' });
};

/** The parts of a built form that `FormRootError` reads. */
interface RootErrorForm {
  readonly rootError: Atom.Atom<Option.Option<string>>;
  readonly submitCount: Atom.Atom<number>;
  readonly validationCount: Atom.Atom<number>;
  readonly values: Atom.Atom<Option.Option<unknown>>;
}

/**
 * The form-level error: a whole-form refinement or a submit failure mapped to path `""`. effect-form
 * checks the whole form only on a submit or an explicit validation, so the error describes the values
 * of the latest of those: it shows while the values are still those, and hides once they change.
 */
export const FormRootError = ({ form }: { readonly form: RootErrorForm }) => {
  const translate = use(TranslateContext);
  const error = useAtomValue(form.rootError);
  const checks = useAtomValue(form.submitCount) + useAtomValue(form.validationCount);
  const values = useAtomValue(form.values);
  const [checked, setChecked] = useState({ checks, values });
  if (checked.checks !== checks) {
    setChecked({ checks, values });
  }
  const stale = checked.checks === checks && !Equal.equals(checked.values, values);
  return Option.isSome(error) && !stale
    ? jsx(StatusText, {
        'aria-live': 'polite',
        children: translate(error.value),
        showIcon: true,
        status: 'error',
      })
    : null;
};
