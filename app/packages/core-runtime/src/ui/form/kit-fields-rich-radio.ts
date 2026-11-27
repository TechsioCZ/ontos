/**
 * The kit radio group bound to one effect-form field, for choices whose items carry their own content (an icon next to
 * the text) and whose group the caller lays out, such as a segmented switch. A module hands it to
 * `FormReact.make({ fields })`.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its elements with
 * `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { RadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { Option } from 'effect';
import { Fragment, createElement } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';

import { useFormContext } from './form-root.ts';

/** One choice of a rich radio group: its content is any node, its value a string. */
export interface RichChoice {
  readonly label: ReactNode;
  readonly value: string;
}

interface RichRadioProps {
  readonly disabled?: boolean;
  /** Classes of the group around the items, such as a segmented outline. */
  readonly itemGroupClassName?: string;
  readonly items: readonly RichChoice[];
  readonly label: ReactNode;
  readonly size?: NonNullable<ComponentProps<typeof RadioGroup>['size']>;
}

/** One value chosen from radio buttons with rich item content; `""` is no choice. */
export const RichRadioField: FormReact.FieldComponent<string, RichRadioProps> = ({ field, props }) => {
  const { pending, translate } = useFormContext();
  const invalid = Option.isSome(field.error);
  return jsx(RadioGroup, {
    children: createElement(
      Fragment,
      null,
      createElement(RadioGroup.Label, null, props.label),
      createElement(
        RadioGroup.ItemGroup,
        { 'aria-invalid': invalid || undefined, className: props.itemGroupClassName },
        props.items.map((item) =>
          createElement(
            RadioGroup.Item,
            { key: item.value, value: item.value },
            createElement(RadioGroup.ItemHiddenInput),
            createElement(RadioGroup.ItemControl),
            createElement(RadioGroup.ItemText, null, item.label),
          ),
        ),
      ),
      Option.isSome(field.error) ? createElement('span', { role: 'alert' }, translate(field.error.value)) : null,
    ),
    disabled: pending || props.disabled === true,
    name: field.path,
    onValueChange: (value) => {
      field.onChange(value ?? '');
      field.onBlur();
    },
    size: props.size ?? 'md',
    validateStatus: invalid ? 'error' : 'default',
    value: field.value,
  } satisfies ComponentProps<typeof RadioGroup>);
};
