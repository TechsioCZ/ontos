// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import { InvalidUrlPropertyValueError, validateUrlPropertyValue } from '../url-property';
import { UrlPropertyActions } from './url-property-actions';

export interface UrlPropertyDraft {
  readonly collectionId: string;
  readonly expectedRevision: number;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
  readonly value: string;
}

export interface SavedUrlPropertyValue {
  readonly taskRevision: number;
  readonly value: {
    readonly propertyDefinitionId: string;
    readonly revision: number;
    readonly value: string | null;
  };
}

export interface UrlPropertyEditorProps {
  readonly collectionId: string;
  readonly label: string;
  readonly mandatory?: boolean;
  readonly onSave: (
    draft: UrlPropertyDraft,
    idempotencyKey: string,
  ) => Promise<SavedUrlPropertyValue>;
  readonly propertyDefinitionId: string;
  readonly readOnly?: boolean;
  readonly revision: number;
  readonly taskId: string;
  readonly value: string | null;
}

const isStaleUrlFailure = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ticketing.updateUrlPropertyValue.stale_or_missing';

export const UrlPropertyEditor = ({
  collectionId,
  label,
  mandatory = false,
  onSave,
  propertyDefinitionId,
  readOnly = false,
  revision,
  taskId,
  value,
}: UrlPropertyEditorProps) => {
  const { t } = useModernI18n();
  const [committedValue, setCommittedValue] = useState(value);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [draftValue, setDraftValue] = useState(value ?? '');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [isSaving, setIsSaving] = useState(false);
  const [isInvalid, setIsInvalid] = useState(false);

  const validateDraft = (): boolean => {
    try {
      const validated = validateUrlPropertyValue(draftValue);
      const valid = !(mandatory && validated === null);
      setIsInvalid(!valid);
      return valid;
    } catch (error) {
      if (error instanceof InvalidUrlPropertyValueError) {
        setIsInvalid(true);
        return false;
      }
      throw error;
    }
  };

  const handleSave = async () => {
    if (!validateDraft()) {
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
          value: draftValue,
        },
        idempotencyKey,
      );
      setCommittedValue(saved.value.value);
      setCurrentRevision(saved.value.revision);
      setDraftValue(saved.value.value ?? '');
      setIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create(
        isStaleUrlFailure(error)
          ? {
              description: t('ticketing.url.staleDescription'),
              title: t('ticketing.url.staleTitle'),
              type: 'warning',
            }
          : {
              description:
                error instanceof Error ? error.message : t('ticketing.url.saveFailedDescription'),
              title: t('ticketing.url.saveFailedTitle'),
              type: 'error',
            },
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <FormInput
        disabled={isSaving}
        helpText={isInvalid ? t('ticketing.url.invalid') : undefined}
        id={`url-property-${propertyDefinitionId}`}
        label={label}
        name={`url-property-${propertyDefinitionId}`}
        onBlur={validateDraft}
        onChange={(event) => {
          setDraftValue(event.currentTarget.value);
          setIsInvalid(false);
        }}
        readOnly={readOnly}
        required={mandatory}
        type="url"
        validateStatus={isInvalid ? 'error' : 'default'}
        value={draftValue}
      />
      {readOnly ? null : (
        <Button
          isLoading={isSaving}
          loadingText={t('ticketing.url.saving')}
          onClick={() => void handleSave()}
          type="button"
          variant="secondary"
        >
          {t('ticketing.url.save')}
        </Button>
      )}
      <UrlPropertyActions value={committedValue} />
    </>
  );
};
