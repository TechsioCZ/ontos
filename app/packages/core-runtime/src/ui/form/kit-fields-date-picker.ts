/**
 * The kit date picker bound to an effect-form field that holds a `YYYY-MM-DD` date; `""` is no date. A module hands
 * it to `FormReact.make({ fields })`; every other date picker prop (locale, translations, size, open state) passes
 * through to the kit unchanged.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its elements with
 * `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { DatePicker } from '@techsio/ui-kit/molecules/date-picker';
import type { DatePickerDayRootProps } from '@techsio/ui-kit/molecules/date-picker';
import { Option } from 'effect';
import { Fragment, createElement } from 'react';
import type { ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

import { useFormContext } from './form-root.ts';

type CalendarValue = NonNullable<DatePickerDayRootProps['value']>;

type BoundDatePickerProps = Omit<
  DatePickerDayRootProps,
  'children' | 'defaultValue' | 'invalid' | 'onValueChange' | 'value'
> & {
  /** Classes of the calendar popup, such as its layer when the picker sits in a dialog. */
  readonly contentClassName?: string;
  /** Marks the date invalid for a failure outside the form's own validation. */
  readonly invalid?: boolean;
  readonly label: ReactNode;
  /** The calendar value of a `YYYY-MM-DD` date: core runtime holds no calendar library, the module brings its own. */
  readonly parse: (isoDate: string) => CalendarValue;
  readonly requiredLabel?: string;
  /** Classes of the date segments. */
  readonly segmentsClassName?: string;
};

/** One calendar day, with its clear and calendar buttons; the field's translated error shows below it. */
export const DatePickerField: FormReact.FieldComponent<string, BoundDatePickerProps> = ({ field, props }) => {
  const { pending, translate } = useFormContext();
  const { contentClassName, disabled, invalid, label, parse, requiredLabel, segmentsClassName, ...rest } = props;
  const picker = jsx(DatePicker, {
    ...rest,
    children: createElement(
      Fragment,
      null,
      createElement(DatePicker.Label, requiredLabel === undefined ? null : { requiredLabel }, label),
      createElement(
        DatePicker.Control,
        null,
        createElement(DatePicker.Segments, segmentsClassName === undefined ? null : { className: segmentsClassName }),
        createElement(
          DatePicker.IndicatorGroup,
          null,
          createElement(DatePicker.ClearTrigger),
          createElement(DatePicker.Trigger),
        ),
      ),
      createElement(
        DatePicker.Positioner,
        null,
        createElement(
          DatePicker.Content,
          contentClassName === undefined ? null : { className: contentClassName },
          createElement(DatePicker.Calendar),
        ),
      ),
    ),
    disabled: pending || (disabled ?? false),
    invalid: Option.isSome(field.error) || invalid === true,
    name: rest.name ?? field.path,
    onValueChange: (details) => {
      field.onChange(details.value === null ? '' : details.valueAsString);
      field.onBlur();
    },
    value: field.value === '' ? null : parse(field.value),
  } satisfies DatePickerDayRootProps);
  return createElement(
    Fragment,
    null,
    picker,
    Option.isSome(field.error) ? jsx(StatusText, { children: translate(field.error.value), status: 'error' }) : null,
  );
};
