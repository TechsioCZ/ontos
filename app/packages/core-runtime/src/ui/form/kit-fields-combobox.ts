/**
 * The kit combobox bound to effect-form field state: one value, or any number of values, picked from a list the
 * person can type into to narrow it. A module hands these to `FormReact.make({ fields })`; every other combobox prop
 * (items or groups, loading, the kit's own list `error`, search text, open state) passes through to the kit
 * unchanged, the picked value lives in the form.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import type { ComboboxProps } from '@techsio/ui-kit/molecules/combobox';
import { Option } from 'effect';
import { createElement, useId } from 'react';

import { useFormContext } from './form-root.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type BoundComboboxProps = DistributiveOmit<
  ComboboxProps,
  'defaultValue' | 'multiple' | 'onChange' | 'validateStatus' | 'value'
> & {
  /** Marks the combobox invalid for a failure outside the form's own validation; `helpText` says why. */
  readonly invalid?: boolean;
};

type SingleComboboxProps = BoundComboboxProps & {
  /** Clearing the input keeps the picked value: only picking another item changes it. */
  readonly keepOnClear?: boolean;
};

/** The field's translated error wins over the help text; the kit shows help text only when it is non-empty. */
const useComboboxFeedback = (error: Option.Option<string>, props: BoundComboboxProps) => {
  const { pending, translate } = useFormContext();
  const generated = useId();
  const { disabled, helpText, id, invalid, ...rest } = props;
  const failed = Option.isSome(error) || invalid === true;
  return {
    ...rest,
    'aria-invalid': failed || undefined,
    disabled: pending || disabled === true,
    helpText: Option.isSome(error) ? translate(error.value) : (helpText ?? ''),
    id: id ?? generated,
    validateStatus: failed ? ('error' as const) : ('default' as const),
  };
};

/** One value picked from a combobox; `""` is no pick. */
export const ComboboxField: FormReact.FieldComponent<string, SingleComboboxProps> = ({ field, props }) => {
  const { keepOnClear = false, ...combobox } = props;
  const bound = useComboboxFeedback(field.error, combobox);
  return createElement(Combobox, {
    ...bound,
    multiple: false,
    name: bound.name ?? field.path,
    onChange: (value: string[]) => {
      const [picked] = value;
      if (picked === undefined && keepOnClear) {
        return;
      }
      field.onChange(picked ?? '');
      field.onBlur();
    },
    value: field.value === '' ? [] : [field.value],
  });
};

/** Any number of values picked from a combobox. */
export const MultiComboboxField: FormReact.FieldComponent<readonly string[], BoundComboboxProps> = ({
  field,
  props,
}) => {
  const bound = useComboboxFeedback(field.error, props);
  return createElement(Combobox, {
    ...bound,
    multiple: true,
    name: bound.name ?? field.path,
    onChange: (value: string[]) => {
      field.onChange(value);
      field.onBlur();
    },
    value: [...field.value],
  });
};
