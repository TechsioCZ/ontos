/**
 * Kit controls bound to effect-form field state with a verdict of the caller's own: text fields the caller can also
 * mark invalid, and the row checkboxes of a selectable table. A module hands these to `FormReact.make({ fields })`;
 * it never renders the kit control with its own state.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Checkbox } from '@techsio/ui-kit/atoms/checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

import { useFormContext } from './form-root.ts';

/** The translated field error, else a failure the caller reports for this control (such as a check of the whole form). */
const useControlFeedback = (error: Option.Option<string>, outside?: ReactNode) => {
  const { pending, translate } = useFormContext();
  const message: ReactNode = Option.isSome(error) ? translate(error.value) : outside;
  return { invalid: message !== undefined && message !== null && message !== false, message, pending };
};

interface RowCheckboxCommon {
  readonly 'aria-label': string;
  readonly disabled?: boolean;
}

/** One row's checkbox (`member`), or the header checkbox over every row the table lists (`members`). */
type RowCheckboxProps = RowCheckboxCommon &
  (
    | { readonly member: string; readonly members?: never }
    | { readonly member?: never; readonly members: readonly string[] }
  );

/**
 * The row selection of a table over an array field of selected row ids. A row's checkbox adds or removes its row; the
 * header checkbox is checked while every listed row is selected, and selects all listed rows or none.
 */
export const RowCheckboxField: FormReact.FieldComponent<readonly string[], RowCheckboxProps> = ({ field, props }) => {
  const { pending } = useFormContext();
  const { member, members } = props;
  const disabled = pending || props.disabled === true;
  if (members !== undefined) {
    return createElement(Checkbox, {
      'aria-label': props['aria-label'],
      checked: members.length > 0 && members.every((listed) => field.value.includes(listed)),
      disabled,
      name: `${field.path}-all`,
      onChange: (event: { readonly currentTarget: HTMLInputElement }) => {
        field.onChange(event.currentTarget.checked ? [...members] : []);
        field.onBlur();
      },
    });
  }
  const others = field.value.filter((selected) => selected !== member);
  return createElement(Checkbox, {
    'aria-label': props['aria-label'],
    checked: others.length < field.value.length,
    disabled,
    name: field.path,
    onChange: (event: { readonly currentTarget: HTMLInputElement }) => {
      field.onChange(event.currentTarget.checked ? [...others, member] : others);
      field.onBlur();
    },
  });
};

type FlaggedTextareaProps = Omit<
  ComponentProps<typeof FormTextarea>,
  'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> & {
  readonly id?: string;
  /** The caller's verdict on the text, such as a length the schema does not bound, shown with its help text. */
  readonly invalid?: boolean;
};

/** A required multi-line text the caller can also mark invalid, with help text that explains why. */
export const FlaggedTextAreaField: FormReact.FieldComponent<string, FlaggedTextareaProps> = ({ field, props }) => {
  const { disabled, helpText, id, invalid = false, ...rest } = props;
  const feedback = useControlFeedback(field.error, helpText);
  const generated = useId();
  const failed = Option.isSome(field.error) || invalid;
  return jsx(FormTextarea, {
    ...rest,
    'aria-invalid': failed || undefined,
    disabled: feedback.pending || disabled === true,
    helpText: feedback.message,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: failed ? 'error' : 'default',
    value: field.value,
  } satisfies ComponentProps<typeof FormTextarea>);
};

type FlaggedInputProps = Omit<
  ComponentProps<typeof FormInput>,
  'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> & {
  readonly id?: string;
  /** The caller's verdict on the text, such as a rule over several fields, shown with its help text. */
  readonly invalid?: boolean;
};

/** A text value the caller can also mark invalid, with help text that explains why. */
export const FlaggedTextField: FormReact.FieldComponent<string, FlaggedInputProps> = ({ field, props }) => {
  const { disabled, helpText, id, invalid = false, ...rest } = props;
  const feedback = useControlFeedback(field.error, helpText);
  const generated = useId();
  const failed = Option.isSome(field.error) || invalid;
  return jsx(FormInput, {
    ...rest,
    'aria-invalid': failed || undefined,
    disabled: feedback.pending || disabled === true,
    helpText: feedback.message,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: failed ? 'error' : 'default',
    value: field.value,
  } satisfies ComponentProps<typeof FormInput>);
};
