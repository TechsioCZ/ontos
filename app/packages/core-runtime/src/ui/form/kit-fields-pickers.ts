/**
 * More kit controls bound to effect-form field state: a date picker, a searchable combobox, a numeric input, a
 * file picker, a kit select template and the row checkboxes of a selectable table. A module hands these to
 * `FormReact.make({ fields })`; it never renders the kit control with its own state.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Checkbox } from '@techsio/ui-kit/atoms/checkbox';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import type { ComboboxProps } from '@techsio/ui-kit/molecules/combobox';
import { DatePicker } from '@techsio/ui-kit/molecules/date-picker';
import type { DatePickerDayRootProps } from '@techsio/ui-kit/molecules/date-picker';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import type { SelectItem } from '@techsio/ui-kit/molecules/select';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import type { SelectTemplateProps } from '@techsio/ui-kit/templates/select';
import { Option, Predicate } from 'effect';
import { Fragment, createElement, useId } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

import { useFormContext } from './form-root.ts';

/** The translated field error, else a failure the caller reports for this control (such as a check of the whole form). */
const useControlFeedback = (error: Option.Option<string>, outside?: ReactNode) => {
  const { pending, translate } = useFormContext();
  const message: ReactNode = Option.isSome(error) ? translate(error.value) : outside;
  return { invalid: message !== undefined && message !== null && message !== false, message, pending };
};

/** The error under a compound control, as the kit's small status text. */
const ControlError = ({ message }: { readonly message: ReactNode }) =>
  jsx(StatusText, { children: message, showIcon: true, size: 'sm', status: 'error' });

type DateProps = Pick<DatePickerDayRootProps, 'locale' | 'max' | 'min' | 'required' | 'size' | 'translations'> & {
  /** Classes of the wrapper around the picker and its error. */
  readonly className?: string;
  readonly contentClassName?: string;
  readonly disabled?: boolean;
  /** A failure the caller reports for this date, shown under it when the field itself has no error. */
  readonly error?: ReactNode;
  /** The id of the date picker's wrapper, so a failed save can find it. */
  readonly id?: string;
  readonly label: ReactNode;
  readonly name?: string;
  readonly requiredLabel?: string;
  readonly segmentsClassName?: string;
  /** The picker's value of an ISO `YYYY-MM-DD` date, or null for text that is no date. */
  readonly toDateValue: (isoDate: string) => NonNullable<DatePickerDayRootProps['value']> | null;
};

/** A calendar day held as an ISO `YYYY-MM-DD` string; `""` is no date. */
export const DateField: FormReact.FieldComponent<string, DateProps> = ({ field, props }) => {
  const {
    className,
    contentClassName,
    disabled,
    error,
    id,
    label,
    name,
    requiredLabel,
    segmentsClassName,
    toDateValue,
    ...root
  } = props;
  const feedback = useControlFeedback(field.error, error);
  const picker: Omit<DatePickerDayRootProps, 'children'> = {
    ...root,
    disabled: feedback.pending || disabled === true,
    invalid: feedback.invalid,
    name: name ?? field.path,
    onValueChange: (details) => {
      field.onChange(details.value === null ? '' : details.valueAsString);
      field.onBlur();
    },
    value: toDateValue(field.value),
  };
  const wrapper: ComponentProps<'div'> = {};
  if (className !== undefined) {
    wrapper.className = className;
  }
  if (id !== undefined) {
    wrapper.id = id;
  }
  const labelProps: ComponentProps<typeof DatePicker.Label> = {};
  if (requiredLabel !== undefined) {
    labelProps.requiredLabel = requiredLabel;
  }
  return createElement(
    'div',
    wrapper,
    jsx(DatePicker, {
      ...picker,
      children: createElement(
        Fragment,
        null,
        createElement(DatePicker.Label, labelProps, label),
        createElement(
          DatePicker.Control,
          null,
          createElement(DatePicker.Segments, { className: segmentsClassName ?? '' }),
          createElement(DatePicker.IndicatorGroup, null, createElement(DatePicker.Trigger)),
        ),
        createElement(
          DatePicker.Positioner,
          null,
          createElement(DatePicker.Content, { className: contentClassName ?? '' }, createElement(DatePicker.Calendar)),
        ),
      ),
    } satisfies DatePickerDayRootProps),
    feedback.invalid ? createElement(ControlError, { message: feedback.message }) : null,
  );
};

type ComboProps = Omit<
  ComboboxProps,
  'defaultValue' | 'error' | 'groups' | 'items' | 'multiple' | 'onChange' | 'validateStatus' | 'value'
> & {
  /** A failure the caller reports for this choice, shown under it when the field itself has no error. */
  readonly error?: ReactNode;
  readonly items: NonNullable<ComboboxProps['items']>;
  /** Clearing the input keeps the chosen value: only picking another item changes it. */
  readonly keepOnClear?: boolean;
};

/** One value picked from a searchable list; `""` is no choice. The caller filters `items` by the typed text. */
export const ComboboxField: FormReact.FieldComponent<string, ComboProps> = ({ field, props }) => {
  const { disabled, error, keepOnClear = false, ...rest } = props;
  const feedback = useControlFeedback(field.error, error);
  return createElement(
    Fragment,
    null,
    jsx(Combobox, {
      ...rest,
      disabled: feedback.pending || disabled === true,
      name: rest.name ?? field.path,
      onChange: (value: string[]) => {
        const [picked] = value;
        if (picked === undefined && keepOnClear) {
          return;
        }
        field.onChange(picked ?? '');
        field.onBlur();
      },
      validateStatus: feedback.invalid ? 'error' : 'default',
      value: field.value === '' ? [] : [field.value],
    } satisfies ComboboxProps),
    feedback.invalid ? createElement(ControlError, { message: feedback.message }) : null,
  );
};

type NumberProps = Omit<
  ComponentProps<typeof FormNumericInput>,
  'children' | 'defaultValue' | 'id' | 'onChange' | 'validateStatus' | 'value'
> & {
  /** A failure the caller reports for this number, shown as its help text when the field itself has no error. */
  readonly error?: ReactNode;
  readonly id?: string;
};

/**
 * A number typed in the kit's numeric input. Text that is no number is `NaN`: the field then leaves the input
 * uncontrolled, so the typed text stays visible next to the error that names it.
 */
export const NumberField: FormReact.FieldComponent<number, NumberProps> = ({ field, props }) => {
  const { disabled, error, helpText, id, ...rest } = props;
  const feedback = useControlFeedback(field.error, error);
  const generated = useId();
  const input: ComponentProps<typeof FormNumericInput> = {
    ...rest,
    children: createElement(NumericInput.Control, null, createElement(NumericInput.Input)),
    disabled: feedback.pending || disabled === true,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (value: number) => field.onChange(value),
    validateStatus: feedback.invalid ? 'error' : 'default',
  };
  const shownHelp = feedback.invalid ? feedback.message : helpText;
  if (shownHelp !== undefined) {
    input.helpText = shownHelp;
  }
  if (Number.isFinite(field.value)) {
    input.value = field.value;
  }
  return jsx(FormNumericInput, input);
};

interface FileProps {
  readonly accept?: string;
  /** What the picker's label shows, such as an icon and "Nahrát soubor". */
  readonly children: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly id?: string;
}

/** Hidden from sight, still reachable: the picker's label is what the person sees and clicks. */
const visuallyHidden = {
  border: 0,
  clip: 'rect(0, 0, 0, 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;

/**
 * A file picked from the device, `null` while none is: a label the person clicks, with the native file input hidden
 * inside it. Picking the same file again changes nothing.
 */
export const FileField: FormReact.FieldComponent<File | null, FileProps> = ({ field, props }) => {
  const { pending } = useFormContext();
  const generated = useId();
  const id = props.id ?? generated;
  return createElement(
    'label',
    { className: props.className ?? '', htmlFor: id },
    props.children,
    createElement('input', {
      accept: props.accept ?? '',
      disabled: pending || props.disabled === true,
      id,
      name: field.path,
      onChange: (event: { readonly currentTarget: HTMLInputElement }) => {
        field.onChange(event.currentTarget.files?.[0] ?? null);
        field.onBlur();
      },
      style: visuallyHidden,
      type: 'file',
    }),
  );
};

type SelectProps = Omit<
  SelectTemplateProps,
  'defaultValue' | 'items' | 'multiple' | 'onValueChange' | 'validateStatus' | 'value'
> & {
  /** Marks the choice invalid for a failure outside the form, such as a check the caller shows itself. */
  readonly invalid?: boolean;
  readonly items: readonly SelectItem[];
};

/**
 * One value chosen from the kit's select template; `""` is no choice. Each option's text label also names its hidden
 * native option, which would otherwise read as the raw value (often an id).
 */
export const SelectField: FormReact.FieldComponent<string, SelectProps> = ({ field, props }) => {
  const { disabled, helpText, invalid = false, items, ...rest } = props;
  const feedback = useControlFeedback(field.error);
  const named = items.map((item) => ({
    ...item,
    displayValue: item.displayValue ?? (Predicate.isString(item.label) ? item.label : item.value),
  }));
  const select: SelectTemplateProps = {
    ...rest,
    disabled: feedback.pending || disabled === true,
    items: named,
    name: rest.name ?? field.path,
    onValueChange: (details) => {
      field.onChange(details.value[0] ?? '');
      field.onBlur();
    },
    validateStatus: feedback.invalid || invalid ? 'error' : 'default',
    // The kit clears a value its items no longer offer and reports that as a change; the form owns the value, so
    // the kit only sees the offered part and never writes a change the person did not make.
    value: named.some((item) => item.value === field.value) ? [field.value] : [],
  };
  const shownHelp = feedback.invalid ? feedback.message : helpText;
  if (shownHelp !== undefined) {
    select.helpText = shownHelp;
  }
  return jsx(SelectTemplate, select);
};

interface RowCheckboxProps {
  readonly 'aria-label': string;
  readonly disabled?: boolean;
  /** The row this checkbox adds to or removes from the selection. */
  readonly member: string;
}

/** The checkbox of one table row over an array field of selected row ids. */
export const RowCheckboxField: FormReact.FieldComponent<readonly string[], RowCheckboxProps> = ({ field, props }) => {
  const { pending } = useFormContext();
  const others = field.value.filter((member) => member !== props.member);
  return createElement(Checkbox, {
    'aria-label': props['aria-label'],
    checked: others.length < field.value.length,
    disabled: pending || props.disabled === true,
    name: field.path,
    onChange: (event: { readonly currentTarget: HTMLInputElement }) => {
      field.onChange(event.currentTarget.checked ? [...others, props.member] : others);
      field.onBlur();
    },
  });
};

interface AllRowsCheckboxProps {
  readonly 'aria-label': string;
  readonly disabled?: boolean;
  /** Every row the header checkbox selects. */
  readonly members: readonly string[];
}

/** The header checkbox of a selectable table: checked while every row is selected; it selects all rows or none. */
export const AllRowsCheckboxField: FormReact.FieldComponent<readonly string[], AllRowsCheckboxProps> = ({
  field,
  props,
}) => {
  const { pending } = useFormContext();
  return createElement(Checkbox, {
    'aria-label': props['aria-label'],
    checked: props.members.length > 0 && props.members.every((member) => field.value.includes(member)),
    disabled: pending || props.disabled === true,
    name: `${field.path}-all`,
    onChange: (event: { readonly currentTarget: HTMLInputElement }) => {
      field.onChange(event.currentTarget.checked ? [...props.members] : []);
      field.onBlur();
    },
  });
};
