/**
 * A kit text input bound to an effect-form text field that also shows a notice from outside the form, such as a
 * lookup's warning about the value the person typed: the field's own error wins, then the notice, then the help text.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its elements with
 * `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { ComponentProps, ReactNode } from 'react';

import { useFormContext } from './form-root.ts';

/** A message about a field's value from outside the form, and how serious it is. */
export interface FieldNotice {
  readonly status: 'error' | 'warning';
  readonly text: ReactNode;
}

type NoticedInputProps = Omit<
  ComponentProps<typeof FormInput>,
  'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> & {
  readonly id?: string;
  /** The notice about the value; none shows the help text. */
  readonly notice?: FieldNotice | null | undefined;
};

/** A required text value with an optional notice from outside the form. */
export const NoticedTextField: FormReact.FieldComponent<string, NoticedInputProps> = ({ field, props }) => {
  const { disabled, helpText, id, notice, ...rest } = props;
  const { pending, translate } = useFormContext();
  const generated = useId();
  const status = Option.isSome(field.error) ? 'error' : (notice?.status ?? 'default');
  return createElement(FormInput, {
    ...rest,
    'aria-invalid': status === 'error' || undefined,
    disabled: pending || disabled,
    helpText: Option.isSome(field.error) ? translate(field.error.value) : (notice?.text ?? helpText),
    id: id ?? generated,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: status,
    value: field.value,
  });
};
