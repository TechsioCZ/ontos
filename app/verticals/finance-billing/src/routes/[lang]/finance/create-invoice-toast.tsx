// The toast of a created invoice draft, with the one-click command that prepares it for approval.
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';

/** The created draft's toast, with the one-click command that prepares it for approval. */
export const useCreatedInvoiceToast = (vm: FinanceViewModel) => {
  const toaster = useToast();
  return (invoice: Invoice) => {
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
};
