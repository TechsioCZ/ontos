/**
 * The kit date picker bound to effect-form fields: one calendar day held as an ISO `YYYY-MM-DD` string, or a period
 * of whole days. A module hands these to `FormReact.make({ fields })`; the picker's locale, bounds, translations and
 * event handlers stay the caller's props, the date lives in the form.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DatePicker } from '@techsio/ui-kit/molecules/date-picker';
import type {
  DatePickerDayRangeRootProps,
  DatePickerDayRootProps,
  DatePickerStatusTextProps,
} from '@techsio/ui-kit/molecules/date-picker';
import { Option } from 'effect';
import { Fragment, createElement } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

import { useFormContext } from './form-root.ts';

type CalendarValue = NonNullable<DatePickerDayRootProps['value']>;

type DateFieldProps = Omit<
  DatePickerDayRootProps,
  'children' | 'defaultValue' | 'id' | 'invalid' | 'onValueChange' | 'value'
> & {
  /** Classes of the wrapper around the picker and its error. */
  readonly className?: string;
  /** Shows a button that clears the date. */
  readonly clearable?: boolean;
  /** Classes of the calendar popup, such as its layer when the picker sits in a dialog. */
  readonly contentClassName?: string;
  /** A failure the caller reports for this date, shown under it when the field itself has no error. */
  readonly error?: ReactNode;
  /** The id of the picker's wrapper, so a failed save can find it. */
  readonly id?: string;
  readonly label: ReactNode;
  readonly requiredLabel?: string;
  /** Classes of the date segments. */
  readonly segmentsClassName?: string;
  /** The calendar value of a `YYYY-MM-DD` date, or null for text that is no date: the module brings its calendar. */
  readonly toDateValue: (isoDate: string) => CalendarValue | null;
};

/** One calendar day; `""` is no date. The field's translated error, else the caller's `error`, shows below it. */
export const DateField: FormReact.FieldComponent<string, DateFieldProps> = ({ field, props }) => {
  const {
    className,
    clearable = false,
    contentClassName,
    disabled,
    error,
    id,
    label,
    requiredLabel,
    segmentsClassName,
    toDateValue,
    ...root
  } = props;
  const { pending, translate } = useFormContext();
  const message: ReactNode = Option.isSome(field.error) ? translate(field.error.value) : error;
  const failed = message !== undefined && message !== null && message !== false;
  const picker = jsx(DatePicker, {
    ...root,
    children: createElement(
      Fragment,
      null,
      createElement(DatePicker.Label, requiredLabel === undefined ? null : { requiredLabel }, label),
      createElement(
        DatePicker.Control,
        null,
        createElement(DatePicker.Segments, { className: segmentsClassName ?? '' }),
        createElement(
          DatePicker.IndicatorGroup,
          null,
          clearable ? createElement(DatePicker.ClearTrigger) : null,
          createElement(DatePicker.Trigger),
        ),
      ),
      createElement(
        DatePicker.Positioner,
        null,
        createElement(DatePicker.Content, { className: contentClassName ?? '' }, createElement(DatePicker.Calendar)),
      ),
    ),
    disabled: pending || disabled === true,
    invalid: failed,
    name: root.name ?? field.path,
    onValueChange: (details) => {
      field.onChange(details.value === null ? '' : details.valueAsString);
      field.onBlur();
    },
    value: field.value === '' ? null : toDateValue(field.value),
  } satisfies DatePickerDayRootProps);
  const wrapper: ComponentProps<'div'> = {};
  if (className !== undefined) {
    wrapper.className = className;
  }
  if (id !== undefined) {
    wrapper.id = id;
  }
  return createElement(
    'div',
    wrapper,
    picker,
    failed ? jsx(StatusText, { children: message, showIcon: true, size: 'sm', status: 'error' }) : null,
  );
};

/** A period of whole days as the kit picker holds it: its first and its last day, both included. */
export type DayRangeValue = NonNullable<DatePickerDayRangeRootProps['value']>;

type DateRangeFieldProps = Omit<
  DatePickerDayRangeRootProps,
  'children' | 'defaultValue' | 'endName' | 'name' | 'onValueChange' | 'selectionMode' | 'startName' | 'value'
> & {
  /** Classes of the calendar popup. */
  readonly contentClassName?: string;
  /** The accessible name of the last day's segments. */
  readonly endLabel: string;
  readonly label: ReactNode;
  /** Classes of the typed segments. */
  readonly segmentsClassName?: string;
  /** The accessible name of the first day's segments. */
  readonly startLabel: string;
};

/**
 * A period of whole days. The picker reports a period once both of its days are complete; the field
 * takes that period, and the field's translated error marks the picker invalid and shows beneath it.
 */
export const DateRangeField: FormReact.FieldComponent<DayRangeValue, DateRangeFieldProps> = ({ field, props }) => {
  const { contentClassName, disabled, endLabel, invalid, label, segmentsClassName, startLabel, ...root } = props;
  const { pending, translate } = useFormContext();
  const { error } = field;
  return jsx(DatePicker, {
    ...root,
    children: createElement(
      Fragment,
      null,
      createElement(DatePicker.Label, null, label),
      createElement(
        DatePicker.Control,
        null,
        createElement(DatePicker.Segments, { className: segmentsClassName ?? '', endLabel, startLabel }),
        createElement(DatePicker.IndicatorGroup, null, createElement(DatePicker.Trigger)),
      ),
      createElement(
        DatePicker.Positioner,
        null,
        createElement(DatePicker.Content, { className: contentClassName ?? '' }, createElement(DatePicker.Calendar)),
      ),
      Option.isSome(error)
        ? jsx(DatePicker.StatusText, {
            children: translate(error.value),
            status: 'error',
          } satisfies DatePickerStatusTextProps)
        : null,
    ),
    disabled: pending || disabled === true,
    invalid: Option.isSome(error) || invalid === true,
    onValueChange: (details) => {
      const [start, end] = details.value ?? [];
      if (start === undefined || end === undefined) {
        return;
      }
      field.onChange([start, end]);
      field.onBlur();
    },
    selectionMode: 'range',
    value: field.value,
  } satisfies DatePickerDayRangeRootProps);
};
