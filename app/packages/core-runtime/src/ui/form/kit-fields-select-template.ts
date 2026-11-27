/**
 * The kit select template bound to one effect-form field: one value picked from a list, with the template's own size,
 * label styling and help text, for selects that sit in a compact toolbar or keep a fixed native `name`. A module hands
 * it to `FormReact.make({ fields })`; the offered items stay the caller's props, the picked value lives in the form.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its elements with
 * `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import type { SelectTemplateProps } from '@techsio/ui-kit/templates/select';
import { Option } from 'effect';
import { createElement } from 'react';

import { useFormContext } from './form-root.ts';
import type { FieldChoice } from './kit-fields.ts';

type SelectTemplateFieldProps = Omit<
  SelectTemplateProps,
  'defaultValue' | 'items' | 'multiple' | 'onValueChange' | 'value'
> & {
  readonly items: readonly FieldChoice[];
};

/** One value picked from a select template; `""` is no pick. The field's translated error wins over the help text. */
export const SelectTemplateField: FormReact.FieldComponent<string, SelectTemplateFieldProps> = ({ field, props }) => {
  const { disabled, helpText, items, name, validateStatus, ...rest } = props;
  const { pending, translate } = useFormContext();
  const invalid = Option.isSome(field.error);
  // The native option prints `displayValue`, so it carries the label a person reads, never an id.
  const offered = items.map((item) => ({ displayValue: item.label, label: item.label, value: item.value }));
  return createElement(SelectTemplate, {
    ...rest,
    disabled: pending || disabled === true,
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    items: offered,
    multiple: false,
    name: name ?? field.path,
    onValueChange: (details) => {
      field.onChange(details.value[0] ?? '');
      field.onBlur();
    },
    validateStatus: invalid ? 'error' : (validateStatus ?? 'default'),
    // The kit clears a value its items no longer offer and reports that as a change; the form owns the value, so the
    // kit only sees an offered one and never writes a change the person did not make.
    value: offered.some((item) => item.value === field.value) ? [field.value] : [],
  } satisfies SelectTemplateProps);
};
