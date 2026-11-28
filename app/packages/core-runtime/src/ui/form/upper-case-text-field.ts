/**
 * A text value written in capitals, such as a business code: what the person types is upper-cased as
 * they type it, so the field always holds the code as it is stored.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { ComponentProps } from 'react';

import { useFormContext } from './form-root.ts';

type InputProps = Omit<
  ComponentProps<typeof FormInput>,
  'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> & { readonly id?: string };

export const UpperCaseTextField: FormReact.FieldComponent<string, InputProps> = ({ field, props }) => {
  const { disabled, helpText, id, ...rest } = props;
  const { pending, translate } = useFormContext();
  const generated = useId();
  const invalid = Option.isSome(field.error);
  return createElement(FormInput, {
    ...rest,
    'aria-invalid': invalid || undefined,
    disabled: pending || disabled,
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value.toUpperCase()),
    validateStatus: invalid ? 'error' : 'default',
    value: field.value,
  });
};
