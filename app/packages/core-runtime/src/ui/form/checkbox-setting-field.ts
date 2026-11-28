/**
 * A boolean setting: a checkbox with its own name that a person who may see the setting but not
 * change it gets read-only, showing the value without taking a click.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { ReactNode } from 'react';

import { useFormContext } from './form-root.ts';

export const CheckboxSettingField: FormReact.FieldComponent<
  boolean,
  {
    readonly disabled?: boolean;
    readonly helpText?: ReactNode;
    readonly id?: string;
    readonly label: ReactNode;
    readonly name?: string;
    /** The person may see the setting but not change it. */
    readonly readOnly?: boolean;
  }
> = ({ field, props }) => {
  const { pending, translate } = useFormContext();
  const generated = useId();
  const invalid = Option.isSome(field.error);
  return createElement(FormCheckbox, {
    checked: field.value,
    disabled: pending || (props.disabled ?? false),
    helpText: Option.isSome(field.error) ? translate(field.error.value) : props.helpText,
    id: props.id ?? generated,
    label: props.label,
    name: props.name ?? field.path,
    onCheckedChange: (checked) => {
      field.onChange(checked);
      field.onBlur();
    },
    readOnly: props.readOnly ?? false,
    validateStatus: invalid ? 'error' : 'default',
  });
};
