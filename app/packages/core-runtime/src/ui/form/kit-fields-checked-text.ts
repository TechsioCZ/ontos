/**
 * The kit text input bound to effect-form field state, for a field the caller checks together with the rest of its
 * draft: a rule that reads other fields or data outside the form, such as "required once any detail is filled in".
 * The caller passes its verdict on this field as `invalid` and the reason as `helpText`; an error of the field's own
 * schema still wins.
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

type CheckedInputProps = Omit<
  ComponentProps<typeof FormInput>,
  'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> & {
  readonly id?: string;
  /** The caller's verdict on this field, for a draft whose rules check it only as a whole. */
  readonly invalid?: boolean;
};

/** A text value checked by the caller with the rest of its draft. */
export const CheckedTextField: FormReact.FieldComponent<string, CheckedInputProps> = ({ field, props }) => {
  const { disabled, helpText, id, invalid, ...rest } = props;
  const { pending, translate } = useFormContext();
  const generated = useId();
  const failed = Option.isSome(field.error) || invalid === true;
  return createElement(FormInput, {
    ...rest,
    'aria-invalid': failed || undefined,
    disabled: pending || disabled,
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: failed ? 'error' : 'default',
    value: field.value,
  });
};
