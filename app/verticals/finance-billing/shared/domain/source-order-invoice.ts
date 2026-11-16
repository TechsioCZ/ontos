import type { Invoice } from '../apis/records.ts';

/**
 * The invoice an order of Provoz already has in Finance for one direction: a received invoice of a purchase order, an
 * issued invoice of a sales order. An order has at most one that is not voided, so this is the stable identity of
 * "the invoice of this order": whoever asks again (another tab, device, person or agent) is answered with it. A voided
 * invoice no longer counts, so its order can be invoiced anew.
 */
export const invoiceOfSourceOrder = (
  invoices: readonly Invoice[],
  direction: Invoice['direction'],
  sourceOrder: NonNullable<Invoice['sourceOrder']>,
): Invoice | undefined =>
  invoices.find(
    (record) =>
      record.direction === direction && record.businessState !== 'VOIDED' && record.sourceOrder?.id === sourceOrder.id,
  );
