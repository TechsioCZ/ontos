// A product held at its stored rate (BOOK-IT on stage: reduced, priced at 10 % until Tax confirms the company) is shown
// to staff with its classification AND the rate that prices it, the same rate the storefront shows, so the net, the rate
// and the gross a person sees add up. An ordinary reduced or standard product shows its classification's rate.
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ProductSchema } from '../../shared/domain/merchandise-model.ts';
import { stockLevelsOf, toProductRecord } from '../../src/services/stock-levels.ts';
import { detailGrossOf, detailVatOf } from '../../src/routes/[lang]/provoz/produkty/product-detail-draft.ts';
import { withStaffVat, withStorefrontVat } from '../../src/services/merchandise-queries.ts';
import { TEST_RATES } from '../support/tax-fixtures.ts';

const record = (id: string, taxClassificationCode: string, net: number, gross: number) =>
  toProductRecord(
    Schema.decodeUnknownSync(ProductSchema)({
      active: true,
      category: 'Katalog',
      createdAt: '2026-10-19T08:00:00.000Z',
      currentPriceMinor: net,
      grossPriceMinor: gross,
      id,
      lowStockThreshold: 0,
      name: id,
      priceHistory: [],
      sku: id.toUpperCase(),
      taxClassificationCode,
      unit: 'ks',
      updatedAt: '2026-10-19T08:00:00.000Z',
    }),
    stockLevelsOf([], id),
    TEST_RATES,
    {},
  );
const HELD = { 'book-it': 10 };
const cases = [
  // BOOK-IT: reduced, held at 10 %: 490,00 net is 539,00 gross at 10 % (not 548,80 at 12 %).
  { applied: 10, classification: 'cz.vat.reduced', gross: 53_900, held: true, id: 'book-it', net: 49_000 },
  { applied: 12, classification: 'cz.vat.reduced', gross: 28_900, held: false, id: 'kava', net: 25_804 },
  { applied: 21, classification: 'cz.vat.standard', gross: 156_090, held: false, id: 'nb-air-13', net: 129_000 },
] as const;

it('staff see the classification and the rate that prices the product; the storefront shows the same rate', () => {
  for (const entry of cases) {
    const product = record(entry.id, entry.classification, entry.net, entry.gross);
    const staff = withStaffVat(product, TEST_RATES, HELD);
    const storefront = withStorefrontVat(product, TEST_RATES, HELD);
    expect([entry.id, staff.taxClassificationCode, staff.vatRate]).toEqual([
      entry.id,
      entry.classification,
      entry.applied,
    ]);
    expect([entry.id, storefront.vatRate]).toEqual([entry.id, staff.vatRate]);
  }
});

it('the detail form prices at the applied rate, says when it is a held one, and its net, rate and gross add up', () => {
  for (const entry of cases) {
    const staff = withStaffVat(record(entry.id, entry.classification, entry.net, entry.gross), TEST_RATES, HELD);
    const vat = detailVatOf(staff, entry.classification, TEST_RATES[entry.classification]);
    expect([entry.id, vat.appliedRate, vat.held]).toEqual([entry.id, entry.applied, entry.held]);
    // The stored triple is consistent at the applied rate (rounded to the whole crown as stored).
    expect([entry.id, Math.round(entry.net * (1 + entry.applied / 100))]).toEqual([entry.id, entry.gross]);
    // A new net price previews its gross at the applied rate: BOOK-IT's 500,00 is 550,00 (10 %), not 560,00.
    if (entry.held) {
      expect(detailGrossOf(staff, 50_000, vat.appliedRate)).toEqual({ kind: 'preview', minor: 55_000 });
    }
  }
  // Choosing another classification drops the hold: the chosen classification's rate applies.
  const bookIt = withStaffVat(record('book-it', 'cz.vat.reduced', 49_000, 53_900), TEST_RATES, HELD);
  expect(detailVatOf(bookIt, 'cz.vat.standard', TEST_RATES['cz.vat.standard'])).toEqual({
    appliedRate: 21,
    classificationRate: 21,
    held: false,
  });
});
