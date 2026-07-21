// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';

export interface TextPropertyDuplicationDraft {
  readonly collectionId: string;
  readonly expectedRevision: number;
  readonly propertyDefinitionId: string;
}

export interface TextPropertyDuplicationProps {
  readonly collectionId: string;
  readonly label: string;
  readonly onConfirm: (
    draft: TextPropertyDuplicationDraft,
    idempotencyKey: string,
  ) => Promise<void>;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

export const TextPropertyDuplication = ({
  collectionId,
  label,
  onConfirm,
  propertyDefinitionId,
  revision,
}: TextPropertyDuplicationProps) => {
  const { t } = useModernI18n();
  const [open, setOpen] = useState(false);
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const handleConfirm = async () => {
    setIsDuplicating(true);
    try {
      await onConfirm(
        { collectionId, expectedRevision: revision, propertyDefinitionId },
        idempotencyKey,
      );
      setOpen(false);
      setIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error ? error.message : t('ticketing.text.duplicateFailedDescription'),
        title: t('ticketing.text.duplicateFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsDuplicating(false);
    }
  };

  return (
    <Dialog
      actions={
        <Button
          isLoading={isDuplicating}
          loadingText={t('ticketing.text.duplicating')}
          onClick={() => void handleConfirm()}
          type="button"
        >
          {t('ticketing.text.duplicateConfirm')}
        </Button>
      }
      description={t('ticketing.text.duplicateDescription')}
      onOpenChange={({ open: nextOpen }) => setOpen(nextOpen)}
      open={open}
      size="sm"
      title={t('ticketing.text.duplicate', { name: label })}
      triggerText={t('ticketing.text.duplicate', { name: label })}
    />
  );
};
