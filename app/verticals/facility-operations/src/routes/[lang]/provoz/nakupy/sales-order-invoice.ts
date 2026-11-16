import { SOURCE_ORDER_INVOICE_OTHER_COUNTERPARTY } from '@app/finance-billing/contracts/records';
import { Predicate } from 'effect';
import type { SalesOrder } from '../../../../../shared/domain/purchasing.ts';
import type { FinanceInvoiceView } from '../../../../ui/finance-reads.ts';

/**
 * The invoice Finance holds for a sales order: issued, not voided, the plain invoice (not an advance or a partial one)
 * of this order. Finance keeps one per billing part of an order (CreateInvoiceDraft with `sourceOrder` returns it
 * instead of drafting another), so a retry from any tab, device or agent links this invoice. Its amount and lines may
 * have been edited in Finance; it is still this order's invoice.
 */
export const invoiceOfSalesOrder = <Invoice extends FinanceInvoiceView>(
  invoices: readonly Invoice[],
  order: Pick<SalesOrder, 'id'>,
): Invoice | undefined =>
  invoices.find(
    (invoice) =>
      invoice.direction === 'OUTGOING' &&
      invoice.businessState !== 'VOIDED' &&
      invoice.sourceOrder?.id === order.id &&
      (invoice.documentKind ?? 'STANDARD') === 'STANDARD',
  );

/** Whether the order's invoice in Finance is issued to the order's own customer. */
export const issuedToOrderCustomer = (invoice: FinanceInvoiceView, order: Pick<SalesOrder, 'customer'>): boolean =>
  invoice.counterpartyRef.resourceId === order.customer.counterpartyId;

/** Finance's refusal of a draft whose order already has its invoice issued to another customer. */
export const isOtherCustomerRefusal = <E extends { readonly _tag: string }>(error: E): boolean =>
  Predicate.hasProperty(error, 'code') &&
  error.code === 'finance_conflict' &&
  Predicate.hasProperty(error, 'detail') &&
  error.detail === SOURCE_ORDER_INVOICE_OTHER_COUNTERPARTY;
