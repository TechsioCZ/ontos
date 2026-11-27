/**
 * The kit numeric inputs bound to effect-form fields: a labelled number field, and a number input per item of an
 * array field. A module hands these to `FormReact.make({ fields })`.
 *
 * A labelled field holds the text as typed and the number it reads as (`NumberText`): the input shows the text, so a
 * trailing decimal comma survives a keystroke and typed text that is no number stays visible next to the error that
 * names it, and a reset to `""` empties the input. The kit reports an empty or unreadable input as `NaN`; the module's
 * validation decides what it means.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its elements with
 * `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { NumericInput } from '@techsio/ui-kit/atoms/numeric-input';
import type { NumericInputProps } from '@techsio/ui-kit/atoms/numeric-input';
import { FormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { Option, Schema } from 'effect';
import { createElement, useId } from 'react';
import { jsx } from 'react/jsx-runtime';
import type { ComponentProps, FC, ReactNode } from 'react';

import { useFormContext } from './form-root.ts';

/** The props of the input element inside the numeric control, such as its accessible name or a key handler. */
type NumberInputElementProps = ComponentProps<typeof NumericInput.Input>;

type NumericFieldProps = Omit<
  ComponentProps<typeof FormNumericInput>,
  'children' | 'defaultValue' | 'helpText' | 'id' | 'onChange' | 'onValueChange' | 'validateStatus' | 'value'
> & {
  /** Help text below the field; the field's translated error wins over it. */
  readonly helpText?: ReactNode;
  /**
   * Leaves `aria-valuemax` out: an input with no real maximum would otherwise announce the kit's default, the largest
   * safe integer.
   */
  readonly hideValueMax?: boolean;
  readonly id?: string;
  readonly inputProps?: NumberInputElementProps;
  /** The caller's verdict on the value, for a rule the field's schema does not check. */
  readonly invalid?: boolean | undefined;
};

/**
 * A localized number input's value: the text as typed and the number it reads as (`NaN` while it reads as none). The
 * text is what the input shows; checks read the number.
 */
export const NumberTextSchema = Schema.Struct({ number: Schema.Number, text: Schema.String });
export type NumberText = typeof NumberTextSchema.Type;

type ItemNumericProps = Omit<NumericInputProps, 'children' | 'defaultValue' | 'id' | 'onChange' | 'value'> & {
  /** The identity of the item this input edits. */
  readonly entry: string;
  readonly id?: string;
  readonly inputProps?: NumberInputElementProps;
};

/** How a number input reads and writes one item of an array field. */
export interface ItemNumber<Item> {
  readonly identify: (item: Item) => string;
  readonly read: (item: Item) => number;
  /** The array after the item `identity` took `value`. */
  readonly write: (items: readonly Item[], identity: string, value: number) => readonly Item[];
}

/** The kit shows an empty input for `""`; `NaN` is an empty or unreadable input. */
const shownNumber = (value: number): number | string => (Number.isFinite(value) ? value : '');

/** The control and input element of a numeric field; leaving the input marks the field touched. */
const numberInput = (inputProps: NumberInputElementProps | undefined, onLeave: () => void) =>
  createElement(
    NumericInput.Control,
    null,
    createElement(NumericInput.Input, {
      ...inputProps,
      onBlur: (event) => {
        inputProps?.onBlur?.(event);
        onLeave();
      },
    }),
  );

/** Input element props that leave the kit's `aria-valuemax` out: the input has no maximum to announce. */
const noValueMax = { 'aria-valuemax': Option.getOrUndefined(Option.none<number>()) };

/** A number with a label, kept as the text typed and the number it reads as. The field's error wins over the help text. */
export const NumericField: FormReact.FieldComponent<NumberText, NumericFieldProps> = ({ field, props }) => {
  const { disabled, helpText, hideValueMax = false, id, inputProps, invalid, ...rest } = props;
  const { pending, translate } = useFormContext();
  const generated = useId();
  const failed = Option.isSome(field.error) || invalid === true;
  return jsx(FormNumericInput, {
    ...rest,
    'aria-invalid': failed || undefined,
    children: numberInput(hideValueMax ? { ...inputProps, ...noValueMax } : inputProps, () => field.onBlur()),
    disabled: pending || disabled === true,
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    id: id ?? generated,
    name: rest.name ?? field.path,
    onValueChange: (details: { readonly value: string; readonly valueAsNumber: number }) =>
      field.onChange({ number: details.valueAsNumber, text: details.value }),
    validateStatus: failed ? 'error' : 'default',
    value: field.value.text,
  } satisfies ComponentProps<typeof FormNumericInput>);
};

/**
 * A number input per item of an array field, for items told apart by `identify`: it shows `read` of the item
 * `entry` names and writes a change through `write`, which may also change other items.
 */
export const makeItemNumericField = <Item>(
  lens: ItemNumber<Item>,
): FC<FormReact.FieldComponentProps<readonly Item[], ItemNumericProps>> =>
  function ItemNumericField({ field, props }) {
    const { disabled, entry, id, inputProps, invalid, ...rest } = props;
    const { pending } = useFormContext();
    const generated = useId();
    const item = field.value.find((candidate) => lens.identify(candidate) === entry);
    return jsx(NumericInput, {
      ...rest,
      children: numberInput(inputProps, () => field.onBlur()),
      disabled: pending || disabled === true,
      id: id ?? generated,
      invalid: Option.isSome(field.error) || invalid === true,
      name: rest.name ?? `${field.path}.${entry}`,
      onChange: (value: number) => field.onChange(lens.write(field.value, entry, value)),
      value: item === undefined ? '' : shownNumber(lens.read(item)),
    });
  };
