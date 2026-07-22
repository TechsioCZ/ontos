// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import type { DeleteTaskPropertyDefinitionActionPayload } from '../../shared/actions/delete-task-property-definition';
import type { DuplicateTaskPropertyDefinitionActionPayload } from '../../shared/actions/duplicate-task-property-definition';
import type { TaskPropertyDeletionImpact } from '../../shared/task-property-deletion-impact';
import type { TaskPropertyDefinitionValueCopyPolicy } from '../../shared/task-property-definition-value-copy-policy';

export interface TaskPropertyDefinitionActionsProps {
  readonly canDuplicate?: boolean;
  readonly collectionId: string;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onDelete: (
    draft: DeleteTaskPropertyDefinitionActionPayload,
    idempotencyKey: string,
  ) => Promise<void>;
  readonly onDuplicate: (
    draft: DuplicateTaskPropertyDefinitionActionPayload,
    idempotencyKey: string,
  ) => Promise<void>;
  readonly onLoadDeletionImpact: () => Promise<TaskPropertyDeletionImpact>;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly valueCopyPolicy: TaskPropertyDefinitionValueCopyPolicy;
}

export const TaskPropertyDefinitionActions = ({
  canDuplicate = true,
  collectionId,
  disabled = false,
  label,
  onDelete,
  onDuplicate,
  onLoadDeletionImpact,
  propertyDefinitionId,
  revision,
  valueCopyPolicy,
}: TaskPropertyDefinitionActionsProps) => {
  const { t } = useModernI18n();
  const [copyValues, setCopyValues] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletionImpact, setDeletionImpact] = useState<TaskPropertyDeletionImpact>();
  const [deletionImpactFailed, setDeletionImpactFailed] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [isLoadingDeletionImpact, setIsLoadingDeletionImpact] = useState(false);
  const [deleteIdempotencyKey, setDeleteIdempotencyKey] = useState(() => crypto.randomUUID());
  const [duplicateIdempotencyKey, setDuplicateIdempotencyKey] = useState(() => crypto.randomUUID());

  const handleDuplicate = async () => {
    setIsDuplicating(true);
    try {
      await onDuplicate(
        {
          collectionId,
          copyValues:
            valueCopyPolicy === 'always' || (valueCopyPolicy === 'optional' && copyValues),
          expectedRevision: revision,
          propertyDefinitionId,
        },
        duplicateIdempotencyKey,
      );
      setCopyValues(false);
      setDuplicateOpen(false);
      setDuplicateIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.propertyActions.duplicateFailedDescription'),
        title: t('ticketing.propertyActions.duplicateFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsDuplicating(false);
    }
  };

  const loadDeletionImpact = async () => {
    setDeletionImpact(undefined);
    setDeletionImpactFailed(false);
    setIsLoadingDeletionImpact(true);
    try {
      setDeletionImpact(await onLoadDeletionImpact());
    } catch (error) {
      setDeletionImpactFailed(true);
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.propertyActions.deleteImpactFailedDescription'),
        title: t('ticketing.propertyActions.deleteImpactFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsLoadingDeletionImpact(false);
    }
  };

  const handleDelete = async () => {
    if (deletionImpact === undefined) {
      return;
    }

    setIsDeleting(true);
    try {
      await onDelete(
        {
          collectionId,
          confirmed: true,
          expectedImpactCount: deletionImpact.impactCount,
          expectedImpactRevision: deletionImpact.impactRevision,
          expectedRevision: deletionImpact.revision,
          propertyDefinitionId,
        },
        deleteIdempotencyKey,
      );
      setDeleteOpen(false);
      setDeletionImpact(undefined);
      setDeleteIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.propertyActions.deleteFailedDescription'),
        title: t('ticketing.propertyActions.deleteFailedTitle'),
        type: 'error',
      });
      setDeleteIdempotencyKey(crypto.randomUUID());
      await loadDeletionImpact();
    } finally {
      setIsDeleting(false);
    }
  };

  const renderDeletionImpact = () => {
    if (isLoadingDeletionImpact || (deletionImpact === undefined && !deletionImpactFailed)) {
      return <p>{t('ticketing.propertyActions.deleteImpactLoading')}</p>;
    }
    if (deletionImpactFailed) {
      return (
        <div className="ticketing:grid ticketing:gap-2">
          <p>{t('ticketing.propertyActions.deleteImpactUnavailable')}</p>
          <div>
            <Button
              onClick={() => void loadDeletionImpact()}
              size="sm"
              theme="outlined"
              type="button"
              variant="secondary"
            >
              {t('ticketing.propertyActions.deleteImpactRetry')}
            </Button>
          </div>
        </div>
      );
    }
    return (
      <p>
        {t('ticketing.propertyActions.deleteImpact', {
          count: deletionImpact.impactCount,
        })}
      </p>
    );
  };

  return (
    <div className="ticketing:flex ticketing:flex-wrap ticketing:gap-2">
      {canDuplicate ? (
        <>
          <Button
            disabled={disabled}
            onClick={() => setDuplicateOpen(true)}
            size="sm"
            theme="outlined"
            type="button"
            variant="secondary"
          >
            {t('ticketing.propertyActions.duplicate', { name: label })}
          </Button>
          <Dialog
            actions={
              <Button
                isLoading={isDuplicating}
                loadingText={t('ticketing.propertyActions.duplicating')}
                onClick={() => void handleDuplicate()}
                type="button"
              >
                {t('ticketing.propertyActions.duplicateConfirm')}
              </Button>
            }
            customTrigger
            description={t('ticketing.propertyActions.duplicateDescription')}
            onOpenChange={({ open }) => setDuplicateOpen(open)}
            open={duplicateOpen}
            size="sm"
            title={t('ticketing.propertyActions.duplicate', { name: label })}
          >
            {valueCopyPolicy === 'optional' ? (
              <FormCheckbox
                checked={copyValues}
                disabled={isDuplicating}
                helpText={t('ticketing.propertyActions.copyValuesHelp')}
                label={t('ticketing.propertyActions.copyValuesLabel')}
                name={`copy-values-${propertyDefinitionId}`}
                onCheckedChange={setCopyValues}
              />
            ) : (
              <p>
                {t(
                  valueCopyPolicy === 'always'
                    ? 'ticketing.propertyActions.copyValuesAlways'
                    : 'ticketing.propertyActions.copyValuesNever',
                )}
              </p>
            )}
          </Dialog>
        </>
      ) : null}

      <Button
        disabled={disabled}
        onClick={() => {
          setDeleteOpen(true);
          void loadDeletionImpact();
        }}
        size="sm"
        theme="outlined"
        type="button"
        variant="danger"
      >
        {t('ticketing.propertyActions.delete', { name: label })}
      </Button>
      <Dialog
        actions={
          <Button
            disabled={deletionImpact === undefined}
            isLoading={isDeleting}
            loadingText={t('ticketing.propertyActions.deleting')}
            onClick={() => void handleDelete()}
            type="button"
            variant="danger"
          >
            {t('ticketing.propertyActions.deleteConfirm')}
          </Button>
        }
        customTrigger
        description={
          <div className="ticketing:grid ticketing:gap-2">
            <p>{t('ticketing.propertyActions.deleteDescription')}</p>
            {renderDeletionImpact()}
          </div>
        }
        onOpenChange={({ open }) => {
          setDeleteOpen(open);
          if (!open) {
            setDeletionImpact(undefined);
          }
        }}
        open={deleteOpen}
        role="alertdialog"
        size="sm"
        title={t('ticketing.propertyActions.delete', { name: label })}
      />
    </div>
  );
};
