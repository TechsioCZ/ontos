/**
 * The kit's form molecules bound to effect-form field state. A module hands these to
 * `FormReact.make({ fields })`; it never renders a kit form control with its own state.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { RadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Option } from 'effect';
import { Fragment, createElement, useId } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

import { useFormContext } from './form-root.ts';

type InputProps = Omit<
  ComponentProps<typeof FormInput>,
  'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> & { readonly id?: string };
type TextareaProps = Omit<
  ComponentProps<typeof FormTextarea>,
  'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> & { readonly id?: string };

/** One choice of a select or radio field. */
export interface FieldChoice {
  readonly label: string;
  readonly value: string;
}

interface ChoiceProps {
  /** The id of status text outside the field that describes it. */
  readonly describedBy?: string | undefined;
  readonly disabled?: boolean;
  /** Marks the choice invalid for a failure outside the form, such as an action the choice started. */
  readonly invalid?: boolean;
  readonly items: readonly FieldChoice[];
  readonly label: ReactNode;
  readonly placeholder?: string;
}

/** The validation status and help text of a field: its translated error wins over the help text. */
const useFieldFeedback = (error: Option.Option<string>, helpText?: ReactNode) => {
  const { pending, translate } = useFormContext();
  return {
    helpText: Option.isSome(error) ? translate(error.value) : helpText,
    invalid: Option.isSome(error),
    pending,
  };
};

const useFieldId = (id: string | undefined) => {
  const generated = useId();
  return id ?? generated;
};

/** A required text value. */
export const TextField: FormReact.FieldComponent<string, InputProps> = ({ field, props }) => {
  const { disabled, helpText, id, ...rest } = props;
  const feedback = useFieldFeedback(field.error, helpText);
  return createElement(FormInput, {
    ...rest,
    'aria-invalid': feedback.invalid || undefined,
    disabled: feedback.pending || disabled,
    helpText: feedback.helpText,
    id: useFieldId(id),
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: feedback.invalid ? 'error' : 'default',
    value: field.value,
  });
};

/** An optional text value of a payload `OptionFromNullOr` field: an empty input is `null`. */
export const OptionalTextField: FormReact.FieldComponent<string | null, InputProps> = ({ field, props }) => {
  const { disabled, helpText, id, ...rest } = props;
  const feedback = useFieldFeedback(field.error, helpText);
  return createElement(FormInput, {
    ...rest,
    'aria-invalid': feedback.invalid || undefined,
    disabled: feedback.pending || disabled,
    helpText: feedback.helpText,
    id: useFieldId(id),
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value === '' ? null : event.currentTarget.value),
    validateStatus: feedback.invalid ? 'error' : 'default',
    value: field.value ?? '',
  });
};

/** A required multi-line text value. */
export const TextAreaField: FormReact.FieldComponent<string, TextareaProps> = ({ field, props }) => {
  const { disabled, helpText, id, ...rest } = props;
  const feedback = useFieldFeedback(field.error, helpText);
  return createElement(FormTextarea, {
    ...rest,
    'aria-invalid': feedback.invalid || undefined,
    disabled: feedback.pending || disabled,
    helpText: feedback.helpText,
    id: useFieldId(id),
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: feedback.invalid ? 'error' : 'default',
    value: field.value,
  });
};

/** An optional multi-line text value of a payload `OptionFromNullOr` field. */
export const OptionalTextAreaField: FormReact.FieldComponent<string | null, TextareaProps> = ({ field, props }) => {
  const { disabled, helpText, id, ...rest } = props;
  const feedback = useFieldFeedback(field.error, helpText);
  return createElement(FormTextarea, {
    ...rest,
    'aria-invalid': feedback.invalid || undefined,
    disabled: feedback.pending || disabled,
    helpText: feedback.helpText,
    id: useFieldId(id),
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value === '' ? null : event.currentTarget.value),
    validateStatus: feedback.invalid ? 'error' : 'default',
    value: field.value ?? '',
  });
};

/** A boolean value. */
export const CheckboxField: FormReact.FieldComponent<
  boolean,
  {
    readonly disabled?: boolean;
    readonly helpText?: ReactNode;
    readonly id?: string;
    readonly label: ReactNode;
  }
> = ({ field, props }) => {
  const feedback = useFieldFeedback(field.error, props.helpText);
  return createElement(FormCheckbox, {
    checked: field.value,
    disabled: feedback.pending || (props.disabled ?? false),
    helpText: feedback.helpText,
    id: useFieldId(props.id),
    label: props.label,
    name: field.path,
    onCheckedChange: (checked) => {
      field.onChange(checked);
      field.onBlur();
    },
    validateStatus: feedback.invalid ? 'error' : 'default',
  });
};

/** The translated error of a compound control, announced next to it. */
const FieldAlert = ({ error, text }: { readonly error: Option.Option<string>; readonly text: ReactNode }) =>
  Option.isSome(error) ? createElement('span', { role: 'alert' }, text) : null;

const ChoiceSelect = ({
  error,
  multiple,
  onChange,
  path,
  props,
  value,
}: {
  readonly error: Option.Option<string>;
  readonly multiple: boolean;
  readonly onChange: (value: string[]) => void;
  readonly path: string;
  readonly props: ChoiceProps;
  readonly value: readonly string[];
}) => {
  const feedback = useFieldFeedback(error);
  const invalid = feedback.invalid || props.invalid === true;
  const items = props.items.map((item) => ({ displayValue: item.label, label: item.label, value: item.value }));
  return jsx(Select, {
    children: createElement(
      Fragment,
      null,
      createElement(Select.Label, null, props.label),
      createElement(
        Select.Control,
        null,
        createElement(
          Select.Trigger,
          { 'aria-describedby': props.describedBy, 'aria-invalid': invalid || undefined },
          createElement(Select.ValueText, { placeholder: props.placeholder ?? '' }),
        ),
      ),
      createElement(
        Select.Positioner,
        null,
        createElement(
          Select.Content,
          null,
          items.map((item) =>
            createElement(
              Select.Item,
              { item, key: item.value },
              createElement(Select.ItemText, null, item.label),
              createElement(Select.ItemIndicator),
            ),
          ),
        ),
      ),
      createElement(FieldAlert, { error, text: feedback.helpText }),
    ),
    disabled: feedback.pending || props.disabled,
    items,
    multiple,
    name: path,
    onValueChange: (details) => onChange(details.value),
    validateStatus: invalid ? 'error' : 'default',
    // The kit clears a value its items no longer offer and reports that as a change; the form owns
    // the value, so the kit only sees the offered part and never writes a change the person did not make.
    value: value.filter((selected) => items.some((item) => item.value === selected)),
  } satisfies ComponentProps<typeof Select>);
};

/** One value chosen from a list; `""` is no choice. */
export const ChoiceField: FormReact.FieldComponent<string, ChoiceProps> = ({ field, props }) =>
  createElement(ChoiceSelect, {
    error: field.error,
    multiple: false,
    onChange: (value) => {
      field.onChange(value[0] ?? '');
      field.onBlur();
    },
    path: field.path,
    props,
    value: field.value === '' ? [] : [field.value],
  });

/** Any number of values chosen from a list. */
export const MultiChoiceField: FormReact.FieldComponent<readonly string[], ChoiceProps> = ({ field, props }) =>
  createElement(ChoiceSelect, {
    error: field.error,
    multiple: true,
    onChange: (value) => {
      field.onChange(value);
      field.onBlur();
    },
    path: field.path,
    props,
    value: field.value,
  });

/** One value chosen from radio buttons; `""` is no choice. */
export const RadioField: FormReact.FieldComponent<string, ChoiceProps> = ({ field, props }) => {
  const feedback = useFieldFeedback(field.error);
  const invalid = feedback.invalid || props.invalid === true;
  return jsx(RadioGroup, {
    children: createElement(
      Fragment,
      null,
      createElement(RadioGroup.Label, null, props.label),
      createElement(
        RadioGroup.ItemGroup,
        { 'aria-describedby': props.describedBy, 'aria-invalid': invalid || undefined },
        props.items.map((item) =>
          createElement(
            RadioGroup.Item,
            { key: item.value, value: item.value },
            createElement(RadioGroup.ItemHiddenInput),
            createElement(RadioGroup.ItemControl),
            createElement(RadioGroup.ItemContent, null, createElement(RadioGroup.ItemText, null, item.label)),
          ),
        ),
      ),
      createElement(FieldAlert, { error: field.error, text: feedback.helpText }),
    ),
    disabled: feedback.pending || props.disabled,
    name: field.path,
    onValueChange: (value) => {
      field.onChange(value ?? '');
      field.onBlur();
    },
    validateStatus: invalid ? 'error' : 'default',
    value: field.value,
  } satisfies ComponentProps<typeof RadioGroup>);
};
