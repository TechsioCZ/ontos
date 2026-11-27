/**
 * The kit select template bound to effect-form field state: one value chosen from items whose labels
 * may be rich (a colour swatch, an icon) next to the text a person reads. A module hands
 * `SelectTemplateField` to `FormReact.make({ fields })`; every other select template prop passes
 * through to the kit unchanged.
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

type BoundSelectTemplateProps = Omit<
  SelectTemplateProps,
  'defaultValue' | 'multiple' | 'onValueChange' | 'validateStatus' | 'value'
>;

/** One value chosen from a select template; `""` is no choice. */
export const SelectTemplateField: FormReact.FieldComponent<string, BoundSelectTemplateProps> = ({ field, props }) => {
  const { pending, translate } = useFormContext();
  const { disabled, helpText, ...rest } = props;
  const invalid = Option.isSome(field.error);
  return createElement(SelectTemplate, {
    ...rest,
    disabled: pending || (disabled ?? false),
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    name: rest.name ?? field.path,
    onValueChange: (details) => {
      field.onChange(details.value[0] ?? '');
      field.onBlur();
    },
    validateStatus: invalid ? 'error' : 'default',
    // The kit clears a value its items no longer offer and reports that as a change; the form owns
    // the value, so the kit only sees the offered part and never writes a change the person did not make.
    value: rest.items.some((item) => item.value === field.value) ? [field.value] : [],
  });
};
