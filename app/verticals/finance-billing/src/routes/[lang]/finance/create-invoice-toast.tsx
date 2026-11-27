// The toasts of the create-invoice form: the created draft, with the one-click command that prepares it for
// approval, a draft sent for approval, and a create that failed.
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import type { Dispatch, SetStateAction } from 'react';
import type { FinanceFormSave, FinanceSendFailure } from './finance-form-save.tsx';
import { outcomeMessage } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';

/**
 * The create form's toasts: `created` with the prepare command, `failed` for a draft that was not created; a draft
 * sent for approval also closes the form.
 */
export const useCreateInvoiceFeedback = (vm: FinanceViewModel, onClose: () => void) => {
  const toaster = useToast();
  const failed = (outcome: FinanceSendFailure) => {
    if (outcome.feedback === 'pendingApproval') {
      toaster.create({ title: vm.t('finance-billing.demo.feedback.pendingApproval'), type: 'info' });
      // Sent for approval: nothing to open, and closing keeps the same draft from being proposed twice.
      onClose();
      return;
    }
    toaster.create({
      description: outcomeMessage(vm, outcome),
      title: vm.t('finance-billing.faktury.form.createFailed'),
      type: 'error',
    });
  };
  const created = (invoice: Invoice) => {
    // The toast id is fixed up front so the action can dismiss exactly this toast before preparing.
    const toastId = `invoice-created-${invoice.ref.resourceId}`;
    const prepare = () => {
      toaster.dismiss(toastId);
      const command: FinanceCommandDraft<'MarkInvoicesPrepared'> = {
        _tag: 'MarkInvoicesPrepared',
        invoiceRefs: [invoice.ref],
      };
      if (vm.actorLabel !== undefined) {
        command.actorLabel = vm.actorLabel;
      }
      void financeBrowserRuntime.runPromise(vm.execute(command, 'Doklad připraven ke schválení'));
    };
    toaster.create({
      description: (
        <div className="flex items-center justify-between gap-150">
          <span>{invoice.number ?? invoice.documentNumber}</span>
          <Button onClick={prepare} size="sm" theme="outlined" variant="secondary">
            Připravit ke schválení
          </Button>
        </div>
      ),
      id: toastId,
      title: vm.t('finance-billing.faktury.form.created'),
      type: 'success',
    });
  };
  return { created, failed };
};

/**
 * Uložit of the create form, in the footer and in the leave question, over a 0 Kč line: a 0 Kč line can be a gift, so
 * it is not an error, but the first Uložit only shows the warning and the next one creates the draft. `acknowledged`
 * is the form's state, which a change of the lines resets.
 */
export const zeroPriceChecked = (
  form: FinanceFormSave,
  hasZeroPriceLine: boolean,
  [acknowledged, setAcknowledged]: readonly [boolean, Dispatch<SetStateAction<boolean>>],
) => {
  const held = hasZeroPriceLine && !acknowledged;
  const checked: FinanceFormSave = {
    ...form,
    guard: {
      ...form.guard,
      prompt: {
        ...form.guard.prompt,
        onSave: () => {
          if (held) {
            form.guard.prompt.onStay();
            setAcknowledged(true);
            return;
          }
          form.guard.prompt.onSave();
        },
      },
    },
    handleSave: () => {
      if (held) {
        setAcknowledged(true);
        return;
      }
      form.handleSave();
    },
  };
  return { checked, zeroPriceWarning: acknowledged && hasZeroPriceLine };
};
