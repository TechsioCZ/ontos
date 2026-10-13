import type { CustomerListItem } from '@app/party-registry/api/client';
import type { Invoice } from '../../../../../shared/apis/records.ts';

/** Select labels in the invoice dialog take the same label size as the FormInput, Combobox and numeric labels. */
export const formLabelProps = { className: 'font-label text-label-md' } as const;

/** Customers keyed by both party id and counterparty id, so an invoice resolves whichever one it stores. */
export type CustomerIndex = ReadonlyMap<string, CustomerListItem>;

export const customerIndex = (customers: readonly CustomerListItem[]): CustomerIndex =>
  new Map(
    customers.flatMap(
      (customer) =>
        [
          [customer.partyId, customer],
          [customer.counterpartyId, customer],
        ] as const,
    ),
  );

export const invoiceCustomerId = (invoice: Invoice): string => invoice.partyId ?? invoice.counterpartyRef.resourceId;

export const customerOf = (customers: CustomerIndex, invoice: Invoice): CustomerListItem | undefined =>
  customers.get(invoiceCustomerId(invoice));

/** Shown in place of a customer name while the customer list is still loading. */
export const customerLoadingLabel = '…';

/** Party name, or the muted fallback label when the registry does not know the customer. */
export const customerDisplayName = (customer: CustomerListItem | undefined, unknownLabel: string): string =>
  customer?.displayName ?? unknownLabel;

/** Title of the source opportunity; undefined for manual invoices and unknown opportunities. */
export const opportunityTitle = (titles: ReadonlyMap<string, string>, invoice: Invoice): string | undefined =>
  invoice.opportunityId === undefined ? undefined : titles.get(invoice.opportunityId);

/**
 * Mirrors the owner's VoidInvoice rule: a draft, or a confirmed invoice with nothing paid that has not been sent
 * to accounting (sync not pending or done). Other invoices would be refused, so no Stornovat is offered.
 */
export const isVoidable = (invoice: Invoice): boolean =>
  invoice.businessState === 'DRAFT' ||
  (invoice.businessState === 'CONFIRMED' &&
    invoice.paidMinor === 0 &&
    invoice.accountingSyncState !== 'PENDING' &&
    invoice.accountingSyncState !== 'SYNCED');

/** Overdue is derived from the reference date, never stored. */
export const isOverdue = (invoice: Invoice, referenceDate: string): boolean =>
  invoice.businessState === 'CONFIRMED' && invoice.paymentState !== 'PAID' && invoice.dueDate < referenceDate;

/** Status-map key for the payment badge: the derived OVERDUE state, otherwise the stored payment state. */
export const paymentKind = (invoice: Invoice, referenceDate: string): string => {
  if (isOverdue(invoice, referenceDate)) {
    return 'OVERDUE';
  }
  const stored: string = invoice.paymentState;
  return stored === 'PARTIALLY_PAID' ? 'PARTIAL' : stored;
};

/** One status per invoice: the business state while draft or void, the payment state once confirmed. */
export const invoiceStatusBadge = (invoice: Invoice, referenceDate: string) =>
  invoice.businessState === 'CONFIRMED'
    ? ({ kind: 'payment', value: paymentKind(invoice, referenceDate) } as const)
    : ({ kind: 'invoice', value: invoice.businessState } as const);
