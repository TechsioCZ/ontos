import { DateTime, Schema } from 'effect';
import type { InvoiceLine, VatRate } from '../apis/records.ts';
import { computeInvoiceTotals } from './invoice-totals.ts';

/** Payment terms offered on a new invoice, in calendar days after the issue date. */
export const PAYMENT_TERM_DAYS = [7, 14, 30] as const;
export type PaymentTermDays = (typeof PAYMENT_TERM_DAYS)[number];
export const VAT_RATE_CHOICES: readonly VatRate[] = [0, 10, 12, 21];

export const DraftLineKindSchema = Schema.Literals(['free', 'product']);
export type DraftLineKind = typeof DraftLineKindSchema.Type;

/**
 * One line on the create form. A product line carries a snapshot of the catalog product taken when it is
 * picked; a free line is typed by hand. Both end up as the same stored `InvoiceLine`.
 */
export interface DraftLine {
  readonly description: string;
  readonly key: string;
  readonly kind: DraftLineKind;
  readonly productId: string | null;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly vatRate: VatRate;
}

export const DraftLineIssueSchema = Schema.Literals(['description', 'price', 'product', 'quantity']);
export type DraftLineIssue = typeof DraftLineIssueSchema.Type;

export const newDraftLine = (key: string, kind: DraftLineKind): DraftLine => ({
  description: '',
  key,
  kind,
  productId: null,
  quantity: 1,
  unitPriceMinor: 0,
  vatRate: 21,
});

/** Copies the product name, current price and VAT rate into the line; later catalog changes do not reach it. */
export const withProductSnapshot = (
  line: DraftLine,
  product: {
    readonly currentPriceMinor: number;
    readonly id: string;
    readonly name: string;
    readonly vatRate: VatRate;
  },
): DraftLine => ({
  ...line,
  description: product.name,
  productId: product.id,
  unitPriceMinor: product.currentPriceMinor,
  vatRate: product.vatRate,
});

/** Form amounts are entered in CZK and stored in minor units (haléře). */
export const czkToMinor = (czk: number): number => Math.round(czk * 100);

export const lineIssue = (line: DraftLine): DraftLineIssue | undefined => {
  if (line.kind === 'product' && line.productId === null) {
    return 'product';
  }
  if (line.kind === 'free' && line.description.trim() === '') {
    return 'description';
  }
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    return 'quantity';
  }
  if (!Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
    return 'price';
  }
  return undefined;
};

export const toInvoiceLine = (line: DraftLine): InvoiceLine => {
  const invoiceLine: InvoiceLine = {
    description: line.description.trim(),
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    vatRate: line.vatRate,
  };
  if (line.kind === 'product' && line.productId !== null) {
    return { ...invoiceLine, productId: line.productId };
  }
  return invoiceLine;
};

export interface DraftTotals {
  readonly subtotalMinor: number;
  readonly totalMinor: number;
  readonly vatMinor: number;
}

/** Totals of the complete lines, using the same arithmetic the backend stores on create. */
export const draftTotals = (lines: readonly DraftLine[]): DraftTotals => {
  const totals = computeInvoiceTotals(lines.filter((line) => lineIssue(line) === undefined).map(toInvoiceLine));
  return {
    subtotalMinor: totals?.subtotalMinor ?? 0,
    totalMinor: totals?.totalMinor ?? 0,
    vatMinor: totals?.vatMinor ?? 0,
  };
};

/** Calendar date `days` after an ISO date (`YYYY-MM-DD`), computed as the backend computes due dates. */
export const addCalendarDays = (isoDate: string, days: number): string =>
  DateTime.formatIsoDateUtc(DateTime.add(DateTime.makeUnsafe(`${isoDate}T00:00:00.000Z`), { days }));
