/**
 * A kit switch per entry of a record field of booleans, such as one on/off choice per listed row. A
 * module hands it to `FormReact.make({ fields })` and renders the field once per entry it shows.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { FC, ReactNode } from 'react';

import { useFormContext } from './form-root.ts';

interface EntrySwitchProps {
  readonly disabled?: boolean;
  /** The record key this switch turns on and off; a missing entry reads as off. */
  readonly entry: string;
  readonly id?: string;
  readonly label: ReactNode;
  /** The name of the switch's native input; `<field>.<entry>` by default. */
  readonly name?: string;
}

export const EntrySwitchField: FC<
  FormReact.FieldComponentProps<Readonly<Record<string, boolean>>, EntrySwitchProps>
> = ({ field, props }) => {
  const { pending, translate } = useFormContext();
  const generated = useId();
  const invalid = Option.isSome(field.error);
  return createElement(
    Switch,
    {
      checked: field.value[props.entry] ?? false,
      disabled: pending || (props.disabled ?? false),
      helpText: Option.isSome(field.error) ? translate(field.error.value) : undefined,
      id: props.id ?? generated,
      name: props.name ?? `${field.path}.${props.entry}`,
      onCheckedChange: (checked: boolean) => {
        field.onChange({ ...field.value, [props.entry]: checked });
        field.onBlur();
      },
      validateStatus: invalid ? 'error' : 'default',
    },
    props.label,
  );
};
