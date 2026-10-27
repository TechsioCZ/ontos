import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OrderLineSchema } from '../../shared/domain/merchandise-model.ts';
import type { Order } from '../../shared/domain/merchandise-model.ts';
import { fullOrderTotals } from '../../shared/domain/order-totals.ts';

it('calculates identical totals from encoded seed lines and decoded owner lines', () => {
  const line: typeof OrderLineSchema.Encoded = {
    productId: 'seed-product',
    productName: 'Seed product',
    quantity: 2,
    sku: 'SEED',
    unitPriceMinor: 12_100,
    vatRate: 21,
  };
  const shipping = {
    label: 'PPL',
    method: 'PPL',
    priceMinor: 1210,
    vatRate: 21,
  } satisfies NonNullable<Order['shipping']>;
  const expected = { totalMinor: 25_410, totalVatMinor: 4410 };

  expect(fullOrderTotals({ lines: [line], pricesIncludeVat: true, shipping })).toEqual(expected);
  expect(
    fullOrderTotals({
      lines: [Schema.decodeUnknownSync(OrderLineSchema)(line)],
      pricesIncludeVat: true,
      shipping,
    }),
  ).toEqual(expected);
});
