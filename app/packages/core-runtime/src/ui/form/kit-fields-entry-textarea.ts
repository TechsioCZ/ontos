/**
 * The kit textarea bound to one entry of a record field of strings: a module that shows the same multi-line input
 * several times at once (one reason per decision on screen) keeps every entry in one effect-form field and renders
 * the field once per entry.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds its elements with
 * `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { ComponentProps, FC } from 'react';

import { useFormContext } from './form-root.ts';

type EntryTextareaProps = Omit<
  ComponentProps<typeof FormTextarea>,
  'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> & {
  /** The record key this textarea edits; a missing entry reads as `""`. */
  readonly entry: string;
  readonly id?: string;
};

/** A textarea per entry of a record field of strings. The field's translated error wins over the help text. */
export const EntryTextAreaField: FC<
  FormReact.FieldComponentProps<Readonly<Record<string, string>>, EntryTextareaProps>
> = ({ field, props }) => {
  const { disabled, entry, helpText, id, ...rest } = props;
  const { pending, translate } = useFormContext();
  const generated = useId();
  const failed = Option.isSome(field.error);
  return createElement(FormTextarea, {
    ...rest,
    'aria-invalid': failed || undefined,
    disabled: pending || disabled,
    helpText: Option.isSome(field.error) ? translate(field.error.value) : helpText,
    id: id ?? generated,
    name: rest.name ?? `${field.path}.${entry}`,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange({ ...field.value, [entry]: event.currentTarget.value }),
    validateStatus: failed ? 'error' : 'default',
    value: field.value[entry] ?? '',
  });
};
