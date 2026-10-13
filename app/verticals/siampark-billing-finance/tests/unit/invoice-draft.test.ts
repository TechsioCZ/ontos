import { describe, expect, it } from 'effect-rstest';
import {
  addCalendarDays,
  czkToMinor,
  draftTotals,
  lineIssue,
  newDraftLine,
  toInvoiceLine,
  withProductSnapshot,
} from '../../shared/domain/invoice-draft.ts';

describe('Invoice create form lines', () => {
  it('snapshots the product name, price and VAT rate when the product is picked', () => {
    const product = { currentPriceMinor: 129_000, id: 'p-1', name: 'Konzultace', vatRate: 21 as const };
    const line = withProductSnapshot({ ...newDraftLine('line-1', 'product'), quantity: 2 }, product);

    expect(toInvoiceLine(line)).toEqual({
      description: 'Konzultace',
      productId: 'p-1',
      quantity: 2,
      unitPriceMinor: 129_000,
      vatRate: 21,
    });
    expect(lineIssue(newDraftLine('line-2', 'product'))).toBe('product');
  });

  it('validates free-text lines and totals only the complete ones', () => {
    const free = {
      ...newDraftLine('line-3', 'free'),
      description: '  Školení ',
      unitPriceMinor: czkToMinor(1000.5),
    };
    const incomplete = newDraftLine('line-4', 'product');
    const product = withProductSnapshot(
      { ...newDraftLine('line-5', 'product'), quantity: 2 },
      {
        currentPriceMinor: 129_000,
        id: 'p-1',
        name: 'Konzultace',
        vatRate: 21,
      },
    );

    expect(lineIssue(newDraftLine('line-6', 'free'))).toBe('description');
    expect(lineIssue({ ...free, quantity: 0 })).toBe('quantity');
    expect(lineIssue({ ...free, unitPriceMinor: -1 })).toBe('price');
    expect(toInvoiceLine(free)).toEqual({
      description: 'Školení',
      quantity: 1,
      unitPriceMinor: 100_050,
      vatRate: 21,
    });
    // Product 258 000 at 21 % → VAT 54 180; free 100 050 at 21 % → VAT 21 011; the incomplete line is skipped.
    expect(draftTotals([product, free, incomplete])).toEqual({
      subtotalMinor: 358_050,
      totalMinor: 433_241,
      vatMinor: 75_191,
    });
  });

  it('adds payment terms to the issue date like the backend does', () => {
    expect(addCalendarDays('2026-10-05', 14)).toBe('2026-10-19');
    expect(addCalendarDays('2026-10-05', 30)).toBe('2026-11-04');
  });
});
