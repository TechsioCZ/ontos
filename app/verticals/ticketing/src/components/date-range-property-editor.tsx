// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import type { DateRangeValidationCode, DateRangeValue } from '../../shared/date-range-value.ts';
import { validateDateRangeValue } from '../../shared/date-range-value.ts';

export interface DateRangePropertyDraft {
  readonly collectionId: string;
  readonly expectedRevision: number;
  readonly propertyDefinitionId: string;
  readonly taskId: string;
  readonly value: DateRangeValue | null;
}

export interface SavedDateRangePropertyValue {
  readonly taskRevision: number;
  readonly value: {
    readonly propertyDefinitionId: string;
    readonly revision: number;
    readonly value: DateRangeValue | null;
  } | null;
}

export interface DateRangePropertyEditorProps {
  readonly collectionId: string;
  readonly label: string;
  readonly onSave: (
    draft: DateRangePropertyDraft,
    idempotencyKey: string,
  ) => Promise<SavedDateRangePropertyValue>;
  readonly propertyDefinitionId: string;
  readonly readOnly?: boolean;
  readonly revision: number;
  readonly taskId: string;
  readonly timeEnabled: boolean;
  readonly value: DateRangeValue | null;
}

const emptyDraft = (): DateRangeValue => ({
  endDate: '',
  endTime: null,
  startDate: '',
  startTime: null,
});

export const DateRangePropertyEditor = ({
  collectionId,
  label,
  onSave,
  propertyDefinitionId,
  readOnly = false,
  revision,
  taskId,
  timeEnabled,
  value,
}: DateRangePropertyEditorProps) => {
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<DateRangeValue>(value ?? emptyDraft());
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [validationCode, setValidationCode] = useState<DateRangeValidationCode | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const updateDraft = (field: keyof DateRangeValue, nextValue: string) => {
    setDraft((current) => ({
      ...current,
      [field]: field === 'startTime' || field === 'endTime' ? nextValue || null : nextValue,
    }));
    setValidationCode(null);
  };

  const persist = async (nextValue: DateRangeValue | null) => {
    setIsSaving(true);
    try {
      const saved = await onSave(
        {
          collectionId,
          expectedRevision: currentRevision,
          propertyDefinitionId,
          taskId,
          value: nextValue,
        },
        idempotencyKey,
      );
      setCurrentRevision(saved.value?.revision ?? 0);
      setDraft(saved.value?.value ?? emptyDraft());
      setIdempotencyKey(crypto.randomUUID());
      setValidationCode(null);
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error ? error.message : t('ticketing.dateRange.saveFailedDescription'),
        title: t('ticketing.dateRange.saveFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const saveDraft = () => {
    const code = validateDateRangeValue(draft, timeEnabled);
    if (code !== null) {
      setValidationCode(code);
      return;
    }
    void persist(draft);
  };

  const validationMessage =
    validationCode === null ? null : t(`ticketing.dateRange.error.${validationCode}`);

  return (
    <fieldset aria-label={label} disabled={readOnly || isSaving}>
      <FormInput
        id={`${propertyDefinitionId}-start-date`}
        label={t('ticketing.dateRange.startDate')}
        onChange={(event) => updateDraft('startDate', event.target.value)}
        type="date"
        validateStatus={validationCode === null ? 'default' : 'error'}
        value={draft.startDate}
      />
      <FormInput
        id={`${propertyDefinitionId}-end-date`}
        label={t('ticketing.dateRange.endDate')}
        onChange={(event) => updateDraft('endDate', event.target.value)}
        type="date"
        validateStatus={validationCode === null ? 'default' : 'error'}
        value={draft.endDate}
      />
      {timeEnabled ? (
        <>
          <FormInput
            id={`${propertyDefinitionId}-start-time`}
            label={t('ticketing.dateRange.startTime')}
            onChange={(event) => updateDraft('startTime', event.target.value)}
            type="time"
            validateStatus={validationCode === null ? 'default' : 'error'}
            value={draft.startTime ?? ''}
          />
          <FormInput
            id={`${propertyDefinitionId}-end-time`}
            label={t('ticketing.dateRange.endTime')}
            onChange={(event) => updateDraft('endTime', event.target.value)}
            type="time"
            validateStatus={validationCode === null ? 'default' : 'error'}
            value={draft.endTime ?? ''}
          />
        </>
      ) : null}
      {validationMessage === null ? null : (
        <StatusText showIcon status="error">
          {validationMessage}
        </StatusText>
      )}
      <Button disabled={isSaving} onClick={saveDraft} size="sm" variant="primary">
        {t('ticketing.dateRange.save')}
      </Button>
      <Button
        disabled={isSaving}
        onClick={() => void persist(null)}
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        {t('ticketing.dateRange.clear')}
      </Button>
    </fieldset>
  );
};

export interface DateRangeTimeSupportControlProps {
  readonly affectedValueCount: number;
  readonly disabled?: boolean;
  readonly onConfigure: (
    timeEnabled: boolean,
    confirmed: boolean,
    affectedValueCount: number,
  ) => Promise<void>;
  readonly timeEnabled: boolean;
}

export const DateRangeTimeSupportControl = ({
  affectedValueCount,
  disabled = false,
  onConfigure,
  timeEnabled,
}: DateRangeTimeSupportControlProps) => {
  const { t } = useModernI18n();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const configure = async (nextTimeEnabled: boolean, confirmed: boolean) => {
    setIsSaving(true);
    try {
      await onConfigure(nextTimeEnabled, confirmed, nextTimeEnabled ? 0 : affectedValueCount);
      setConfirmationOpen(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Switch
        checked={timeEnabled}
        disabled={disabled || isSaving}
        key={`${timeEnabled}-${confirmationOpen}`}
        onCheckedChange={(checked) => {
          if (checked) {
            void configure(true, false);
          } else {
            setConfirmationOpen(true);
          }
        }}
      >
        {t('ticketing.dateRange.timeSupport')}
      </Switch>
      <Dialog
        actions={
          <>
            <Button
              disabled={isSaving}
              onClick={() => setConfirmationOpen(false)}
              theme="borderless"
              variant="secondary"
            >
              {t('ticketing.dateRange.disableCancel')}
            </Button>
            <Button
              disabled={isSaving}
              onClick={() => void configure(false, true)}
              variant="danger"
            >
              {t('ticketing.dateRange.disableConfirm')}
            </Button>
          </>
        }
        customTrigger
        description={t('ticketing.dateRange.disableDescription', {
          count: affectedValueCount,
        })}
        onOpenChange={({ open }) => setConfirmationOpen(open)}
        open={confirmationOpen}
        role="alertdialog"
        title={t('ticketing.dateRange.disableTitle')}
      />
    </>
  );
};
