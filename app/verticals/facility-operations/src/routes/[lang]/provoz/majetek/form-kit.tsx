// Small form building blocks for the assets page (ui-kit FormInput / Select / FormTextarea / FormCheckbox).
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate as Select } from '@app/admin-ui/select-template';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect } from 'effect';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import { InFooter } from '../../../../ui/footer-slot.tsx';
import { FormSaveFooter, commandResult, useFormSave } from '../../../../ui/form-save.tsx';
import type { FormSubmitResult } from '../../../../ui/form-save.tsx';
import type { CommandOutcome } from '../../../../ui/use-agenda.ts';

export interface Option {
  readonly label: string;
  readonly value: string;
}

export const TextField = (props: {
  readonly helpText?: string;
  readonly id: string;
  readonly inputMode?: 'decimal' | 'numeric' | 'text';
  readonly invalid?: boolean;
  readonly label: string;
  readonly maxLength?: number;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly type?: 'text' | 'date';
  readonly value: string;
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
  readonly helpText?: string;
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly required?: boolean;
  readonly value: string;
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

/** The body of a form without a save of its own (the card edit, whose save bar the panel renders). */
export const PanelFields = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex flex-col gap-200 py-200">{children}</div>
);

/** How the panel around a form runs the command the form built, and what follows a confirmed save. */
export interface AssetSubmit {
  /** The command went through: the host's toast, navigation and list refresh. */
  readonly onSaved: () => void;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}

/** An edit form: its save goes through the runner of the read its draft came from, and a conflict offers the latest. */
export interface PanelFormEdit {
  readonly onReloadLatest: () => void;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}

/**
 * The body of one assets form. Typing changes only the form's draft (`value`); the shared Uložit, rendered last in
 * the panel footer, builds the command (`command`, which says itself what is missing) and sends it once. Leaving
 * with typed input asks first; Enter never submits.
 */
export const PanelForm = <V,>(props: {
  readonly children: ReactNode;
  readonly command: () => OpsCommand | undefined;
  readonly edit?: PanelFormEdit | undefined;
  /** The form's own message for an incomplete draft. */
  readonly error: string | undefined;
  readonly onSubmit: AssetSubmit;
  /** The values the form opens with can be sent at once (a prefilled follow-up or archive reason). */
  readonly savableAtOnce?: boolean | undefined;
  readonly value: V;
}) => {
  const { t } = useModernI18n();
  const [failure, setFailure] = useState<string | undefined>();
  const run = props.edit?.run ?? props.onSubmit.run;
  const form = useFormSave({
    savableAtOnce: props.savableAtOnce,
    submit: () => {
      setFailure(undefined);
      const command = props.command();
      if (command === undefined) {
        return Effect.succeed<FormSubmitResult>('failed');
      }
      return run(command).pipe(
        Effect.map((outcome) =>
          commandResult(
            outcome,
            props.onSubmit.onSaved,
            (reason) => setFailure(t(`facility-operations.common.errors.${reason}`)),
            props.edit !== undefined,
          ),
        ),
      );
    },
    value: props.value,
  });
  return (
    <div className="flex flex-col gap-200 py-200">
      {props.children}
      <InFooter>
        <FormSaveFooter error={failure ?? props.error} form={form} onReloadLatest={props.edit?.onReloadLatest} />
      </InFooter>
    </div>
  );
};

/** Optional trimmed text: empty string → omitted key. */
export const optional = <Key extends string>(key: Key, value: string) => {
  const trimmed = value.trim();
  const fields: Partial<Record<Key, string>> = {};
  if (trimmed !== '') {
    fields[key] = trimmed;
  }
  return fields;
};
