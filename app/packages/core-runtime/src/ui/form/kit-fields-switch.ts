/**
 * The kit switch bound to one boolean effect-form field. A module hands it to `FormReact.make({ fields })`.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { ComponentProps } from 'react';

import { useFormContext } from './form-root.ts';

type SwitchProps = Omit<
  ComponentProps<typeof Switch>,
  'checked' | 'defaultChecked' | 'id' | 'onCheckedChange' | 'ref' | 'validateStatus' | 'value'
> & { readonly id?: string };

/** A boolean value as a switch; its children are the label. */
export const SwitchField: FormReact.FieldComponent<boolean, SwitchProps> = ({ field, props }) => {
  const { pending, translate } = useFormContext();
  const generated = useId();
  const { disabled, helpText, id, ...rest } = props;
  const invalid = Option.isSome(field.error);
  return createElement(Switch, {
    ...rest,
    checked: field.value,
    disabled: pending || (disabled ?? false),
    helpText: invalid ? translate(Option.getOrThrow(field.error)) : helpText,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onCheckedChange: (checked) => {
      field.onChange(checked);
      field.onBlur();
    },
    validateStatus: invalid ? 'error' : 'default',
  });
};
