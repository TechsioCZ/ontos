/**
 * The kit combobox bound to one effect-form field: one value picked from a list the person can type
 * into to narrow it. A module hands it to `FormReact.make({ fields })`; the typed text, the open
 * state and the offered items stay the caller's props, the picked value lives in the form.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import type { ComboboxItem, ComboboxProps } from '@techsio/ui-kit/molecules/combobox';
import { Option } from 'effect';
import { createElement, useId } from 'react';

import { useFormContext } from './form-root.ts';

/** The combobox of a list of items (not groups), as the field passes it to the kit. */
type ItemsComboboxProps = Extract<ComboboxProps, { readonly items: ComboboxItem[] }>;

type ComboboxFieldProps = Omit<ItemsComboboxProps, 'defaultValue' | 'id' | 'multiple' | 'onChange' | 'value'> & {
  readonly id?: string;
};

/** One value picked from a combobox; `""` is no pick. The field's translated error wins over the help text. */
export const ComboboxField: FormReact.FieldComponent<string, ComboboxFieldProps> = ({ field, props }) => {
  const { disabled, helpText, id, validateStatus, ...rest } = props;
  const { pending, translate } = useFormContext();
  const generated = useId();
  const invalid = Option.isSome(field.error);
  const shownHelp = Option.isSome(field.error) ? translate(field.error.value) : helpText;
  return createElement(Combobox, {
    ...rest,
    disabled: pending || disabled === true,
    helpText: shownHelp ?? '',
    id: id ?? generated,
    multiple: false,
    name: rest.name ?? field.path,
    onChange: (values: string[]) => {
      field.onChange(values[0] ?? '');
      field.onBlur();
    },
    validateStatus: invalid ? 'error' : (validateStatus ?? 'default'),
    value: field.value === '' ? [] : [field.value],
  } satisfies ItemsComboboxProps);
};
