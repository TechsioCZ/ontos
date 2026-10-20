import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { createProductDetailQuery } from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import type { LoadOutcome } from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { ProductRecordSchema, sameSku } from '../../shared/domain/merchandise-model.ts';
import { productResourceDescriptor } from '../../shared/resources/product.ts';

it('owns its primary resource type', () => {
  expect(productResourceDescriptor.owningModuleId).toBe('demo.merchandise');
});

it('treats SKUs that differ only in case or outer spaces as the same product', () => {
  expect(sameSku('ms-ergo', 'MS-ERGO')).toBe(true);
  expect(sameSku(' KAB-1 ', 'KAB-1')).toBe(true);
  expect(sameSku('KAB-1', 'KAB-2')).toBe(false);
});

const response = (revision = 0) =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: false,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
    movements: [],
    orders: [],
    products: [],
    revision,
  });

it('detail query starts lazily, rejects invalid IDs without a read and has stable snapshots', () => {
  let reads = 0;
  const read = (_callback: (outcome: LoadOutcome) => void) => {
    reads += 1;
  };
  const query = createProductDetailQuery('product-1', read);
  expect(reads).toBe(0);
  expect(query.getSnapshot()).toBe(query.getSnapshot());
  const invalid = createProductDetailQuery('', read);
  const stop = invalid.subscribe(() => {});
  invalid.reload();
  expect(invalid.getSnapshot()).toEqual({ status: 'invalid' });
  expect(reads).toBe(0);
  stop();
});

it('detail query ignores stale results after reload and StrictMode unsubscribe/resubscribe', () => {
  const callbacks: ((outcome: LoadOutcome) => void)[] = [];
  const read = (outcomeListener: (outcome: LoadOutcome) => void) => {
    callbacks.push(outcomeListener);
  };
  const query = createProductDetailQuery('product-1', read);
  const firstStop = query.subscribe(() => {});
  firstStop();
  const secondStop = query.subscribe(() => {});
  expect(callbacks).toHaveLength(2);
  callbacks[0]?.({ ok: false, reason: 'forbidden' });
  expect(query.getSnapshot()).toEqual({ status: 'loading' });
  query.reload();
  callbacks[1]?.({ ok: false, reason: 'unavailable' });
  expect(query.getSnapshot()).toEqual({ status: 'loading' });
  callbacks[2]?.({ ok: true, response: response(2) });
  expect(query.getSnapshot()).toEqual({ status: 'not-found' });
  secondStop();
  callbacks[2]?.({ ok: false, reason: 'forbidden' });
  expect(query.getSnapshot()).toEqual({ status: 'not-found' });
});

it('detail query exposes forbidden failures and can retry without sharing state with another query', () => {
  const callbacks: ((outcome: LoadOutcome) => void)[] = [];
  const read = (outcomeListener: (outcome: LoadOutcome) => void) => {
    callbacks.push(outcomeListener);
  };
  const query = createProductDetailQuery('product-1', read);
  const separate = createProductDetailQuery('product-1', () => {});
  const stop = query.subscribe(() => {});
  callbacks[0]?.({ ok: false, reason: 'forbidden' });
  expect(query.getSnapshot()).toEqual({ reason: 'forbidden', status: 'error' });
  expect(separate.getSnapshot()).toEqual({ status: 'loading' });
  query.reload();
  callbacks[1]?.({ ok: true, response: response() });
  expect(query.getSnapshot()).toEqual({ status: 'not-found' });
  stop();
});

it('detail query resolves only the requested product and preserves read-only capability', () => {
  const product = Schema.decodeUnknownSync(ProductRecordSchema)({
    active: true,
    category: 'IT',
    createdAt: '2026-10-05T10:00:00Z',
    currentPriceMinor: 1050,
    id: 'product-1',
    lowStock: true,
    lowStockThreshold: 0,
    name: 'Cable',
    priceHistory: [],
    sku: 'CABLE',
    stockOnHand: 0,
    stockValueMinor: 0,
    unit: 'ks',
    updatedAt: '2026-10-05T10:00:00Z',
    vatRate: 21,
  });
  const loaded = { ...response(), products: [product] };
  const callbacks: ((outcome: LoadOutcome) => void)[] = [];
  const read = (outcomeListener: (outcome: LoadOutcome) => void) => {
    callbacks.push(outcomeListener);
  };
  const query = createProductDetailQuery('product-1', read);
  const missing = createProductDetailQuery('product-2', read);
  const stop = query.subscribe(() => {});
  const stopMissing = missing.subscribe(() => {});
  callbacks[0]?.({ ok: true, response: loaded });
  callbacks[1]?.({ ok: true, response: loaded });
  expect(query.getSnapshot()).toEqual({ product, response: loaded, status: 'ready' });
  expect(missing.getSnapshot()).toEqual({ status: 'not-found' });
  expect(loaded.canWrite).toBe(false);
  query.reload();
  callbacks[2]?.({ ok: false, reason: 'unavailable' });
  expect(query.getSnapshot()).toEqual({ product, refreshFailure: 'unavailable', response: loaded, status: 'ready' });
  query.reload();
  callbacks[3]?.({ ok: false, reason: 'forbidden' });
  expect(query.getSnapshot()).toEqual({ reason: 'forbidden', status: 'error' });
  stop();
  stopMissing();
});

it('detail query keeps release-change failures distinct from record revision conflicts', () => {
  const callbacks: ((outcome: LoadOutcome) => void)[] = [];
  const query = createProductDetailQuery('product-1', (callback) => callbacks.push(callback));
  const stop = query.subscribe(() => {});
  callbacks[0]?.({ ok: false, reason: 'reload-required' });
  expect(query.getSnapshot()).toEqual({ reason: 'reload-required', status: 'error' });
  query.reload();
  callbacks[1]?.({ ok: false, reason: 'conflict' });
  expect(query.getSnapshot()).toEqual({ reason: 'conflict', status: 'error' });
  stop();
});
