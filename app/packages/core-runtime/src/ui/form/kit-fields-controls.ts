/**
 * Kit controls bound to effect-form field state, with the kit's own props passed through: a bare input such as a
 * list's search box, a labelled input or textarea, a localized number input, a switch and a checkbox. A module hands
 * these to `FormReact.make({ fields })`; it never renders a kit form control with its own state.
 *
 * A form whose rules are its draft's own (a check that reads more than the field, such as a SKU the server refused)
 * passes its verdict as `invalid` with the message as `helpText`; a validation error of the field itself wins.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its elements with
 * `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Input } from '@techsio/ui-kit/atoms/input';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { Option, Schema } from 'effect';
import { createElement, useId } from 'react';
import { jsx } from 'react/jsx-runtime';
import type { ComponentProps, ReactNode } from 'react';

import { useFormContext } from './form-root.ts';

interface Verdict {
  /** The caller's verdict on this field, for a rule of the form's draft that reads more than this one value. */
  readonly invalid?: boolean | undefined;
}

type BareInputProps = Omit<
  ComponentProps<typeof Input>,
  'defaultValue' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> &
  Verdict;
type InputProps = Omit<
  ComponentProps<typeof FormInput>,
  'defaultValue' | 'onBlur' | 'onChange' | 'validateStatus' | 'value' | 'id'
> &
  Verdict & { readonly id?: string };
type TextareaProps = Omit<
  ComponentProps<typeof FormTextarea>,
  'defaultValue' | 'onBlur' | 'onChange' | 'validateStatus' | 'value' | 'id'
> &
  Verdict & { readonly id?: string };
type NumericProps = Omit<
  ComponentProps<typeof FormNumericInput>,
  'defaultValue' | 'onBlur' | 'onChange' | 'validateStatus' | 'value' | 'children' | 'id' | 'onValueChange'
> &
  Verdict & {
    /**
     * Leaves `aria-valuemax` out: an input with no real maximum would otherwise announce the kit's default, the
     * largest safe integer.
     */
    readonly hideValueMax?: boolean;
    readonly id?: string;
  };
type SwitchProps = Omit<
  ComponentProps<typeof Switch>,
  'checked' | 'defaultChecked' | 'onCheckedChange' | 'validateStatus'
> &
  Verdict;
type CheckboxProps = Omit<
  ComponentProps<typeof FormCheckbox>,
  'checked' | 'defaultChecked' | 'onCheckedChange' | 'validateStatus'
> &
  Verdict;

/**
 * A localized number input's value: the text as typed and the number it reads as (`NaN` while it reads as none). The
 * text is what the input shows, so a trailing decimal comma survives a keystroke; checks read the number.
 */
export const NumberTextSchema = Schema.Struct({ number: Schema.Number, text: Schema.String });
export type NumberText = typeof NumberTextSchema.Type;

/** The validation status and help text of a field: its translated error, else the caller's verdict. */
const useFeedback = (error: Option.Option<string>, helpText: ReactNode, { invalid = false }: Verdict) => {
  const { pending, translate } = useFormContext();
  return {
    helpText: Option.isSome(error) ? translate(error.value) : helpText,
    invalid: Option.isSome(error) || invalid,
    pending,
  };
};

const useFieldId = (id: string | undefined) => {
  const generated = useId();
  return id ?? generated;
};

const statusOf = (invalid: boolean) => (invalid ? 'error' : 'default');

/** A bare text input labelled by `aria-label`, such as the search box of a list. */
export const InputField: FormReact.FieldComponent<string, BareInputProps> = ({ field, props }) => {
  const { disabled, invalid, ...rest } = props;
  const feedback = useFeedback(field.error, undefined, { invalid });
  return createElement(Input, {
    ...rest,
    'aria-invalid': feedback.invalid || undefined,
    disabled: feedback.pending || disabled === true,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: statusOf(feedback.invalid),
    value: field.value,
  });
};

/** A labelled text value, with the kit's input props. */
export const FormInputField: FormReact.FieldComponent<string, InputProps> = ({ field, props }) => {
  const { disabled, helpText, id, invalid, ...rest } = props;
  const feedback = useFeedback(field.error, helpText, { invalid });
  return createElement(FormInput, {
    ...rest,
    'aria-invalid': feedback.invalid || undefined,
    disabled: feedback.pending || disabled === true,
    helpText: feedback.helpText,
    id: useFieldId(id),
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: statusOf(feedback.invalid),
    value: field.value,
  });
};

/** A labelled multi-line text value, with the kit's textarea props. */
export const FormTextareaField: FormReact.FieldComponent<string, TextareaProps> = ({ field, props }) => {
  const { disabled, helpText, id, invalid, ...rest } = props;
  const feedback = useFeedback(field.error, helpText, { invalid });
  return createElement(FormTextarea, {
    ...rest,
    'aria-invalid': feedback.invalid || undefined,
    disabled: feedback.pending || disabled === true,
    helpText: feedback.helpText,
    id: useFieldId(id),
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: statusOf(feedback.invalid),
    value: field.value,
  });
};

/** Input props that leave the kit's `aria-valuemax` out: the input has no maximum to announce. */
const noValueMax = { 'aria-valuemax': Option.getOrUndefined(Option.none<number>()) };

/** A localized number, kept as the text typed and the number it reads as (`NumberText`). */
export const NumericField: FormReact.FieldComponent<NumberText, NumericProps> = ({ field, props }) => {
  const { disabled, helpText, hideValueMax = false, id, invalid, ...rest } = props;
  const feedback = useFeedback(field.error, helpText, { invalid });
  return jsx(FormNumericInput, {
    ...rest,
    'aria-invalid': feedback.invalid || undefined,
    children: createElement(
      NumericInput.Control,
      null,
      createElement(NumericInput.Input, hideValueMax ? noValueMax : {}),
    ),
    disabled: feedback.pending || disabled === true,
    helpText: feedback.helpText,
    id: useFieldId(id),
    name: rest.name ?? field.path,
    onValueChange: (details: { readonly value: string; readonly valueAsNumber: number }) =>
      field.onChange({ number: details.valueAsNumber, text: details.value }),
    validateStatus: statusOf(feedback.invalid),
    value: field.value.text,
  } satisfies ComponentProps<typeof FormNumericInput>);
};

/** A boolean value as a switch; its children are the label. */
export const SwitchField: FormReact.FieldComponent<boolean, SwitchProps> = ({ field, props }) => {
  const { disabled, helpText, invalid, ...rest } = props;
  const feedback = useFeedback(field.error, helpText, { invalid });
  return createElement(Switch, {
    ...rest,
    checked: field.value,
    disabled: feedback.pending || disabled === true,
    helpText: feedback.helpText,
    name: rest.name ?? field.path,
    onCheckedChange: (checked) => {
      field.onChange(checked);
      field.onBlur();
    },
    validateStatus: statusOf(feedback.invalid),
  });
};

/** A boolean value as a checkbox, with the kit's checkbox props (size, class). */
export const FormCheckboxField: FormReact.FieldComponent<boolean, CheckboxProps> = ({ field, props }) => {
  const { disabled, helpText, invalid, ...rest } = props;
  const feedback = useFeedback(field.error, helpText, { invalid });
  return createElement(FormCheckbox, {
    ...rest,
    checked: field.value,
    disabled: feedback.pending || disabled === true,
    helpText: feedback.helpText,
    name: rest.name ?? field.path,
    onCheckedChange: (checked) => {
      field.onChange(checked);
      field.onBlur();
    },
    validateStatus: statusOf(feedback.invalid),
  });
};

/**
 * A field the form holds that no binding renders: a row's identity, or a value that a composite control without a
 * binding (a select template, a search combobox) reads and writes through the field's atoms.
 */
const Unrendered = () => null;

export const unrenderedField = <A>(): FormReact.FieldComponent<A> => Unrendered;
