/**
 * The kit's select template bound to one effect-form field: one value from a list in a picker that carries its own
 * size, such as a compact filter in a list's toolbar. A module hands it to `FormReact.make({ fields })`.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import type { SelectTemplateProps } from '@techsio/ui-kit/templates/select';
import { Option } from 'effect';
import { createElement } from 'react';

import { useFormContext } from './form-root.ts';

/** One choice; `displayValue` is the text of the chosen item when it differs from its label in the list. */
interface TemplateChoice {
  readonly displayValue?: string;
  readonly label: string;
  readonly value: string;
}

type TemplateChoiceProps = Omit<
  SelectTemplateProps,
  'defaultValue' | 'items' | 'multiple' | 'name' | 'onValueChange' | 'validateStatus' | 'value'
> & { readonly items: readonly TemplateChoice[] };

/** One value chosen from a list; `""` is no choice. */
export const TemplateChoiceField: FormReact.FieldComponent<string, TemplateChoiceProps> = ({ field, props }) => {
  const { pending, translate } = useFormContext();
  const { disabled, helpText, items, ...rest } = props;
  const failed = Option.isSome(field.error);
  return createElement(SelectTemplate, {
    ...rest,
    disabled: pending || (disabled ?? false),
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    items: items.map((item) => ({
      displayValue: item.displayValue ?? item.label,
      label: item.label,
      value: item.value,
    })),
    name: field.path,
    onValueChange: (details) => {
      field.onChange(details.value[0] ?? '');
      field.onBlur();
    },
    validateStatus: failed ? 'error' : 'default',
    value: field.value === '' ? [] : [field.value],
  });
};
