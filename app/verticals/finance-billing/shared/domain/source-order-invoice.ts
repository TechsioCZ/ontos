import type { Invoice, InvoiceDocumentKind } from '../apis/records.ts';

/** One billing part of a Provoz order: its invoices in one direction of one document kind (a plain one by default). */
export interface SourceOrderPart {
  readonly direction: Invoice['direction'];
  readonly documentKind?: InvoiceDocumentKind | undefined;
  readonly sourceOrder: NonNullable<Invoice['sourceOrder']>;
}

const kindOf = (kind: InvoiceDocumentKind | undefined): InvoiceDocumentKind => kind ?? 'STANDARD';

/**
 * The invoice Finance already holds for one billing part of an order (an advance, a partial, the final or the plain
 * invoice): the stable identity of "the invoice of this part", so whoever asks again (another tab, device, person or
 * agent) is answered with it. Another kind is another part and gets its own invoice; a voided invoice no longer
 * counts. Amounts and lines edited in Finance keep it the same invoice.
 */
export const invoiceOfSourceOrderPart = (invoices: readonly Invoice[], part: SourceOrderPart): Invoice | undefined =>
  invoices.find(
    (record) =>
      record.direction === part.direction &&
      record.businessState !== 'VOIDED' &&
      record.sourceOrder?.id === part.sourceOrder.id &&
      kindOf(record.documentKind) === kindOf(part.documentKind),
  );
