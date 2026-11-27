/**
 * The kit combobox and switch bound to effect-form field state. A module hands these to
 * `FormReact.make({ fields })`; every other combobox or switch prop (items, loading, search text,
 * open state) passes through to the kit unchanged.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import type { ComboboxProps } from '@techsio/ui-kit/molecules/combobox';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import type { SwitchProps } from '@techsio/ui-kit/molecules/switch';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { ReactNode } from 'react';

import { useFormContext } from './form-root.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type BoundComboboxProps = DistributiveOmit<
  ComboboxProps,
  'defaultValue' | 'multiple' | 'onChange' | 'validateStatus' | 'value'
> & {
  /** Marks the combobox invalid for a failure outside the form's own validation. */
  readonly invalid?: boolean;
};

type BoundSwitchProps = Omit<SwitchProps, 'checked' | 'defaultChecked' | 'onCheckedChange' | 'validateStatus'> & {
  readonly children?: ReactNode;
};

const useComboboxFeedback = (error: Option.Option<string>, props: BoundComboboxProps) => {
  const { pending, translate } = useFormContext();
  const generated = useId();
  const { disabled, helpText, id, invalid, ...rest } = props;
  const failed = Option.isSome(error) || invalid === true;
  return {
    ...rest,
    // The kit shows help text only when it is non-empty, so no help text is "".
    'aria-invalid': failed || undefined,
    disabled: pending || (disabled ?? false),
    helpText: Option.isSome(error) ? translate(error.value) : (helpText ?? ''),
    id: id ?? generated,
    validateStatus: failed ? ('error' as const) : ('default' as const),
  };
};

/** One value chosen from a combobox; `""` is no choice. */
export const ComboboxField: FormReact.FieldComponent<string, BoundComboboxProps> = ({ field, props }) => {
  const bound = useComboboxFeedback(field.error, props);
  return createElement(Combobox, {
    ...bound,
    name: bound.name ?? field.path,
    onChange: (value: string[]) => {
      field.onChange(value[0] ?? '');
      field.onBlur();
    },
    value: field.value === '' ? [] : [field.value],
  });
};

/** Any number of values chosen from a combobox. */
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

/** A boolean value shown as a switch. */
export const SwitchField: FormReact.FieldComponent<boolean, BoundSwitchProps> = ({ field, props }) => {
  const { pending, translate } = useFormContext();
  const generated = useId();
  const { disabled, helpText, id, ...rest } = props;
  return createElement(Switch, {
    ...rest,
    checked: field.value,
    disabled: pending || (disabled ?? false),
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onCheckedChange: (checked: boolean) => {
      field.onChange(checked);
      field.onBlur();
    },
    validateStatus: Option.isSome(field.error) ? 'error' : 'default',
  });
};
