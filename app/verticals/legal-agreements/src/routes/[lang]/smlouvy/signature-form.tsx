// The manual signature of a contract: signer, file name, reference and date are a draft until the shared Uložit
// records them once; Enter never records, and leaving the page with typed input asks first.
import {
  SaveBar,
  UnsavedChangesDialog,
  requiredLabelFor,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import { FormBuilder, FormReact, FormRoot, TextField } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Option, Predicate, Schema } from 'effect';
import { useState } from 'react';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { failureReasonOf, revisionedResultOf } from './agreements-command.ts';
import type { AgreementOutcome } from './agreements-command.ts';
import { useFormDraft } from './form-draft.tsx';

/**
 * What the person types for a manual signature, as typed: the draft text of the signed document. Uložit records it
 * through the save bar, so the form only holds it and Enter submits nothing.
 */
const signatureForm = FormReact.make(
  FormBuilder.empty
    .addField('signedBy', Schema.String)
    .addField('signedFileName', Schema.String)
    .addField('signedOn', Schema.String)
    .addField('signedReference', Schema.String),
  {
    fields: { signedBy: TextField, signedFileName: TextField, signedOn: TextField, signedReference: TextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** What the person types for a manual signature. */
export interface SignatureDraft {
  readonly signedBy: string;
  readonly signedFileName: string;
  readonly signedOn: string;
  readonly signedReference: string;
}

export const emptySignatureDraft: SignatureDraft = {
  signedBy: '',
  signedFileName: '',
  signedOn: '',
  signedReference: '',
};

const FIELDS = ['signedBy', 'signedFileName', 'signedReference', 'signedOn'] as const;

/** Every field is required: an incomplete signature is never sent. */
const validSignature = (draft: SignatureDraft): boolean => FIELDS.every((field) => draft[field].trim().length > 0);

export interface SignatureFormProps {
  /** The page is loading or running another command. */
  readonly busy: boolean;
  /** Records the signature once. */
  readonly onSave: (draft: SignatureDraft) => Effect.Effect<AgreementOutcome>;
  /** Re-reads the agreements for "Načíst aktuální verzi" after a conflict. */
  readonly reload: Effect.Effect<void>;
}

/** The page shows one signature form, for the selected contract, so the module-level form holds its one draft. */
export const SignatureForm = ({ busy, onSave, reload }: SignatureFormProps) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const requiredLabel = requiredLabelFor(language);
  const { draft, gate, reset } = useFormDraft(signatureForm, emptySignatureDraft);
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  const record = useDraftSave<SignatureDraft, never>({
    initial: emptySignatureDraft,
    isValid: validSignature,
    runtime: browserRuntime,
    save: (value) =>
      onSave(value).pipe(
        Effect.tap((outcome) => Effect.sync(() => setReason(failureReasonOf(outcome)))),
        Effect.map((outcome) => {
          const result = revisionedResultOf(outcome);
          return Predicate.isNumber(result) ? 'saved' : result;
        }),
      ),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => {
      setReason(Option.none());
      reset(record.confirmed);
    },
  });
  const saving = record.status === 'saving';
  const handleSave = record.save;
  // The typed signature stays; it is sent again, on Uložit, against the agreements as read now.
  const handleReloadLatest = () => {
    setReason(Option.none());
    record.adopt(emptySignatureDraft);
    browserRuntime.runFork(reload);
  };
  return (
    <FormRoot
      className="legalagreements:w-full legalagreements:space-y-3"
      defaultValues={emptySignatureDraft}
      form={signatureForm}
      translateMessage={(message) => t(message, { defaultValue: message })}
    >
      {gate}
      <p className="legalagreements:text-sm">{t('legal-agreements.demo.manualSignatureHint')}</p>
      {FIELDS.map((field) => {
        const Input = signatureForm[field];
        return (
          <Input
            disabled={busy || saving}
            id={`contract-${field}`}
            key={field}
            label={t(`legal-agreements.demo.${field}`)}
            required
            requiredLabel={requiredLabel}
            type={field === 'signedOn' ? 'date' : 'text'}
          />
        );
      })}
      <SaveBar
        error={Option.match(reason, {
          onNone: () => null,
          onSome: (value) => t(`legal-agreements.demo.feedback.${value}`),
        })}
        labels={labels}
        onReloadLatest={handleReloadLatest}
        onSave={handleSave}
        size="sm"
        status={record.status}
      />
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </FormRoot>
  );
};
