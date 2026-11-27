/**
 * The kit select template of `SelectTemplateField` over a field whose value is not the chosen string itself: an array
 * that holds one member per list, or a value whose "none" the list offers as an item of its own. A module hands
 * `ChoiceLensField<Value>` to `FormReact.make({ fields })` and gives each rendering both directions: `read` names the
 * choice the value shows, `write` puts a choice into the value. Every other select template prop passes through.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its elements with
 * `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { createElement } from 'react';
import type { ReactElement } from 'react';

import { SelectTemplateField } from './kit-fields-select-template.ts';

type ChoiceLensProps<Value> = FormReact.ExtractExtraProps<typeof SelectTemplateField> & {
  /** The choice the field's value shows; `""` is no choice. */
  readonly read: (value: Value) => string;
  /** The field's value with `choice` put in; `""` is no choice. */
  readonly write: (value: Value, choice: string) => Value;
};

/** One choice from a list, read from and written into a field of any value. */
export const ChoiceLensField = <Value>({
  field,
  props,
}: FormReact.FieldComponentProps<Value, ChoiceLensProps<Value>>): ReactElement => {
  const { read, write, ...choice } = props;
  return createElement(SelectTemplateField, {
    field: {
      ...field,
      onChange: (next: string) => field.onChange(write(field.value, next)),
      value: read(field.value),
    },
    props: choice,
  });
};
