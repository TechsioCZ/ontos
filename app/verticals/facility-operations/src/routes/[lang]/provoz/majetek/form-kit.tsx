// Small form building blocks for the assets page (ui-kit FormInput / Select / FormTextarea / FormCheckbox).
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import type { FormEvent, ReactNode } from 'react';

export interface Option {
  readonly label: string;
  readonly value: string;
}

export const TextField = (props: {
  readonly helpText?: string;
  readonly id: string;
  readonly label: string;
  readonly maxLength?: number;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly type?: 'text' | 'date';
  readonly value: string;
  readonly invalid?: boolean;
  readonly inputMode?: 'decimal' | 'numeric' | 'text';
}) => (
  <FormInput
    autoComplete="off"
    id={props.id}
    inputMode={props.inputMode}
    label={props.label}
    maxLength={props.maxLength ?? 200}
    name={props.id}
    onChange={(event) => props.onChange(event.target.value)}
    required={props.required === true}
    type={props.type ?? 'text'}
    value={props.value}
    {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
    {...(props.helpText === undefined ? {} : { helpText: props.helpText })}
    {...(props.invalid === true ? { validateStatus: 'error' as const } : {})}
  />
);

export const AreaField = (props: {
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly required?: boolean;
  readonly value: string;
  readonly helpText?: string;
}) => (
  <FormTextarea
    id={props.id}
    label={props.label}
    maxLength={2000}
    name={props.id}
    onChange={(event) => props.onChange(event.target.value)}
    required={props.required === true}
    rows={3}
    value={props.value}
    {...(props.helpText === undefined ? {} : { helpText: props.helpText })}
  />
);

export const SelectField = (props: {
  readonly label: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly Option[];
  readonly value: string;
}) => (
  <Select
    items={props.options.map((option) => ({ displayValue: option.label, label: option.label, value: option.value }))}
    label={props.label}
    name={props.name}
    onValueChange={({ value }) => props.onChange(value[0] ?? '')}
    size="md"
    value={props.value === '' ? [] : [props.value]}
  />
);

export const CheckField = (props: {
  readonly checked: boolean;
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: boolean) => void;
}) => <FormCheckbox checked={props.checked} id={props.id} label={props.label} onCheckedChange={props.onChange} />;

export const FormGrid = ({ children }: { readonly children: ReactNode }) => (
  <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">{children}</div>
);

export const ErrorLine = ({ message }: { readonly message: string | undefined }) =>
  message === undefined ? null : (
    <StatusText showIcon status="error">
      {message}
    </StatusText>
  );

/** `<form>` whose submit button lives in the SidePanel footer (`form={id}`). */
export const PanelForm = (props: {
  readonly children: ReactNode;
  readonly id: string;
  readonly onSubmit: () => void;
}) => (
  <form
    className="flex flex-col gap-200 py-200"
    id={props.id}
    noValidate
    onSubmit={(event: FormEvent) => {
      event.preventDefault();
      props.onSubmit();
    }}
  >
    {props.children}
  </form>
);

/** Optional trimmed text: empty string → omitted key. */
export const optional = <Key extends string>(key: Key, value: string) => {
  const trimmed = value.trim();
  return (trimmed === '' ? {} : { [key]: trimmed }) as Partial<Record<Key, string>>;
};
