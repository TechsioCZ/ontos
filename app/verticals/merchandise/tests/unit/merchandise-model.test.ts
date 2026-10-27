import { expect, it } from 'effect-rstest';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { Option, Schema } from 'effect';
import { HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/http';
import {
  RecordsRequestSchema,
  RecordsResponseSchema,
  StorefrontCatalogQuerySchema,
} from '../../shared/apis/records.ts';
import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import {
  detailInput,
  detailState,
  productDetailData,
  recordsReason,
} from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import {
  CatalogCategorySchema,
  CategoryNodeSchema,
  OrderSchema,
  ProductMetadataSchema,
  ProductRecordSchema,
  VariantSummarySchema,
  sameSku,
} from '../../shared/domain/merchandise-model.ts';
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

const admissionError = (
  status: number,
  url = 'http://localhost:3020/module-api/merchandise/release/merchandise-api/reads/records',
) => {
  const request = HttpClientRequest.get(url);
  const httpResponse = HttpClientResponse.fromWeb(
    request,
    new Response('Reload the document to use the active release', { status }),
  );
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.DecodeError({ request, response: httpResponse }),
  });
};

it('plain module admission 409 requires document reload, not query retry or a connection message', () => {
  expect(recordsReason(admissionError(409))).toBe('reload-required');
  expect(recordsReason(admissionError(503))).toBe('unavailable');
  expect(recordsReason(admissionError(409, 'http://localhost:4120/merchandise-api/reads/records'))).toBe('unavailable');
});

it('preserves omitted and explicitly cleared product metadata on the wire', () => {
  const omitted = Schema.decodeSync(ProductMetadataSchema)({});
  expect(Schema.encodeSync(ProductMetadataSchema)(omitted)).toEqual({});
  const cleared = Schema.decodeSync(ProductMetadataSchema)({ featuredPosition: null });
  expect(cleared.featuredPosition).toEqual(Option.none());
  expect(Schema.encodeSync(ProductMetadataSchema)(cleared)).toEqual({ featuredPosition: null });
  const positioned = Schema.decodeSync(ProductMetadataSchema)({ featuredPosition: 0 });
  expect(positioned.featuredPosition).toEqual(Option.some(0));
  expect(Schema.encodeSync(ProductMetadataSchema)(positioned)).toEqual({ featuredPosition: 0 });
  expect(Schema.is(Schema.toEncoded(ProductMetadataSchema))({ featuredPosition: omitted.featuredPosition })).toBe(
    false,
  );
});

it('encodes root and child category parents without changing their ids or null sentinel', () => {
  for (const parentId of [null, 'parent-category']) {
    const wire = {
      description: '',
      hasChildren: false,
      heading: '',
      id: 'category-1',
      imageAlt: '',
      imageSrc: '',
      longDescription: '',
      name: 'Category',
      parentId,
      position: 0,
      slug: 'category',
    };
    const category = Schema.decodeSync(CatalogCategorySchema)(wire);
    expect(Option.getOrNull(category.parentId)).toBe(parentId);
    expect(Schema.encodeSync(CatalogCategorySchema)(category)).toEqual(wire);
    const node = Schema.decodeSync(CategoryNodeSchema)(wire);
    expect(Schema.encodeSync(CategoryNodeSchema)(node)).toEqual(wire);
  }
});

it('preserves a missing variant minimum and an omitted versus missing storefront order status', () => {
  const summary = { count: 0, minGrossPriceMinor: null, stockOnHand: 0, units: [] };
  const decoded = Schema.decodeSync(VariantSummarySchema)(summary);
  expect(decoded.minGrossPriceMinor).toEqual(Option.none());
  expect(Schema.encodeSync(VariantSummarySchema)(decoded)).toEqual(summary);
  const wire = Schema.encodeSync(RecordsResponseSchema)(response());
  expect(Object.hasOwn(wire, 'orderStatus')).toBe(false);
  const notFound = Schema.decodeSync(RecordsResponseSchema)({ ...wire, orderStatus: null });
  expect(notFound.orderStatus).toEqual(Option.none());
  expect(Schema.encodeSync(RecordsResponseSchema)(notFound)).toEqual({ ...wire, orderStatus: null });
  expect(Schema.is(Schema.toEncoded(RecordsResponseSchema))({ ...wire, orderStatus: response().orderStatus })).toBe(
    false,
  );
});

it('keeps branded record ids as the same encoded strings and preserves legacy opaque references', () => {
  const wire = {
    view: {
      categoryId: 'category-1',
      orderClientRequestId: 'request-0001',
      orderCustomerPartyIds: ['party-1'],
      orderId: 'order-1',
      orderIds: ['order-1'],
      orderOpportunityId: 'opportunity-1',
      productIds: ['product-1'],
      storefrontCustomerOrders: { customerAccountId: 'customer-1', orderId: 'order-1' },
      storefrontOrderStatus: { clientRequestId: 'request-0001', orderId: 'order-1' },
      taggedOrderIds: ['order-1'],
      taggedProductIds: ['product-1'],
    },
  };
  expect(Schema.encodeSync(RecordsRequestSchema)(Schema.decodeSync(RecordsRequestSchema)(wire))).toEqual(wire);
  const catalog = { productIds: ['', 'product-1'], variantIds: ['', 'variant-1'] };
  expect(
    Schema.encodeSync(StorefrontCatalogQuerySchema)(Schema.decodeSync(StorefrontCatalogQuerySchema)(catalog)),
  ).toEqual(catalog);
});

it('preserves the encoded order snapshot and command patch, including replay identity and totals', () => {
  const wire = {
    clientRequestId: '  request-0001  ',
    createdAt: '2026-10-05T10:00:00.000Z',
    id: 'order-1',
    lines: [
      { productId: 'product-1', productName: 'Product', quantity: 1, sku: 'SKU', unitPriceMinor: 100, vatRate: 21 },
    ],
    number: 'OBJ-2026-0001',
    partyId: 'party-1',
    status: 'NEW',
    totalMinor: 121,
    totalVatMinor: 21,
    updatedAt: '2026-10-05T10:00:00.000Z',
  } satisfies typeof OrderSchema.Encoded;
  expect(Schema.encodeSync(OrderSchema)(Schema.decodeSync(OrderSchema)(wire))).toEqual(wire);
  const command = {
    _tag: 'UpdateProduct',
    id: 'product-1',
    patch: { categoryId: 'category-1', featuredPosition: null, sourceId: 'source-1' },
  } satisfies typeof MerchandiseCommandSchema.Encoded;
  expect(Schema.encodeSync(MerchandiseCommandSchema)(Schema.decodeSync(MerchandiseCommandSchema)(command))).toEqual(
    command,
  );
});
