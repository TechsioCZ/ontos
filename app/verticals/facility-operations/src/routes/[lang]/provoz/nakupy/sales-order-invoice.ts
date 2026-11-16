import type { SalesOrder } from '../../../../../shared/domain/purchasing.ts';
import type { FinanceInvoiceView } from '../../../../ui/finance-reads.ts';

/**
 * The invoice Finance already holds for a sales order: issued, not voided, created for this order. Finance keeps one
 * per order (CreateInvoiceDraft with `sourceOrder` returns it instead of drafting another), so a retry from any tab,
 * device or agent links this invoice. One for another customer is not this order's invoice.
 */
export const invoiceOfSalesOrder = <Invoice extends FinanceInvoiceView>(
  invoices: readonly Invoice[],
  order: Pick<SalesOrder, 'customer' | 'id'>,
): Invoice | undefined =>
  invoices.find(
    (invoice) =>
      invoice.direction === 'OUTGOING' &&
      invoice.businessState !== 'VOIDED' &&
      invoice.sourceOrder?.id === order.id &&
      invoice.counterpartyRef.resourceId === order.customer.counterpartyId,
  );
