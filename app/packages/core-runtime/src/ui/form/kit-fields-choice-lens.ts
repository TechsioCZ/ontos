/**
 * Bindings over a part of a field's value: the field holds a whole value and the control reads and writes one part of
 * it through `read` and `write`. They render the one binding of their kit control with the field narrowed to the
 * part, so they add no control of their own.
 *
 * `ChoiceLensField` is the kit select template of `SelectTemplateField` over a field whose value is not the chosen string itself: an array
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
import { TextField } from './kit-fields.ts';

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

export type TextLensProps<Value> = FormReact.ExtractExtraProps<typeof TextField> & {
  /** The text this input shows: its part of the field's value. */
  readonly read: (value: Value) => string;
  /** The field's value with `text` typed into this input's part. */
  readonly write: (value: Value, text: string) => Value;
};

/**
 * A labelled text input over one part of a field's value, such as one property of one entry of an array that a row
 * of an array field holds: effect-form gives item components only to an array of structs one level deep, so the field
 * holds the whole value and this input reads and writes its one part.
 */
export const TextLensField = <Value>({
  field,
  props,
}: FormReact.FieldComponentProps<Value, TextLensProps<Value>>): ReactElement => {
  const { read, write, ...text } = props;
  return createElement(TextField, {
    field: {
      ...field,
      onChange: (next: string) => field.onChange(write(field.value, next)),
      value: read(field.value),
    },
    props: text,
  });
};
