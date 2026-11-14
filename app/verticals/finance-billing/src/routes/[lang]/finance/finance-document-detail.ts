import { Schema } from 'effect';

import type { FinanceDocument, Invoice } from '../../../../shared/apis/records.ts';
import type { FinanceFeedback } from './use-finance-records.ts';

const FinanceDocumentDetailIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('FinanceDocumentDetailId'),
);

/** A superseded or unmounted detail must not display or download a late document response. */
export const financeDocumentReadLifetime = () => {
  let generation = 0;
  return {
    begin: () => {
      generation += 1;
      const requestGeneration = generation;
      return () => requestGeneration === generation;
    },
    invalidate: () => {
      generation += 1;
    },
  };
};

/**
 * Shell route target for a Finance document search hit. The document UUID is a `documentId` query value; it is never
 * the invoice `resourceId`, because the two owner records have different identities.
 */
export const financeDocumentRecordTarget = (documentId: string) =>
  ({ search: { documentId }, to: '/finance' }) as const;

/** Browser URL for the same target, kept separate from the invoice `?resourceId=` detail. */
export const financeDocumentDetailPath = (documentId: string) =>
  `/finance?documentId=${encodeURIComponent(documentId)}`;

export const isFinanceDocumentDetailId = (documentId: string): boolean =>
  Schema.is(FinanceDocumentDetailIdSchema)(documentId);

/** The URL names one owner detail. Two different record IDs are a conflict, not a reason to guess one. */
export const financeRecordDetailConflict = (search: {
  readonly documentId?: string | undefined;
  readonly resourceId?: string | undefined;
}): boolean => search.documentId !== undefined && search.resourceId !== undefined;

export type FinanceDocumentDetailState =
  | {
      readonly state: 'forbidden' | 'invalid' | 'loading' | 'missing' | 'unavailable';
    }
  | {
      readonly document: FinanceDocument;
      readonly state: 'ready';
    };

/**
 * A denied read hides even a document that an earlier successful read left in memory. A loaded ledger that no longer
 * holds the ID is a missing document, not a reason to open an invoice with the same string.
 */
export const financeDocumentDetailState = ({
  documentId,
  documents,
  feedback,
}: {
  readonly documentId?: string | undefined;
  readonly documents?: readonly FinanceDocument[] | undefined;
  readonly feedback: FinanceFeedback;
}): FinanceDocumentDetailState => {
  if (documentId === undefined || !isFinanceDocumentDetailId(documentId)) {
    return { state: 'invalid' };
  }
  if (feedback === 'forbidden') {
    return { state: 'forbidden' };
  }
  if (feedback === 'unavailable' || feedback === 'conflict' || feedback === 'validation') {
    return { state: 'unavailable' };
  }
  const document = documents?.find((entry) => entry.id === documentId);
  if (document !== undefined) {
    return { document, state: 'ready' };
  }
  if (feedback === 'loading' || documents === undefined) {
    return { state: 'loading' };
  }
  return { state: 'missing' };
};

export type FinanceDocumentInvoiceLink =
  | { readonly invoice: Invoice; readonly kind: 'linked' }
  | { readonly invoiceResourceId: string; readonly kind: 'missing' }
  | { readonly kind: 'none' };

/** The invoice the document belongs to, when that invoice is still in the current authorized ledger. */
export const financeDocumentInvoiceLink = (
  invoices: readonly Invoice[] | undefined,
  document: FinanceDocument,
): FinanceDocumentInvoiceLink => {
  if (document.invoiceResourceId === undefined) {
    return { kind: 'none' };
  }
  const invoice = invoices?.find((entry) => entry.ref.resourceId === document.invoiceResourceId);
  return invoice === undefined
    ? { invoiceResourceId: document.invoiceResourceId, kind: 'missing' }
    : { invoice, kind: 'linked' };
};
