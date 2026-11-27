/**
 * The kit date picker bound to one effect-form field: a period of whole days, picked from the
 * calendar or typed into the segments. A module hands it to `FormReact.make({ fields })`; the
 * picker's locale, bounds, translations and event handlers stay the caller's props, the period lives
 * in the form.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { DatePicker } from '@techsio/ui-kit/molecules/date-picker';
import type { DatePickerDayRangeRootProps, DatePickerStatusTextProps } from '@techsio/ui-kit/molecules/date-picker';
import { Option } from 'effect';
import { Fragment, createElement } from 'react';
import type { ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

import { useFormContext } from './form-root.ts';

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
