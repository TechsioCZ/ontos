import type { Invoice } from '../../../../../shared/apis/records.ts';

/**
 * Customer label. Party names come from the party registry in a later lane; until then the
 * opaque party identity is shown as is.
 */
export const customerName = (partyId: string): string => partyId;

export const invoiceCustomerId = (invoice: Invoice): string => invoice.partyId ?? invoice.counterpartyRef.resourceId;

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
