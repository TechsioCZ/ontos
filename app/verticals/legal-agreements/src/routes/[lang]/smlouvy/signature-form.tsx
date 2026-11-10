// The manual signature of a contract: signer, file name, reference and date are a draft until the shared Uložit
// records them once; Enter never records, and leaving the page with typed input asks first.
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { FormInput } from '@app/admin-ui/form-controls';
import { Effect, Option, Predicate } from 'effect';
import { useState } from 'react';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { failureReasonOf, revisionedResultOf } from './agreements-command.ts';
import type { AgreementOutcome } from './agreements-command.ts';

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

export const SignatureForm = ({ busy, onSave, reload }: SignatureFormProps) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const [draft, setDraft] = useState<SignatureDraft>(emptySignatureDraft);
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
      setDraft(record.confirmed);
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
    <form
      className="legalagreements:w-full legalagreements:space-y-3"
      noValidate
      onSubmit={(event) => {
        // Enter never records the signature: only Uložit does.
        event.preventDefault();
      }}
    >
      <p className="legalagreements:text-sm">{t('legal-agreements.demo.manualSignatureHint')}</p>
      {FIELDS.map((field) => (
        <FormInput
          disabled={busy || saving}
          id={`contract-${field}`}
          key={field}
          label={t(`legal-agreements.demo.${field}`)}
          onChange={(event) => {
            const { value } = event.target;
            setDraft((current) => ({ ...current, [field]: value }));
          }}
          required
          type={field === 'signedOn' ? 'date' : 'text'}
          value={draft[field]}
        />
      ))}
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
    </form>
  );
};
