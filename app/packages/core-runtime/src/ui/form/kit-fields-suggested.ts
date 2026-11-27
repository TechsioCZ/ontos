/**
 * Kit text controls bound to an effect-form field that follows a suggested text until the person types. The field
 * holds `null` while it follows and the control shows the suggestion, so a suggestion that changes after the form
 * opened (a name that finished loading, another template) is never frozen into the value; typing stores the typed
 * text, also an empty one, and `null` makes the field follow again. A module hands these to
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

interface SuggestedProps {
  readonly disabled?: boolean | undefined;
  readonly helpText?: ReactNode;
  readonly id?: string | undefined;
  /** Marks the field invalid for a rule outside the form's own validation, such as one that reads the suggestion. */
  readonly invalid?: boolean | undefined;
  /** The text the field shows while the person has typed nothing. */
  readonly suggestion: string;
}

type SuggestedInputProps = Omit<
  ComponentProps<typeof FormInput>,
  'defaultValue' | 'disabled' | 'helpText' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> &
  SuggestedProps;
type SuggestedTextareaProps = Omit<
  ComponentProps<typeof FormTextarea>,
  'defaultValue' | 'disabled' | 'helpText' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> &
  SuggestedProps;

/** What both controls take from the field: the shown text, its change, and the error or help text under it. */
const useSuggested = (
  field: FormReact.FieldComponentProps<string | null>['field'],
  { disabled, helpText, id, invalid, suggestion }: SuggestedProps,
) => {
  const { pending, translate } = useFormContext();
  const generated = useId();
  const failed = Option.isSome(field.error) || invalid === true;
  return {
    'aria-invalid': failed || undefined,
    disabled: pending || disabled,
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    id: id ?? generated,
    name: field.path,
    onBlur: () => field.onBlur(),
    validateStatus: failed ? ('error' as const) : ('default' as const),
    value: field.value ?? suggestion,
  };
};

/** A single-line text that follows `suggestion` until the person types. */
export const SuggestedTextField: FormReact.FieldComponent<string | null, SuggestedInputProps> = ({ field, props }) => {
  const { disabled, helpText, id, invalid, suggestion, ...rest } = props;
  return createElement(FormInput, {
    ...useSuggested(field, { disabled, helpText, id, invalid, suggestion }),
    ...rest,
    onChange: (event) => field.onChange(event.currentTarget.value),
  });
};

/** A multi-line text that follows `suggestion` until the person types. */
export const SuggestedTextAreaField: FormReact.FieldComponent<string | null, SuggestedTextareaProps> = ({
  field,
  props,
}) => {
  const { disabled, helpText, id, invalid, suggestion, ...rest } = props;
  return createElement(FormTextarea, {
    ...useSuggested(field, { disabled, helpText, id, invalid, suggestion }),
    ...rest,
    onChange: (event) => field.onChange(event.currentTarget.value),
  });
};
