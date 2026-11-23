import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import {
  DemoOrderExportOrderSchema,
  DemoOrderExportRequestSchema,
  DemoOrderExportResponseSchema,
  DemoOrderExportAuthenticationProblemSchema,
  DemoOrderExportForbiddenProblemSchema,
} from '../../../../verticals/merchandise/shared/apis/demo-order-export.ts';
import { executeDemoOrderExportWithAuthorization } from '../../../../verticals/merchandise/src/api/demo-order-export-client.ts';
import {
  SymmyDemoOrderSchema,
  SymmyDemoOrdersQuerySchema,
  SymmyDemoOrdersUrlQuerySchema,
  mapSymmyDemoOrder,
  symmyDemoOrdersResultMatches,
} from '../../api/symmy/demo-orders-contract.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const stored = {
  billingAddress: { city: 'Praha', country: 'CZ', postalCode: '11000', street: 'Fakturační 1' },
  contact: { email: 'orders@example.test', name: 'Export customer' },
  createdAt: '2026-11-22T10:00:00.000Z',
  customerAccountId: 'persisted-customer-account',
  deliveryAddress: { city: 'Brno', country: 'CZ', postalCode: '60200', street: 'Doručovací 2' },
  deliveryRecipient: { firstName: 'Petr', lastName: 'Příjemce', phone: '+420111222333' },
  history: [{ actorLabel: 'Private staff identity', at: '2026-11-22T10:00:00.000Z', kind: 'CREATED' }],
  id: 'persisted-order-42',
  lines: [{
    productId: 'persisted-product-7',
    productName: 'Šroub',
    quantity: 2,
    sku: 'ABRA-SKU-7',
    unitPriceMinor: 10000,
    vatRate: 21,
  }],
  number: 'OBJ-2026-0042',
  partyId: 'persisted-party-9',
  shipping: { label: 'PPL', method: 'PPL', priceMinor: 1210, vatRate: 21 },
  status: 'NEW',
  totalMinor: 25410,
  totalVatMinor: 4410,
  updatedAt: '2026-11-22T11:00:00.000Z',
};
const decodeOrder = Schema.decodeUnknownSync(DemoOrderExportOrderSchema);
const response = (orders: readonly typeof stored[] = [stored], count = orders.length) =>
  Schema.decodeUnknownSync(DemoOrderExportResponseSchema)({ count, legalEntityId, orders, tenantId });
const expected = { legalEntityId, limit: 50, offset: 0, tenantId };

test('exports persisted order/customer IDs, address snapshots, quantity, totals, status and historical VAT', () => {
  const order = mapSymmyDemoOrder(decodeOrder(stored));
  assert.equal(order.id, stored.id);
  assert.equal(order.customerId, stored.partyId);
  assert.equal(order.customerAccountId, stored.customerAccountId);
  assert.equal(order.lines[0]?.quantity, 2);
  assert.equal(order.lines[0]?.totalMinor, 24200);
  assert.equal(order.lines[0]?.totalVatMinor, 4200);
  assert.equal(order.totalMinor, stored.totalMinor);
  assert.equal(order.totalVatMinor, stored.totalVatMinor);
  assert.equal(order.totalNetMinor, 21000);
  assert.equal(order.currencyCode, 'CZK');
  assert.equal(order.pricesIncludeVat, false);
  assert.equal(order.status, stored.status);
  assert.deepEqual(order.billingAddress, stored.billingAddress);
  assert.deepEqual(order.deliveryAddress, stored.deliveryAddress);
  assert.deepEqual(order.deliveryRecipient, stored.deliveryRecipient);
  assert.equal(order.createdAt, stored.createdAt);
  assert.equal('history' in order, false);
  assert.equal(Schema.is(SymmyDemoOrderSchema)(order), true);
});

test('gross-priced storefront lines keep the persisted currency and do not add VAT twice', () => {
  const order = mapSymmyDemoOrder(decodeOrder({
    ...stored,
    market: {
      currency: 'EUR',
      exchangeRate: '0.04',
      marketCode: 'EU',
      marketId: otherId,
      roundingMinor: 1,
    },
    pricesIncludeVat: true,
    totalMinor: 21210,
    totalVatMinor: 3681,
  }));
  assert.equal(order.currencyCode, 'EUR');
  assert.equal(order.lines[0]?.totalMinor, 20000);
  assert.equal(order.lines[0]?.totalVatMinor, 3471);
  assert.equal(order.totalMinor, 21210);
  assert.equal(order.totalVatMinor, 3681);
});

test('rejects missing company, cross-tenant and cross-company owner responses', () => {
  assert.throws(() => Schema.decodeUnknownSync(DemoOrderExportResponseSchema)({ count: 0, orders: [], tenantId }));
  assert.equal(symmyDemoOrdersResultMatches(response(), expected), true);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, tenantId: otherId }), false);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, legalEntityId: otherId }), false);
});

test('enforces page size, duplicate IDs, counts and exact detail selector', () => {
  assert.equal(symmyDemoOrdersResultMatches(response([stored, stored], 2), expected), false);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, limit: 0 }), false);
  assert.equal(symmyDemoOrdersResultMatches(response([stored], 0), expected), false);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, offset: 5 }), false);
  assert.equal(symmyDemoOrdersResultMatches(response([], 2), { ...expected, offset: 5 }), true);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, orderId: stored.id }), true);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, orderId: 'different-order' }), false);
  assert.equal(symmyDemoOrdersResultMatches(response([stored], 2), { ...expected, orderId: stored.id }), false);
});

test('rejects invalid pagination and invalid detail IDs at the request boundary', () => {
  for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 0.5 }]) {
    assert.throws(() => Schema.decodeUnknownSync(SymmyDemoOrdersQuerySchema)(query));
  }
  assert.throws(() => Schema.decodeUnknownSync(DemoOrderExportRequestSchema)({ limit: 1, offset: 0, orderId: '' }));
  assert.throws(() => Schema.decodeUnknownSync(DemoOrderExportRequestSchema)({ limit: 1, offset: 0, orderId: 'x'.repeat(301) }));
  assert.deepEqual(
    Schema.decodeUnknownSync(SymmyDemoOrdersUrlQuerySchema)({ limit: '25', offset: '50' }),
    { limit: 25, offset: 50 },
  );
  assert.throws(() => Schema.decodeUnknownSync(SymmyDemoOrdersUrlQuerySchema)({ limit: '0' }));
});

test('the real owner client sends the exact authenticated page/detail and composition revision', async () => {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    return Response.json({ count: 1, legalEntityId, orders: [stored], tenantId });
  };
  const payload = Schema.decodeUnknownSync(DemoOrderExportRequestSchema)({
    limit: 1,
    offset: 0,
    orderId: stored.id,
  });
  const result = await Effect.runPromise(
    executeDemoOrderExportWithAuthorization(payload, 'Bearer request-local-owner-assertion', 'order-export-test', {
      baseUrl: 'https://owner.example.test/merchandise-api',
      compositionRevision: 'a'.repeat(64),
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
  );
  assert.equal(calls.length, 1);
  const [request] = calls;
  assert.ok(request);
  assert.equal(request.url, 'https://owner.example.test/merchandise-api/reads/demo-order-export');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('authorization'), 'Bearer request-local-owner-assertion');
  assert.equal(request.headers.get('x-ontos-composition-revision'), 'a'.repeat(64));
  assert.equal(request.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await request.json(), payload);
  assert.equal(result.orders[0]?.id, stored.id);
  assert.equal(result.legalEntityId, legalEntityId);
});

test('owner authentication and company permission refusals remain errors, never successful empty exports', async () => {
  for (const problem of [
    DemoOrderExportAuthenticationProblemSchema.make({
      detail: 'Fresh assertion required',
      status: 401,
      title: 'Authentication required',
      type: 'https://ontos.dev/problems/authentication',
    }),
    DemoOrderExportForbiddenProblemSchema.make({
      detail: 'Company export not granted',
      status: 403,
      title: 'Forbidden',
      type: 'https://ontos.dev/problems/forbidden',
    }),
  ]) {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json(problem, {
        status: problem.status,
        headers: { 'content-type': 'application/problem+json' },
      });
    const error = await Effect.runPromise(
      executeDemoOrderExportWithAuthorization({ limit: 50, offset: 0 }, 'Bearer refused', 'refused-export-test', {
        baseUrl: 'https://owner.example.test/merchandise-api',
      }).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fetch)),
    );
    assert.equal(error._tag, problem._tag);
  }
});

test('publishes the mounted owner endpoint and its exact company-scoped workload operation', async () => {
  const { extractVerticalRuntimeSafeDescriptors } = await import('@app/core-runtime');
  const { merchandiseBackendRegistration } = await import('../../../../verticals/merchandise/vertical.runtime-declaration.ts');
  const { merchandiseApi } = await import('@app/merchandise/api');
  const { demoOrderExportRead } = await import('../../../../verticals/merchandise/src/api/demo-order-export.read.ts');
  const { demoOrderExportApiLive } = await import('../../../../verticals/merchandise/api/demo-order-export-server.ts');
  const { SYMMY_DEMO_ORDER_EXPORT_WORKLOAD, demoOrderExportOperation } = await import('@app/merchandise/apis/demo-order-export');
  const client = await import('@app/merchandise/apis/demo-order-export/client');
  const descriptors = extractVerticalRuntimeSafeDescriptors(merchandiseBackendRegistration);
  const contract = descriptors.operationContracts.find(({ operationKey }) => operationKey === 'demoOrderExport.execute');
  assert.ok(contract);
  assert.equal(contract.apiKey, 'demo.merchandise.demo-order-export');
  assert.equal(contract.entrypoint.entrypointKey, demoOrderExportOperation.entrypointKey);
  assert.equal(contract.entrypoint.authorization.kind, 'protected');
  assert.equal(contract.schemaVersion, '1');
  assert.deepEqual(contract.workloadCarrier, {
    declarationKey: demoOrderExportOperation.declarationKey,
    workloads: [SYMMY_DEMO_ORDER_EXPORT_WORKLOAD],
  });
  assert.equal(SYMMY_DEMO_ORDER_EXPORT_WORKLOAD, 'demo.merchandise.symmy-order-export');
  assert.equal(demoOrderExportRead.descriptor.legalEntityScope, 'required');
  assert.equal(merchandiseApi.groups.demoOrderExport.endpoints.execute.path, '/reads/demo-order-export');
  assert.equal(merchandiseApi.groups.demoOrderExport.endpoints.execute.method, 'POST');
  assert.equal(Layer.isLayer(demoOrderExportApiLive), true);
  assert.equal(typeof client.executeDemoOrderExportWithAuthorization, 'function');
});
