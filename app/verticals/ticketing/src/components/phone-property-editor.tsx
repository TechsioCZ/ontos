// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import { phoneTelHref, validatePhoneValue } from '../../shared/phone-value';

export interface PhonePropertyDraft {
  readonly collectionId: string;
  readonly expectedRevision: number;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
  readonly value: string | null;
}

export interface SavedPhonePropertyValue {
  readonly taskRevision: number;
  readonly value: {
    readonly propertyDefinitionId: string;
    readonly revision: number;
    readonly value: string;
  } | null;
}

export interface PhonePropertyEditorProps {
  readonly collectionId: string;
  readonly copyText?: (value: string) => Promise<void>;
  readonly label: string;
  readonly onSave: (
    draft: PhonePropertyDraft,
    idempotencyKey: string,
  ) => Promise<SavedPhonePropertyValue>;
  readonly propertyDefinitionId: string;
  readonly readOnly?: boolean;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string | null;
}

const isStalePhoneFailure = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ticketing.updatePhonePropertyValue.stale_or_missing';

const copyUsingClipboard = (value: string): Promise<void> => navigator.clipboard.writeText(value);

export const PhonePropertyEditor = ({
  collectionId,
  copyText = copyUsingClipboard,
  label,
  onSave,
  propertyDefinitionId,
  readOnly = false,
  revision,
  taskId,
  value,
}: PhonePropertyEditorProps) => {
  const { t } = useModernI18n();
  const [draftValue, setDraftValue] = useState(value ?? '');
  const [committedValue, setCommittedValue] = useState(value);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [isSaving, setIsSaving] = useState(false);
  const validation = validatePhoneValue(draftValue);
  const hasStoredValue = committedValue !== null;

  const handleCopy = async () => {
    if (committedValue === null) {
      return;
    }
    try {
      await copyText(committedValue);
      toaster.create({
        description: t('ticketing.phone.copiedDescription'),
        title: t('ticketing.phone.copiedTitle'),
        type: 'success',
      });
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error ? error.message : t('ticketing.phone.copyFailedDescription'),
        title: t('ticketing.phone.copyFailedTitle'),
        type: 'error',
      });
    }
  };

  const handleSave = async () => {
    if (!validation.ok) {
      return;
    }
    setIsSaving(true);
    try {
      const saved = await onSave(
        {
          collectionId,
          expectedRevision: currentRevision,
          propertyDefinitionId,
          taskId,
          value: validation.value,
        },
        idempotencyKey,
      );
      setCurrentRevision(saved.value?.revision ?? 0);
      setDraftValue(saved.value?.value ?? '');
      setCommittedValue(saved.value?.value ?? null);
      setIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create(
        isStalePhoneFailure(error)
          ? {
              description: t('ticketing.phone.staleDescription'),
              title: t('ticketing.phone.staleTitle'),
              type: 'warning',
            }
          : {
              description:
                error instanceof Error ? error.message : t('ticketing.phone.saveFailedDescription'),
              title: t('ticketing.phone.saveFailedTitle'),
              type: 'error',
            },
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div>
      <FormTextarea
        disabled={isSaving}
        helpText={validation.ok ? undefined : t('ticketing.phone.invalid')}
        id={`phone-property-${propertyDefinitionId}`}
        label={label}
        name={`phone-property-${propertyDefinitionId}`}
        onChange={(event) => setDraftValue(event.currentTarget.value)}
        readonly={readOnly}
        resize="none"
        rows={1}
        validateStatus={validation.ok ? 'default' : 'error'}
        value={draftValue}
      />
      {!readOnly && (
        <Button
          disabled={isSaving || !validation.ok}
          isLoading={isSaving}
          loadingText={t('ticketing.phone.save')}
          onClick={() => void handleSave()}
          size="sm"
          theme="solid"
          variant="primary"
        >
          {t('ticketing.phone.save')}
        </Button>
      )}
      {hasStoredValue && (
        <>
          <Button
            onClick={() => void handleCopy()}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            {t('ticketing.phone.copy')}
          </Button>
          <LinkButton
            href={phoneTelHref(committedValue)}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            {t('ticketing.phone.call')}
          </LinkButton>
        </>
      )}
    </div>
  );
};
