// The price history's "Cena s DPH": a history entry stores only the net price, so only the price in force now has a
// price including VAT (its stored gross); every earlier price shows none instead of one invented from today's rate.
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { priceHistoryRows } from '../../src/routes/[lang]/provoz/produkty/product-price-history.ts';

const product = Schema.decodeSync(ProductRecordSchema)({
  active: true,
  category: 'Káva',
  createdAt: '2026-01-01T00:00:00.000Z',
  currentPriceMinor: 900,
  grossPriceMinor: 1100,
  id: 'product-1',
  lowStock: false,
  lowStockThreshold: 0,
  name: 'Káva',
  priceHistory: [{ effectiveFrom: '2026-01-01T00:00:00.000Z', priceMinor: 900 }],
  sku: 'KAVA',
  stockOnHand: 0,
  stockValueMinor: 0,
  taxClassificationCode: 'cz.vat.reduced',
  unit: 'ks',
  updatedAt: '2026-01-01T00:00:00.000Z',
  variantRecords: [
    {
      active: true,
      attributes: '',
      availability: 'IN_STOCK',
      // Stored gross 13 Kč, not 10 Kč net plus 12 %.
      grossPriceMinor: 1300,
      id: 'v1',
      name: '1 kg',
      priceHistory: [
        { effectiveFrom: '2026-02-01T00:00:00.000Z', priceMinor: 800 },
        { effectiveFrom: '2026-03-01T00:00:00.000Z', previousPriceMinor: 800, priceMinor: 1000 },
      ],
      priceMinor: 1000,
      sku: 'KAVA-1KG',
      stockOnHand: 5,
    },
  ],
});

it('shows the stored gross for the prices in force now and none for earlier prices', () => {
  expect(priceHistoryRows(product).map((row) => [row.name, row.net, row.gross])).toEqual([
    ['1 kg · KAVA-1KG', 1000, 1300],
    ['1 kg · KAVA-1KG', 800, undefined],
    ['Základní cena produktu · KAVA', 900, 1100],
  ]);
});
