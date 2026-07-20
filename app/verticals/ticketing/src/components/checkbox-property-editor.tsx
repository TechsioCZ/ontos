// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';

export interface CheckboxPropertyDraft {
  readonly collectionId: string;
  readonly expectedRevision: number;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
  readonly value: boolean;
}

export interface SavedCheckboxPropertyValue {
  readonly taskRevision: number;
  readonly value: {
    readonly propertyDefinitionId: string;
    readonly revision: number;
    readonly value: boolean;
  };
}

export interface CheckboxPropertyEditorProps {
  readonly collectionId: string;
  readonly label: string;
  readonly onSave: (
    draft: CheckboxPropertyDraft,
    idempotencyKey: string,
  ) => Promise<SavedCheckboxPropertyValue>;
  readonly propertyDefinitionId: string;
  readonly readOnly?: boolean;
  readonly revision: number;
  readonly taskId: string;
  readonly value: boolean;
}

const isStaleCheckboxFailure = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ticketing.updateCheckboxPropertyValue.stale_or_missing';

export const CheckboxPropertyEditor = ({
  collectionId,
  label,
  onSave,
  propertyDefinitionId,
  readOnly = false,
  revision,
  taskId,
  value,
}: CheckboxPropertyEditorProps) => {
  const { t } = useModernI18n();
  const [draftValue, setDraftValue] = useState(value);
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [isSaving, setIsSaving] = useState(false);

  const handleCheckedChange = async (checked: boolean) => {
    setDraftValue(checked);
    setIsSaving(true);

    try {
      const saved = await onSave(
        {
          collectionId,
          expectedRevision: currentRevision,
          propertyDefinitionId,
          taskId,
          value: checked,
        },
        idempotencyKey,
      );
      setCurrentRevision(saved.value.revision);
      setDraftValue(saved.value.value);
      setIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create(
        isStaleCheckboxFailure(error)
          ? {
              description: t('ticketing.checkbox.staleDescription'),
              title: t('ticketing.checkbox.staleTitle'),
              type: 'warning',
            }
          : {
              description:
                error instanceof Error
                  ? error.message
                  : t('ticketing.checkbox.saveFailedDescription'),
              title: t('ticketing.checkbox.saveFailedTitle'),
              type: 'error',
            },
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <FormCheckbox
      checked={draftValue}
      disabled={isSaving}
      label={label}
      name={`checkbox-property-${propertyDefinitionId}`}
      onCheckedChange={(checked) => void handleCheckedChange(checked)}
      readOnly={readOnly}
    />
  );
};
