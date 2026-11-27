/**
 * Kit text controls bound to one effect-form field whose validity the module also judges itself: `invalid` marks
 * the control for a rule the field schema does not check, such as a number typed as text or a limit that depends on
 * other values. The field's own error still wins over the help text. A module hands these to
 * `FormReact.make({ fields })`.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { ComponentProps, ReactNode } from 'react';

import { useFormContext } from './form-root.ts';

type Ruled<Props> = Omit<Props, 'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'> & {
  readonly id?: string;
  /** The module's verdict on this value, for a rule the field schema does not check. */
  readonly invalid?: boolean;
};

/** The validation status and help text of a ruled field: its translated error wins over the help text. */
const useRuling = (error: Option.Option<string>, invalid = false, helpText?: ReactNode) => {
  const { pending, translate } = useFormContext();
  return {
    failed: Option.isSome(error) || invalid,
    helpText: Option.isSome(error) ? translate(error.value) : helpText,
    pending,
  };
};

/** A text value the module also judges. */
export const RuledTextField: FormReact.FieldComponent<string, Ruled<ComponentProps<typeof FormInput>>> = ({
  field,
  props,
}) => {
  const { disabled, helpText, id, invalid, ...rest } = props;
  const ruling = useRuling(field.error, invalid, helpText);
  const generated = useId();
  return createElement(FormInput, {
    ...rest,
    'aria-invalid': ruling.failed || undefined,
    disabled: ruling.pending || disabled,
    helpText: ruling.helpText,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: ruling.failed ? 'error' : 'default',
    value: field.value,
  });
};

/** A multi-line text value the module also judges. */
export const RuledTextAreaField: FormReact.FieldComponent<string, Ruled<ComponentProps<typeof FormTextarea>>> = ({
  field,
  props,
}) => {
  const { disabled, helpText, id, invalid, ...rest } = props;
  const ruling = useRuling(field.error, invalid, helpText);
  const generated = useId();
  return createElement(FormTextarea, {
    ...rest,
    'aria-invalid': ruling.failed || undefined,
    disabled: ruling.pending || disabled,
    helpText: ruling.helpText,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: ruling.failed ? 'error' : 'default',
    value: field.value,
  });
};
