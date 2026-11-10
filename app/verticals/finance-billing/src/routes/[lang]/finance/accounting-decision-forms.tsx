// The two typed decisions on a handover package: the error that failed it, and the accountant's acceptance with its
// proof. Typing changes only the draft; the shared Uložit records the decision once and closes the dialog; leaving
// with typed input asks first, and a refused save keeps the text with the reason.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useState } from 'react';
import type { AccountingExport } from '../../../../shared/apis/records.ts';
import { FinanceFormDialog, useFinanceFormSave } from './finance-form-save.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';

const P = 'finance-billing.financeUi.accounting';

interface DecisionFormProps {
  readonly entry: AccountingExport;
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}

/** Marks a handover package as failed, with the reason. */
export const ExportFailureForm = ({ entry, onClose, vm }: DecisionFormProps) => {
  const { t } = useModernI18n();
  const [reason, setReason] = useState('');
  const form = useFinanceFormSave({
    initial: '',
    isValid: (value) => value.trim() !== '',
    onClose,
    reset: setReason,
    send: (value) => {
      const command: FinanceCommandDraft<'MarkAccountingExportFailed'> = {
        _tag: 'MarkAccountingExportFailed',
        exportId: entry.id,
        reason: value.trim(),
      };
      if (vm.actorLabel !== undefined) {
        command.actorLabel = vm.actorLabel;
      }
      return vm.execute(command, t(`${P}.failedToast`, { batch: entry.batchNumber }));
    },
    value: reason,
    vm,
  });
  return (
    <FinanceFormDialog
      description={t(`${P}.failDescription`)}
      form={form}
      size="sm"
      title={t(`${P}.failTitle`, { batch: entry.batchNumber })}
    >
      <FormInput
        id="export-failure"
        label={t(`${P}.errorDescription`)}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t(`${P}.errorExample`)}
        size="sm"
        value={reason}
      />
    </FinanceFormDialog>
  );
};

/** Records that the accountant took the package over, with the proof. */
export const ExportConfirmationForm = ({ entry, onClose, vm }: DecisionFormProps) => {
  const { t } = useModernI18n();
  const [evidence, setEvidence] = useState('');
  const form = useFinanceFormSave({
    initial: '',
    isValid: (value) => value.trim() !== '',
    onClose,
    reset: setEvidence,
    send: (value) => {
      const command: FinanceCommandDraft<'ConfirmAccountingExport'> = {
        _tag: 'ConfirmAccountingExport',
        evidence: value.trim(),
        exportId: entry.id,
      };
      if (vm.actorLabel !== undefined) {
        command.actorLabel = vm.actorLabel;
      }
      return vm.execute(command, t(`${P}.confirmedToast`));
    },
    value: evidence,
    vm,
  });
  return (
    <FinanceFormDialog
      description={t(`${P}.confirmDescription`)}
      form={form}
      size="sm"
      title={t(`${P}.confirmTitle`, { batch: entry.batchNumber })}
    >
      <FormInput
        id="export-evidence"
        label={t(`${P}.evidence`)}
        onChange={(event) => setEvidence(event.target.value)}
        placeholder={t(`${P}.evidenceExample`)}
        size="sm"
        value={evidence}
      />
    </FinanceFormDialog>
  );
};
