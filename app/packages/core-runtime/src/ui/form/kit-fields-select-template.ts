/**
 * The kit select template bound to one effect-form field: one value picked from a list whose labels may be rich (a
 * colour swatch, an icon) next to the text a person reads, with the template's own size, label styling and help
 * text. A module hands it to `FormReact.make({ fields })`; the offered items stay the caller's props, the picked
 * value lives in the form.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import type { SelectItem } from '@techsio/ui-kit/molecules/select';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import type { SelectTemplateProps } from '@techsio/ui-kit/templates/select';
import { Option, Predicate } from 'effect';
import { createElement } from 'react';

import { useFormContext } from './form-root.ts';

type SelectTemplateFieldProps = Omit<
  SelectTemplateProps,
  'defaultValue' | 'items' | 'multiple' | 'onValueChange' | 'validateStatus' | 'value'
> & {
  /** Marks the choice invalid for a failure outside the form, such as a check the caller shows itself. */
  readonly invalid?: boolean;
  readonly items: readonly SelectItem[];
};

/**
 * One value picked from a select template; `""` is no pick. The field's translated error wins over the help text.
 * Each option's text label also names its hidden native option, which would otherwise read as the raw value (often
 * an id).
 */
export const SelectTemplateField: FormReact.FieldComponent<string, SelectTemplateFieldProps> = ({ field, props }) => {
  const { disabled, helpText, invalid = false, items, ...rest } = props;
  const { pending, translate } = useFormContext();
  const named = items.map((item) => ({
    ...item,
    displayValue: item.displayValue ?? (Predicate.isString(item.label) ? item.label : item.value),
  }));
  const select: SelectTemplateProps = {
    ...rest,
    disabled: pending || disabled === true,
    items: named,
    multiple: false,
    name: rest.name ?? field.path,
    onValueChange: (details) => {
      field.onChange(details.value[0] ?? '');
      field.onBlur();
    },
    validateStatus: Option.isSome(field.error) || invalid ? 'error' : 'default',
    // The kit clears a value its items no longer offer and reports that as a change; the form owns the value, so the
    // kit only sees an offered one and never writes a change the person did not make.
    value: named.some((item) => item.value === field.value) ? [field.value] : [],
  };
  const shownHelp = Option.isSome(field.error) ? translate(field.error.value) : helpText;
  if (shownHelp !== undefined) {
    select.helpText = shownHelp;
  }
  return createElement(SelectTemplate, select);
};
