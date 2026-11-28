// The two typed decisions on a handover package: the error that failed it, and the accountant's acceptance with its
// proof. Typing changes only the draft; the shared Uložit records the decision once and closes the dialog; leaving
// with typed input asks first, and a refused save keeps the text with the reason.
import { FormBuilder, FormReact, FormRoot, TextField } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Schema } from 'effect';
import type { AccountingExport } from '../../../../shared/apis/records.ts';
import { financeBrowserAtomRuntime } from '../../../runtime/browser.ts';
import { FinanceFormDialog, useFinanceFormSave } from './finance-form-save.tsx';
import { useFormDraft } from './finance-form-draft.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';

const P = 'finance-billing.financeUi.accounting';

/** The typed reason a package failed; Uložit sends it through the save bar, so the form only holds it. */
const failureForm = FormReact.make(FormBuilder.empty.addField('reason', Schema.String), {
  fields: { reason: TextField },
  onSubmit: () => Effect.void,
  runtime: financeBrowserAtomRuntime,
});

/** The typed proof of the accountant's acceptance; Uložit sends it through the save bar. */
const confirmationForm = FormReact.make(FormBuilder.empty.addField('evidence', Schema.String), {
  fields: { evidence: TextField },
  onSubmit: () => Effect.void,
  runtime: financeBrowserAtomRuntime,
});

interface DecisionFormProps {
  readonly entry: AccountingExport;
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}

/** Marks a handover package as failed, with the reason. */
export const ExportFailureForm = ({ entry, onClose, vm }: DecisionFormProps) => {
  const { t } = useModernI18n();
  const { draft, ready, reset } = useFormDraft(failureForm, { reason: '' });
  const form = useFinanceFormSave({
    initial: { reason: '' },
    isValid: (value) => value.reason.trim() !== '',
    onClose,
    reset,
    send: (value) => {
      const command: FinanceCommandDraft<'MarkAccountingExportFailed'> = {
        _tag: 'MarkAccountingExportFailed',
        exportId: entry.id,
        reason: value.reason.trim(),
      };
      if (vm.actorLabel !== undefined) {
        command.actorLabel = vm.actorLabel;
      }
      return vm.execute(command, t(`${P}.failedToast`, { batch: entry.batchNumber }));
    },
    value: draft,
    vm,
  });
  return (
    <FinanceFormDialog
      description={t(`${P}.failDescription`)}
      form={form}
      size="sm"
      title={t(`${P}.failTitle`, { batch: entry.batchNumber })}
    >
      <FormRoot defaultValues={{ reason: '' }} form={failureForm} translateMessage={t}>
        {ready}
        <failureForm.reason
          id="export-failure"
          label={t(`${P}.errorDescription`)}
          placeholder={t(`${P}.errorExample`)}
          size="sm"
        />
      </FormRoot>
    </FinanceFormDialog>
  );
};

/** Records that the accountant took the package over, with the proof. */
export const ExportConfirmationForm = ({ entry, onClose, vm }: DecisionFormProps) => {
  const { t } = useModernI18n();
  const { draft, ready, reset } = useFormDraft(confirmationForm, { evidence: '' });
  const form = useFinanceFormSave({
    initial: { evidence: '' },
    isValid: (value) => value.evidence.trim() !== '',
    onClose,
    reset,
    send: (value) => {
      const command: FinanceCommandDraft<'ConfirmAccountingExport'> = {
        _tag: 'ConfirmAccountingExport',
        evidence: value.evidence.trim(),
        exportId: entry.id,
      };
      if (vm.actorLabel !== undefined) {
        command.actorLabel = vm.actorLabel;
      }
      return vm.execute(command, t(`${P}.confirmedToast`));
    },
    value: draft,
    vm,
  });
  return (
    <FinanceFormDialog
      description={t(`${P}.confirmDescription`)}
      form={form}
      size="sm"
      title={t(`${P}.confirmTitle`, { batch: entry.batchNumber })}
    >
      <FormRoot defaultValues={{ evidence: '' }} form={confirmationForm} translateMessage={t}>
        {ready}
        <confirmationForm.evidence
          id="export-evidence"
          label={t(`${P}.evidence`)}
          placeholder={t(`${P}.evidenceExample`)}
          size="sm"
        />
      </FormRoot>
    </FinanceFormDialog>
  );
};
