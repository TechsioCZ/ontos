/**
 * Kit controls bound to one effect-form field that holds a collection: a checkbox per member of an
 * array field, or an input per entry of a record field. A module hands these to
 * `FormReact.make({ fields })` and renders the field once per member or entry it shows.
 *
 * Core runtime is plain TypeScript that Node loads without a JSX transform, so this module builds
 * its elements with `createElement`.
 */
import type { FormReact } from '@lucas-barake/effect-form-react';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Option } from 'effect';
import { createElement, useId } from 'react';
import type { ComponentProps, FC, ReactNode } from 'react';

import { useFormContext } from './form-root.ts';

interface MemberCheckboxProps<Member> {
  readonly disabled?: boolean;
  readonly helpText?: ReactNode;
  readonly id?: string;
  readonly label: ReactNode;
  /** The member this checkbox adds to or removes from the array. */
  readonly member: Member;
}

type EntryInputProps = Omit<
  ComponentProps<typeof FormInput>,
  'defaultValue' | 'id' | 'onBlur' | 'onChange' | 'validateStatus' | 'value'
> & {
  /** The record key this input edits; a missing entry reads as `""`. */
  readonly entry: string;
  readonly id?: string;
  /** The caller's verdict on this one entry, for a record whose schema checks it only as a whole. */
  readonly invalid?: boolean;
};

/**
 * A checkbox per member of an array field, for members told apart by `identify`: checked while the
 * array holds a member of the same identity; checking replaces that member, unchecking removes it.
 */
export const makeMemberCheckboxField = <Member>(
  identify: (member: Member) => string,
): FC<FormReact.FieldComponentProps<readonly Member[], MemberCheckboxProps<Member>>> =>
  function MemberCheckboxField({ field, props }) {
    const { pending, translate } = useFormContext();
    const generated = useId();
    const identity = identify(props.member);
    const others = field.value.filter((member) => identify(member) !== identity);
    return createElement(FormCheckbox, {
      checked: others.length < field.value.length,
      disabled: pending || (props.disabled ?? false),
      helpText: Option.isSome(field.error) ? translate(field.error.value) : props.helpText,
      id: props.id ?? generated,
      label: props.label,
      name: field.path,
      onCheckedChange: (checked) => {
        field.onChange(checked ? [...others, props.member] : others);
        field.onBlur();
      },
      validateStatus: Option.isSome(field.error) ? 'error' : 'default',
    });
  };

/** A checkbox per string of an array field of distinct strings, such as selected ids. */
export const MemberCheckboxField = makeMemberCheckboxField((member: string) => member);

/** A text input per entry of a record field of strings, such as one amount per row. */
export const EntryTextField: FC<FormReact.FieldComponentProps<Readonly<Record<string, string>>, EntryInputProps>> = ({
  field,
  props,
}) => {
  const { disabled, entry, helpText, id, invalid, ...rest } = props;
  const { pending, translate } = useFormContext();
  const generated = useId();
  const failed = Option.isSome(field.error) || invalid === true;
  return createElement(FormInput, {
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
