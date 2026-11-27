/**
 * The kit select bound to one effect-form field as a picker the person can empty again: one value
 * from a list, with a clear action named after what it drops and an optional warning that describes
 * the list (such as a lookup that did not run). A module hands it to `FormReact.make({ fields })`.
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

type StatusTextProps = ComponentProps<typeof Select.StatusText>;

interface ClearableChoiceProps {
  /** The accessible name of the clear action, naming the value it drops. */
  readonly clearLabel: string;
  readonly disabled?: boolean;
  readonly items: readonly FieldChoice[];
  readonly label: ReactNode;
  readonly placeholder?: string;
  /** A warning that describes the picker; `""` shows none. */
  readonly warning?: string;
}

/** One value chosen from a list, which its clear action empties again; `""` is no choice. */
export const ClearableChoiceField: FormReact.FieldComponent<string, ClearableChoiceProps> = ({ field, props }) => {
  const { pending, translate } = useFormContext();
  const { error } = field;
  // The hidden native option prints `displayValue`, so it carries the name a person reads, not the value.
  const items = props.items.map((item) => ({ displayValue: item.label, label: item.label, value: item.value }));
  const warning = props.warning ?? '';
  return jsx(Select, {
    children: createElement(
      Fragment,
      null,
      createElement(Select.Label, null, props.label),
      createElement(
        Select.Control,
        null,
        createElement(Select.Trigger, null, createElement(Select.ValueText, { placeholder: props.placeholder ?? '' })),
        createElement(Select.ClearTrigger, { 'aria-label': props.clearLabel }),
      ),
      Option.isSome(error)
        ? jsx(Select.StatusText, { children: translate(error.value), status: 'error' } satisfies StatusTextProps)
        : null,
      warning === ''
        ? null
        : jsx(Select.StatusText, { children: warning, status: 'warning' } satisfies StatusTextProps),
      createElement(
        Select.Positioner,
        null,
        createElement(
          Select.Content,
          null,
          items.map((item) =>
            createElement(Select.Item, { item, key: item.value }, createElement(Select.ItemText, null, item.label)),
          ),
        ),
      ),
    ),
    disabled: pending || props.disabled === true,
    items,
    name: field.path,
    onValueChange: (details) => {
      field.onChange(details.value[0] ?? '');
      field.onBlur();
    },
    validateStatus: Option.isSome(error) ? 'error' : 'default',
    // The kit clears a value its items no longer offer and reports that as a change; the form owns
    // the value, so the kit only sees the offered part and never writes a change the person did not make.
    value: items.some((item) => item.value === field.value) ? [field.value] : [],
  } satisfies ComponentProps<typeof Select>);
};
