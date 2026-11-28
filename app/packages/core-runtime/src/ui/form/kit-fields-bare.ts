/**
 * Kit controls without a label of their own, bound to one effect-form field: a search box over a list or a
 * comment box, named by `aria-label` or by text next to it. A module hands these to `FormReact.make({ fields })`.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Textarea } from '@techsio/ui-kit/atoms/textarea';
import { Option } from 'effect';
import { createElement } from 'react';
import type { ComponentProps } from 'react';

import { useFormContext } from './form-root.ts';

type BareInputProps = Omit<
  ComponentProps<typeof Input>,
  'defaultValue' | 'onBlur' | 'onChange' | 'ref' | 'validateStatus' | 'value'
> & {
  /** The caller's verdict on the text, for a rule that reads more than this one value. */
  readonly invalid?: boolean | undefined;
};
type BareTextareaProps = Omit<
  ComponentProps<typeof Textarea>,
  'defaultValue' | 'onBlur' | 'onChange' | 'ref' | 'validateStatus' | 'value'
>;

/** A text value in a bare kit input, such as a search box; name it with `aria-label`. */
export const BareTextField: FormReact.FieldComponent<string, BareInputProps> = ({ field, props }) => {
  const { invalid: verdict = false, ...rest } = props;
  const { pending } = useFormContext();
  const invalid = Option.isSome(field.error) || verdict;
  return createElement(Input, {
    ...rest,
    'aria-invalid': invalid || undefined,
    disabled: pending || rest.disabled,
    name: rest.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: invalid ? 'error' : 'default',
    value: field.value,
  });
};

/** A multi-line text value in a bare kit textarea, such as a comment box; name it with `aria-label`. */
export const BareTextAreaField: FormReact.FieldComponent<string, BareTextareaProps> = ({ field, props }) => {
  const { pending } = useFormContext();
  const invalid = Option.isSome(field.error);
  return createElement(Textarea, {
    ...props,
    'aria-invalid': invalid || undefined,
    disabled: pending || props.disabled,
    name: props.name ?? field.path,
    onBlur: () => field.onBlur(),
    onChange: (event) => field.onChange(event.currentTarget.value),
    validateStatus: invalid ? 'error' : 'default',
    value: field.value,
  });
};
