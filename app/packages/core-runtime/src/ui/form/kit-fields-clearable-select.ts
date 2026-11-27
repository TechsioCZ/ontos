/**
 * The kit select bound to effect-form field state, for one value the person can also clear: the select's own clear
 * action, named after the chosen item, sets the field to no choice. A `warning` describes the select, such as a
 * search for its items that failed.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Option } from 'effect';
import { Fragment, createElement } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

import { useFormContext } from './form-root.ts';
import type { FieldChoice } from './kit-fields.ts';

interface ClearableChoiceProps {
  /** The accessible name of the clear action for the chosen item's label (`""` while nothing is chosen). */
  readonly clearLabel: (chosen: string) => string;
  readonly disabled?: boolean;
  readonly items: readonly FieldChoice[];
  readonly label: ReactNode;
  /** Hears the person choose an item, or clear the choice (`""`); a value put into the form is not a choice. */
  readonly onChoose?: (value: string) => void;
  readonly placeholder?: string;
  /** Describes the select as a warning while there is no error. */
  readonly warning?: string | undefined;
}

/** One value chosen from a list, or cleared; `""` is no choice. */
export const ClearableChoiceField: FormReact.FieldComponent<string, ClearableChoiceProps> = ({ field, props }) => {
  const { pending, translate } = useFormContext();
  const failed = Option.isSome(field.error);
  // The kit's hidden native option prints `displayValue`: the label is the name a person reads.
  const items = props.items.map((item) => ({ displayValue: item.label, label: item.label, value: item.value }));
  const chosen = items.find((item) => item.value === field.value);
  const message = Option.match(field.error, { onNone: () => props.warning, onSome: translate });
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
          { 'aria-invalid': failed || undefined },
          createElement(Select.ValueText, { placeholder: props.placeholder ?? '' }),
        ),
        createElement(Select.ClearTrigger, { 'aria-label': props.clearLabel(chosen?.label ?? '') }),
      ),
      message === undefined
        ? null
        : createElement(Select.StatusText, { status: failed ? 'error' : 'warning' }, message),
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
    ),
    disabled: pending || props.disabled,
    items,
    name: field.path,
    onValueChange: (details) => {
      const value = details.value[0] ?? '';
      field.onChange(value);
      field.onBlur();
      props.onChoose?.(value);
    },
    validateStatus: failed ? 'error' : 'default',
    // The kit clears a value its items no longer offer and reports that as a change; the form owns
    // the value, so the kit only sees the offered part and never writes a change the person did not make.
    value: chosen === undefined ? [] : [chosen.value],
  } satisfies ComponentProps<typeof Select>);
};
