// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@techsio/ui-kit/atoms/link';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import { emailMailtoHref, parseEmailValue } from '../../shared/email-value';

export interface EmailPropertyDraft {
  readonly collectionId: string;
  readonly expectedRevision: number;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
  readonly value: string;
}

export interface SavedEmailPropertyValue {
  readonly taskRevision: number;
  readonly value: {
    readonly propertyDefinitionId: string;
    readonly revision: number;
    readonly value: string | null;
  };
}

export interface EmailPropertyEditorProps {
  readonly collectionId: string;
  readonly label: string;
  readonly onSave: (
    draft: EmailPropertyDraft,
    idempotencyKey: string,
  ) => Promise<SavedEmailPropertyValue>;
  readonly propertyDefinitionId: string;
  readonly readOnly?: boolean;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string | null;
}

const failureCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

export const EmailPropertyEditor = ({
  collectionId,
  label,
  onSave,
  propertyDefinitionId,
  readOnly = false,
  revision,
  taskId,
  value,
}: EmailPropertyEditorProps) => {
  const { t } = useModernI18n();
  const [draftValue, setDraftValue] = useState(value ?? '');
  const [savedValue, setSavedValue] = useState(value);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [inlineError, setInlineError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);

  const handleBlur = async () => {
    if (readOnly) {
      return;
    }
    const parsed = parseEmailValue(draftValue);
    if (parsed._tag === 'Invalid') {
      setInlineError(t('ticketing.email.invalid'));
      return;
    }
    const submittedValue = parsed._tag === 'Valid' ? parsed.value : '';
    if (submittedValue === (savedValue ?? '')) {
      setDraftValue(submittedValue);
      setInlineError(undefined);
      return;
    }

    setIsSaving(true);
    setInlineError(undefined);
    try {
      const saved = await onSave(
        {
          collectionId,
          expectedRevision: currentRevision,
          propertyDefinitionId,
          taskId,
          value: submittedValue,
        },
        idempotencyKey,
      );
      const nextValue = saved.value.value;
      setCurrentRevision(saved.value.revision);
      setDraftValue(nextValue ?? '');
      setSavedValue(nextValue);
      setIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      const code = failureCode(error);
      if (
        code === 'ticketing.updateEmailPropertyValue.invalid_email' ||
        code === 'ticketing.updateEmailPropertyValue.mandatory'
      ) {
        setInlineError(
          error instanceof Error ? error.message : t('ticketing.email.saveFailedDescription'),
        );
      } else {
        toaster.create(
          code === 'ticketing.updateEmailPropertyValue.stale_or_missing'
            ? {
                description: t('ticketing.email.staleDescription'),
                title: t('ticketing.email.staleTitle'),
                type: 'warning',
              }
            : {
                description:
                  error instanceof Error
                    ? error.message
                    : t('ticketing.email.saveFailedDescription'),
                title: t('ticketing.email.saveFailedTitle'),
                type: 'error',
              },
        );
      }
    } finally {
      setIsSaving(false);
    }
  };

  const mailtoHref = savedValue === null ? undefined : emailMailtoHref(savedValue);

  return (
    <div>
      <FormInput
        disabled={isSaving}
        helpText={inlineError}
        id={`email-property-${propertyDefinitionId}`}
        label={label}
        name={`email-property-${propertyDefinitionId}`}
        onBlur={() => void handleBlur()}
        onChange={(event) => {
          setDraftValue(event.currentTarget.value);
          setInlineError(undefined);
        }}
        readOnly={readOnly}
        type="email"
        validateStatus={inlineError === undefined ? 'default' : 'error'}
        value={draftValue}
      />
      {mailtoHref === undefined ? null : (
        <Link href={mailtoHref}>{t('ticketing.email.activate')}</Link>
      )}
    </div>
  );
};
