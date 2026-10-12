import type { InvoiceLine, VatRecapEntry } from '../apis/records.ts';

/** Fixed demo invoice series; numbers are `FV-2026-0001`, `FV-2026-0002`, … */
export const INVOICE_NUMBER_PREFIX = 'FV-2026-';
const MAX_MONEY_MINOR = 1_000_000_000_000;
const VAT_RATE_ORDER = [21, 12, 10, 0] as const;

export interface InvoiceTotals {
  readonly subtotalMinor: number;
  readonly totalMinor: number;
  readonly vatMinor: number;
  readonly vatRecap: readonly VatRecapEntry[];
}

/** Line base in minor units: quantity × unit price, no rounding needed for integer inputs. */
export const lineBaseMinor = (line: Pick<InvoiceLine, 'quantity' | 'unitPriceMinor'>): number =>
  line.quantity * line.unitPriceMinor;

/** VAT of one line, rounded half-up to whole minor units (bases are non-negative integers). */
export const lineVatMinor = (line: Pick<InvoiceLine, 'quantity' | 'unitPriceMinor' | 'vatRate'>): number =>
  Math.floor((lineBaseMinor(line) * line.vatRate + 50) / 100);

const withinMoneyRange = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MONEY_MINOR;

/**
 * Computes stored invoice totals from line snapshots. VAT is rounded per line (half-up in minor units) and the
 * recap sums those rounded line amounts per rate, so recap, subtotal and total always reconcile exactly.
 * Returns `undefined` when any amount leaves the bounded money range.
 */
export const computeInvoiceTotals = (lines: readonly InvoiceLine[]): InvoiceTotals | undefined => {
  const byRate = new Map<number, { baseMinor: number; vatMinor: number }>();
  for (const line of lines) {
    const baseMinor = lineBaseMinor(line);
    if (!withinMoneyRange(baseMinor)) {
      return undefined;
    }
    const entry = byRate.get(line.vatRate) ?? { baseMinor: 0, vatMinor: 0 };
    byRate.set(line.vatRate, {
      baseMinor: entry.baseMinor + baseMinor,
      vatMinor: entry.vatMinor + lineVatMinor(line),
    });
  }
  const vatRecap = VAT_RATE_ORDER.flatMap((rate) => {
    const entry = byRate.get(rate);
    return entry === undefined ? [] : [{ baseMinor: entry.baseMinor, rate, vatMinor: entry.vatMinor }];
  });
  let subtotalMinor = 0;
  let vatMinor = 0;
  for (const entry of vatRecap) {
    subtotalMinor += entry.baseMinor;
    vatMinor += entry.vatMinor;
  }
  const totalMinor = subtotalMinor + vatMinor;
  const amounts = [
    subtotalMinor,
    vatMinor,
    totalMinor,
    ...vatRecap.flatMap((entry) => [entry.baseMinor, entry.vatMinor]),
  ];
  return amounts.every(withinMoneyRange) ? { subtotalMinor, totalMinor, vatMinor, vatRecap } : undefined;
};

/** Next number of the demo series, monotonically above every number already present in state. */
export const nextInvoiceNumber = (existing: readonly { readonly number?: string }[]): string => {
  let highest = 0;
  for (const record of existing) {
    if (record.number?.startsWith(INVOICE_NUMBER_PREFIX) === true) {
      const sequence = Number(record.number.slice(INVOICE_NUMBER_PREFIX.length));
      if (Number.isSafeInteger(sequence) && sequence > highest) {
        highest = sequence;
      }
    }
  }
  return `${INVOICE_NUMBER_PREFIX}${String(highest + 1).padStart(4, '0')}`;
};
