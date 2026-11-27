/**
 * A labelled text input over one part of a field's value, such as one property of one entry of an array that a row of
 * an array field holds (a variant's parameters or quantity tiers): effect-form gives item components only to an array
 * of structs one level deep, so the field holds the whole value and this input reads and writes its one part.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its elements with
 * `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { ComponentProps, FC } from 'react';

import { useFormContext } from './form-root.ts';

export type PartInputProps<Value> = Omit<
  ComponentProps<typeof FormInput>,
  'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> & {
  readonly id?: string;
  /** The caller's verdict on this part, for a rule of the form's draft that reads more than this one value. */
  readonly invalid?: boolean | undefined;
  /** The text this input shows: its part of the field's value. */
  readonly read: (value: Value) => string;
  /** The field's value with `text` typed into this input's part. */
  readonly write: (value: Value, text: string) => Value;
};

const PartInputField = <Value>({ field, props }: FormReact.FieldComponentProps<Value, PartInputProps<Value>>) => {
  const { disabled, helpText, id, invalid = false, read, write, ...rest } = props;
  const { pending, translate } = useFormContext();
  const generated = useId();
  const failed = Option.isSome(field.error) || invalid;
  return createElement(FormInput, {
    ...rest,
    'aria-invalid': failed || undefined,
    disabled: pending || disabled === true,
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(write(field.value, event.currentTarget.value)),
    validateStatus: failed ? 'error' : 'default',
    value: read(field.value),
  });
};

/** A text input over one part of a field whose value is a `Value`; `read` and `write` name the part. */
export const makePartInputField = <Value>(): FC<FormReact.FieldComponentProps<Value, PartInputProps<Value>>> =>
  PartInputField;
