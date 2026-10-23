import { expect, it } from 'effect-rstest';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { Option, Schema } from 'effect';
import { HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import {
  detailInput,
  detailState,
  productDetailData,
  recordsReason,
} from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
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

const product = () =>
  Schema.decodeUnknownSync(ProductRecordSchema)({
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

it('detail page reads nothing for an id no product can have', () => {
  expect(Option.isNone(detailInput('entity-1', ''))).toBe(true);
  expect(detailState(false, pageDataPending)).toEqual({ status: 'invalid' });
  expect(Option.getOrThrow(detailInput('entity-1', 'product-1'))).toEqual({
    legalEntityId: 'entity-1',
    productId: 'product-1',
  });
});

it('detail data is one entry per company and product', () => {
  const input = Option.getOrThrow(detailInput('entity-1', 'product-1'));
  expect(productDetailData.key(input)).toBe(productDetailData.key({ ...input }));
  expect(productDetailData.key(input)).not.toBe(productDetailData.key({ ...input, legalEntityId: 'entity-2' }));
});

it('detail page resolves only the requested product and preserves read-only capability', () => {
  const cable = product();
  const loaded = { ...response(), products: [cable] };
  expect(detailState(true, pageDataPending)).toEqual({ status: 'loading' });
  expect(
    detailState(true, { refreshing: false, state: 'ready', value: { product: Option.some(cable), response: loaded } }),
  ).toEqual({ product: cable, response: loaded, status: 'ready' });
  expect(
    detailState(true, { refreshing: false, state: 'ready', value: { product: Option.none(), response: loaded } }),
  ).toEqual({ status: 'not-found' });
  expect(loaded.canWrite).toBe(false);
});

it('detail page keeps release-change, permission and revision failures distinct', () => {
  for (const reason of ['reload-required', 'forbidden', 'conflict'] as const) {
    expect(detailState(true, { error: reason, refreshing: false, state: 'failed' })).toEqual({
      reason,
      status: 'error',
    });
  }
});

it('plain module admission 409 requires document reload, not query retry or a connection message', () => {
  const error = (
    status: number,
    url = 'http://localhost:3020/module-api/merchandise/release/merchandise-api/reads/records',
  ) => {
    const request = HttpClientRequest.get(url);
    const response = HttpClientResponse.fromWeb(
      request,
      new Response('Reload the document to use the active release', { status }),
    );
    return new HttpClientError.HttpClientError({ reason: new HttpClientError.DecodeError({ request, response }) });
  };
  expect(recordsReason(error(409))).toBe('reload-required');
  expect(recordsReason(error(503))).toBe('unavailable');
  expect(recordsReason(error(409, 'http://localhost:4120/merchandise-api/reads/records'))).toBe('unavailable');
});
