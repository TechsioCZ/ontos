/**
 * The kit checkbox as a group over one array field: one checkbox per choice, and the field's error
 * once, under the group. A module hands `makeCheckboxGroupField<Member>()` to
 * `FormReact.make({ fields })` for a field of distinct members, such as the kinds a record applies to.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { Option } from 'effect';
import { createElement } from 'react';
import type { FC, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

import { useFormContext } from './form-root.ts';

/** One checkbox of the group: the member it ticks in or out. */
export interface CheckboxGroupChoice<Member extends string> {
  readonly label: ReactNode;
  readonly value: Member;
}

interface CheckboxGroupProps<Member extends string> {
  readonly className?: string;
  readonly disabled?: boolean;
  /** The choices, in the order the field keeps its members. */
  readonly items: readonly CheckboxGroupChoice<Member>[];
  readonly legend: ReactNode;
  readonly legendClassName?: string;
}

/**
 * A fieldset of checkboxes over an array field of `Member`s: checked while the array holds the member;
 * a tick keeps the members in the order of `items`.
 */
export const makeCheckboxGroupField = <Member extends string>(): FC<
  FormReact.FieldComponentProps<readonly Member[], CheckboxGroupProps<Member>>
> =>
  function CheckboxGroupField({ field, props }) {
    const { pending, translate } = useFormContext();
    const selected = new Set(field.value);
    const ticked = (member: Member, checked: boolean) =>
      props.items.flatMap(({ value }) => ((value === member ? checked : selected.has(value)) ? [value] : []));
    return createElement(
      'fieldset',
      { 'aria-invalid': Option.isSome(field.error) || undefined, className: props.className },
      createElement('legend', { className: props.legendClassName }, props.legend),
      props.items.map((item) =>
        createElement(
          FormCheckbox,
          {
            checked: selected.has(item.value),
            disabled: pending || (props.disabled ?? false),
            key: item.value,
            name: field.path,
            onCheckedChange: (checked) => {
              field.onChange(ticked(item.value, checked));
              field.onBlur();
            },
            value: item.value,
          },
          item.label,
        ),
      ),
      Option.isSome(field.error)
        ? jsx(StatusText, { children: translate(field.error.value), showIcon: true, status: 'error' })
        : null,
    );
  };
