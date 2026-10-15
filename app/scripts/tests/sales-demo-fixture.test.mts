import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { demoId, uuidV5 } from '../demo/fixture-ids.mts';
import {
  catalog,
  invoices,
  openingReceiptQuantity,
  orders,
  productByKey,
  snapshotPriceMinor,
} from '../demo/sales-plan.mts';

it('retains the UUIDv5 fixture identities across cold resets', () => {
  expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
    '2ed6657d-e927-568b-95e1-2665a8aea6a2',
  );
  expect(demoId('product', 'p01')).toBe('58565ec1-b1b4-5fbf-a5af-94857d71f8c8');
  expect(demoId('opportunity', 'o01')).toBe('2d22ae01-ac63-59a5-81b8-f6fa502d715b');
  expect(demoId('customer', 'c01')).toBe('fbdd110f-e514-53e9-9832-20f6e4cb1f9d');
});

it.effect('resolves every planned line and preserves snapshot prices and opening stock', () =>
  Effect.gen(function* verifySalesPlan() {
    for (const line of [...orders, ...invoices].flatMap((document) => document.lines)) {
      const product = yield* productByKey(line.productKey);
      expect(snapshotPriceMinor(product, 15)).toBe(product.originalPriceMinor);
      expect(snapshotPriceMinor(product, 14)).toBe(product.currentPriceMinor);
    }
    for (const product of catalog) {
      const sold = orders
        .filter((order) => order.status !== 'CANCELLED')
        .flatMap((order) => order.lines)
        .filter((line) => line.productKey === product.key)
        .reduce((sum, line) => sum + line.quantity, 0);
      expect(openingReceiptQuantity(product)).toBe(product.openingStock + sold);
    }
    const missing = yield* productByKey('missing-product').pipe(Effect.flip);
    expect(Predicate.isTagged(missing, 'UnknownDemoProduct')).toBe(true);
    expect(missing.key).toBe('missing-product');
  }),
);
