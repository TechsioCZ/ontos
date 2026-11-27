/**
 * The kit switch bound to one boolean effect-form field, such as a setting or a filter that narrows a list at once.
 * A module hands it to `FormReact.make({ fields })`; the switch's label is its children.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import type { SwitchProps } from '@techsio/ui-kit/molecules/switch';
import { Option } from 'effect';
import { createElement, useId } from 'react';

import { useFormContext } from './form-root.ts';

type SwitchFieldProps = Omit<
  SwitchProps,
  'checked' | 'defaultChecked' | 'id' | 'onCheckedChange' | 'ref' | 'validateStatus'
> & { readonly id?: string };

/** A boolean value shown as a switch. The field's translated error wins over the help text. */
export const SwitchField: FormReact.FieldComponent<boolean, SwitchFieldProps> = ({ field, props }) => {
  const { disabled, helpText, id, ...rest } = props;
  const { pending, translate } = useFormContext();
  const generated = useId();
  return createElement(Switch, {
    ...rest,
    checked: field.value,
    disabled: pending || disabled === true,
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onCheckedChange: (checked) => {
      field.onChange(checked);
      field.onBlur();
    },
    validateStatus: Option.isSome(field.error) ? 'error' : 'default',
  } satisfies SwitchProps);
};
