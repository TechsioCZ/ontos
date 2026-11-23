import { assert, it } from 'effect-rstest';
import { Effect, Predicate, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import {
  DemoOrderExportOrderSchema,
  DemoOrderExportRequestSchema,
  DemoOrderExportResponseSchema,
  DemoOrderExportAuthenticationProblemSchema,
  DemoOrderExportForbiddenProblemSchema,
} from '@app/merchandise/apis/demo-order-export';
import { executeDemoOrderExportWithAuthorization } from '@app/merchandise/apis/demo-order-export/client';
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
  lines: [
    {
      productId: 'persisted-product-7',
      productName: 'Šroub',
      quantity: 2,
      sku: 'ABRA-SKU-7',
      unitPriceMinor: 10_000,
      vatRate: 21,
    },
  ],
  number: 'OBJ-2026-0042',
  partyId: 'persisted-party-9',
  shipping: { label: 'PPL', method: 'PPL', priceMinor: 1210, vatRate: 21 },
  status: 'NEW',
  totalMinor: 25_410,
  totalVatMinor: 4410,
  updatedAt: '2026-11-22T11:00:00.000Z',
};
const decodeOrder = Schema.decodeUnknownSync(DemoOrderExportOrderSchema);
const response = (orders: readonly (typeof stored)[] = [stored], count = orders.length) =>
  Schema.decodeUnknownSync(DemoOrderExportResponseSchema)({ count, legalEntityId, orders, tenantId });
const expected = { legalEntityId, limit: 50, offset: 0, tenantId };

it('exports persisted order/customer IDs, address snapshots, quantity, totals, status and historical VAT', () => {
  const order = mapSymmyDemoOrder(decodeOrder(stored));
  assert.equal(order.id, stored.id);
  assert.equal(order.customerId, stored.partyId);
  assert.equal(order.customerAccountId, stored.customerAccountId);
  assert.equal(order.lines[0]?.quantity, 2);
  assert.equal(order.lines[0]?.totalMinor, 24_200);
  assert.equal(order.lines[0]?.totalVatMinor, 4200);
  assert.equal(order.totalMinor, stored.totalMinor);
  assert.equal(order.totalVatMinor, stored.totalVatMinor);
  assert.equal(order.totalNetMinor, 21_000);
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

it('gross-priced storefront lines keep the persisted currency and do not add VAT twice', () => {
  const order = mapSymmyDemoOrder(
    decodeOrder({
      ...stored,
      market: {
        currency: 'EUR',
        exchangeRate: '0.04',
        marketCode: 'EU',
        marketId: otherId,
        roundingMinor: 1,
      },
      pricesIncludeVat: true,
      totalMinor: 21_210,
      totalVatMinor: 3681,
    }),
  );
  assert.equal(order.currencyCode, 'EUR');
  assert.equal(order.lines[0]?.totalMinor, 20_000);
  assert.equal(order.lines[0]?.totalVatMinor, 3471);
  assert.equal(order.totalMinor, 21_210);
  assert.equal(order.totalVatMinor, 3681);
});

it('rejects missing company, cross-tenant and cross-company owner responses', () => {
  assert.throws(() => {
    Schema.decodeUnknownSync(DemoOrderExportResponseSchema)({ count: 0, orders: [], tenantId });
  });
  assert.equal(symmyDemoOrdersResultMatches(response(), expected), true);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, tenantId: otherId }), false);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, legalEntityId: otherId }), false);
});

it('enforces page size, duplicate IDs, counts and exact detail selector', () => {
  assert.equal(symmyDemoOrdersResultMatches(response([stored, stored], 2), expected), false);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, limit: 0 }), false);
  assert.equal(symmyDemoOrdersResultMatches(response([stored], 0), expected), false);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, offset: 5 }), false);
  assert.equal(symmyDemoOrdersResultMatches(response([], 2), { ...expected, offset: 5 }), true);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, orderId: stored.id }), true);
  assert.equal(symmyDemoOrdersResultMatches(response(), { ...expected, orderId: 'different-order' }), false);
  assert.equal(symmyDemoOrdersResultMatches(response([stored], 2), { ...expected, orderId: stored.id }), false);
});

it('rejects invalid pagination and invalid detail IDs at the request boundary', () => {
  for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 0.5 }]) {
    assert.throws(() => {
      Schema.decodeUnknownSync(SymmyDemoOrdersQuerySchema)(query);
    });
  }
  assert.throws(() => {
    Schema.decodeUnknownSync(DemoOrderExportRequestSchema)({ limit: 1, offset: 0, orderId: '' });
  });
  assert.throws(() => {
    Schema.decodeUnknownSync(DemoOrderExportRequestSchema)({ limit: 1, offset: 0, orderId: 'x'.repeat(301) });
  });
  assert.deepEqual(Schema.decodeUnknownSync(SymmyDemoOrdersUrlQuerySchema)({ limit: '25', offset: '50' }), {
    limit: 25,
    offset: 50,
  });
  assert.throws(() => {
    Schema.decodeUnknownSync(SymmyDemoOrdersUrlQuerySchema)({ limit: '0' });
  });
});

it.effect('the real owner client sends the exact authenticated page/detail and composition revision', () =>
  Effect.gen(function* ownerRequest() {
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
    const result = yield* executeDemoOrderExportWithAuthorization(
      payload,
      'Bearer request-local-owner-assertion',
      'order-export-test',
      {
        baseUrl: 'https://owner.example.test/merchandise-api',
        compositionRevision: 'a'.repeat(64),
      },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    assert.equal(calls.length, 1);
    const [request] = calls;
    assert.ok(request);
    assert.equal(request.url, 'https://owner.example.test/merchandise-api/reads/demo-order-export');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('authorization'), 'Bearer request-local-owner-assertion');
    assert.equal(request.headers.get('x-ontos-composition-revision'), 'a'.repeat(64));
    assert.equal(request.headers.get('cache-control'), 'no-store');
    assert.deepEqual(yield* Effect.promise(() => request.json()), payload);
    assert.equal(result.orders[0]?.id, stored.id);
    assert.equal(result.legalEntityId, legalEntityId);
  }),
);

it.effect('owner authentication and company permission refusals remain errors, never successful empty exports', () =>
  Effect.gen(function* ownerRefusals() {
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
          headers: { 'content-type': 'application/problem+json' },
          status: problem.status,
        });
      const error = yield* executeDemoOrderExportWithAuthorization(
        { limit: 50, offset: 0 },
        'Bearer refused',
        'refused-export-test',
        {
          baseUrl: 'https://owner.example.test/merchandise-api',
        },
      ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fetch));
      assert.equal(Predicate.isTagged(error, problem._tag), true);
    }
  }),
);
