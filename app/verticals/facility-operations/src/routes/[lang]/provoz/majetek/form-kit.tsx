// Building blocks of the assets forms: the panel form around a form's bindings, its layout and its error line.
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { requiredLabelFor } from '@app/admin-ui';
import { FormRoot } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Predicate } from 'effect';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import { InFooter } from '../../../../ui/footer-slot.tsx';
import { FormSaveFooter, commandResult, useFormSave } from '../../../../ui/form-save.tsx';
import type { FormSubmitResult } from '../../../../ui/form-save.tsx';
import { useFormValues } from '../../../../ui/form-values.tsx';
import type { CommandOutcome } from '../../../../ui/use-agenda.ts';

export interface Option {
  readonly label: string;
  readonly value: string;
}

/** What every assets text input had: no autofill, and at most 200 characters unless it says otherwise. */
export const textInput = { autoComplete: 'off', maxLength: 200 } as const;

/** What every assets text area had: at most 2000 characters on three rows. */
export const textArea = { maxLength: 2000, rows: 3 } as const;

/** A required field: marked, with the page language's hidden text. */
export const useRequired = () => {
  const { language } = useModernI18n();
  return { required: true, requiredLabel: requiredLabelFor(language) } as const;
};

export const FormGrid = ({ children }: { readonly children: ReactNode }) => (
  <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">{children}</div>
);

export const ErrorLine = ({ message }: { readonly message: string | undefined }) =>
  message === undefined ? null : (
    <StatusText showIcon status="error">
      {message}
    </StatusText>
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

/** The form of one assets panel: `FormRoot`'s form, whose values are what it opens with and what it holds. */
type PanelFormForm<V> = Parameters<typeof FormRoot<V>>[0]['form'] & Parameters<typeof useFormValues<V>>[0];

/**
 * The body of one assets form. Typing changes only the form's values; the shared Uložit, rendered last in the panel
 * footer, builds the command from them (`command`, which says itself what is missing) and sends it once. Leaving with
 * typed input asks first; Enter never submits.
 */
export const PanelForm = <V,>(props: {
  readonly children: ReactNode | ((values: V) => ReactNode);
  readonly command: (values: V) => OpsCommand | undefined;
  readonly edit?: PanelFormEdit | undefined;
  /** The form's own message for an incomplete draft. */
  readonly error: string | undefined;
  readonly form: PanelFormForm<V>;
  readonly onSubmit: AssetSubmit;
  /** The values the form opens with. */
  readonly opened: V;
  /** The values the form opens with can be sent at once (a prefilled follow-up or archive reason). */
  readonly savableAtOnce?: boolean | undefined;
}) => {
  const { t } = useModernI18n();
  const [failure, setFailure] = useState<string | undefined>();
  const { ready, values } = useFormValues(props.form, props.opened);
  const run = props.edit?.run ?? props.onSubmit.run;
  const form = useFormSave({
    savableAtOnce: props.savableAtOnce,
    submit: (value) => {
      setFailure(undefined);
      const command = props.command(value);
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
    value: values,
  });
  return (
    <FormRoot
      className="flex flex-col gap-200 py-200"
      defaultValues={props.opened}
      form={props.form}
      translateMessage={(message) => t(message)}
    >
      {ready}
      {Predicate.isFunction(props.children) ? props.children(values) : props.children}
      <InFooter>
        <FormSaveFooter error={failure ?? props.error} form={form} onReloadLatest={props.edit?.onReloadLatest} />
      </InFooter>
    </FormRoot>
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
