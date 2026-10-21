import { DateTime, Option, Schema } from 'effect';
import type { InvoiceLine, VatRate } from '../apis/records.ts';
import { computeInvoiceTotals } from './invoice-totals.ts';

/** Payment terms offered on a new invoice, in calendar days after the issue date. */
export const PAYMENT_TERM_DAYS = [7, 14, 30] as const;
export type PaymentTermDays = (typeof PAYMENT_TERM_DAYS)[number];
/** 10 % has been obsolete since 1. 1. 2024; `VatRate` still decodes it so stored invoices keep reading. */
export const VAT_RATE_CHOICES: readonly VatRate[] = [0, 12, 21];

export const DraftLineKindSchema = Schema.Literals(['free', 'product']);
export type DraftLineKind = typeof DraftLineKindSchema.Type;

/**
 * One line on the create form. A product line carries a snapshot of the catalog product taken when it is
 * picked; a free line is typed by hand. Both end up as the same stored `InvoiceLine`.
 */
export type DraftDiscountKind = 'AMOUNT' | 'NONE' | 'PERCENT';

export interface DraftLine {
  readonly description: string;
  /** Approved discount: NONE, a whole percentage, or a fixed amount in CZK; the reason is required with it. */
  readonly discountKind?: DraftDiscountKind;
  /** Raw typed discount text, so a half-typed "10," stays visible. */
  readonly discountInput?: string;
  readonly discountReason?: string;
  /** PERCENT: whole percent 1–100; AMOUNT: CZK (two decimals). */
  readonly discountValue?: number;
  /** Price-list item the free line was filled from. */
  readonly priceListItemId?: string | null;
  readonly key: string;
  readonly kind: DraftLineKind;
  readonly productId: string | null;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly vatRate: VatRate;
}

export const DraftLineIssueSchema = Schema.Literals([
  'amount',
  'description',
  'discount',
  'price',
  'product',
  'quantity',
]);
export type DraftLineIssue = typeof DraftLineIssueSchema.Type;

/** Largest quantity the stored invoice line accepts (`InvoiceLineSchema`). */
export const MAX_LINE_QUANTITY = 1_000_000;

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

/** The stored discount of a draft line, or undefined for none (or an incomplete one, which `lineIssue` flags). */
export const draftLineDiscount = (line: DraftLine): InvoiceLine['discount'] => {
  const kind = line.discountKind ?? 'NONE';
  const value = line.discountValue ?? Number.NaN;
  const reason = (line.discountReason ?? '').trim();
  if (kind === 'NONE' || !Number.isFinite(value) || value <= 0 || reason === '') {
    return undefined;
  }
  return { kind, reason, value: kind === 'PERCENT' ? Math.round(value) : czkToMinor(value) };
};

export const toInvoiceLine = (line: DraftLine): InvoiceLine => {
  const discount = draftLineDiscount(line);
  const invoiceLine: InvoiceLine = {
    description: line.description.trim(),
    ...(discount === undefined ? {} : { discount }),
    ...(line.kind === 'free' && line.priceListItemId !== undefined && line.priceListItemId !== null
      ? { priceListItemId: line.priceListItemId }
      : {}),
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    vatRate: line.vatRate,
  };
  if (line.kind === 'product' && line.productId !== null) {
    return { ...invoiceLine, productId: line.productId };
  }
  return invoiceLine;
};

/**
 * A problem with a typed number on the line: quantity, price, or a line amount past the money range. Unlike a
 * missing product or description, it is never the state of a fresh line, so the form shows it while typing.
 */
export const lineValueIssue = (line: DraftLine): DraftLineIssue | undefined => {
  if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_LINE_QUANTITY) {
    return 'quantity';
  }
  if (!Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
    return 'price';
  }
  if ((line.discountKind ?? 'NONE') !== 'NONE') {
    const value = line.discountValue ?? Number.NaN;
    const percentInvalid = line.discountKind === 'PERCENT' && (!Number.isInteger(value) || value < 1 || value > 100);
    const amountInvalid =
      line.discountKind === 'AMOUNT' &&
      (!Number.isFinite(value) || value <= 0 || czkToMinor(value) > line.quantity * line.unitPriceMinor);
    if (percentInvalid || amountInvalid || (line.discountReason ?? '').trim() === '') {
      return 'discount';
    }
  }
  // A valid quantity times a large price can pass the stored money range, which would total as 0 Kč.
  return computeInvoiceTotals([toInvoiceLine(line)]) === undefined ? 'amount' : undefined;
};

export const lineIssue = (line: DraftLine): DraftLineIssue | undefined => {
  if (line.kind === 'product' && line.productId === null) {
    return 'product';
  }
  if (line.kind === 'free' && line.description.trim() === '') {
    return 'description';
  }
  return lineValueIssue(line);
};

export interface DraftTotals {
  readonly subtotalMinor: number;
  readonly totalMinor: number;
  readonly vatMinor: number;
}

/**
 * Totals of the complete lines, using the same arithmetic the backend stores on create. Returns `undefined` when
 * the lines together pass the money range, so the form flags the sum instead of showing 0 Kč.
 */
export const draftTotals = (lines: readonly DraftLine[]): DraftTotals | undefined => {
  const totals = computeInvoiceTotals(lines.filter((line) => lineIssue(line) === undefined).map(toInvoiceLine));
  return totals === undefined
    ? undefined
    : { subtotalMinor: totals.subtotalMinor, totalMinor: totals.totalMinor, vatMinor: totals.vatMinor };
};

/**
 * Calendar date `days` after an ISO date (`YYYY-MM-DD`), computed as the backend computes due dates.
 * Returns `undefined` for a date that does not parse, such as a half-typed year from a date input.
 */
export const addCalendarDays = (isoDate: string, days: number): string | undefined =>
  Option.getOrUndefined(
    Option.map(DateTime.make(`${isoDate}T00:00:00.000Z`), (date) =>
      DateTime.formatIsoDateUtc(DateTime.add(date, { days })),
    ),
  );

/** Years an issue date may fall in; a mistyped year such as 0001 is rejected instead of producing a 1900s due date. */
const ISSUE_DATE_YEARS = { max: 2100, min: 2000 } as const;

/** A parseable calendar date in the accepted issue-date years. */
export const isPlausibleIssueDate = (isoDate: string): boolean => {
  const year = Number(isoDate.slice(0, 4));
  return year >= ISSUE_DATE_YEARS.min && year <= ISSUE_DATE_YEARS.max && addCalendarDays(isoDate, 0) !== undefined;
};
