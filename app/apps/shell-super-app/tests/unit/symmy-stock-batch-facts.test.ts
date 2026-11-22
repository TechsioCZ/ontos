import {
  SourceStockPositionResolutionRequestSchema,
  SourceStockPositionResolutionResponseSchema,
  SourceStockPositionResolutionUnavailableProblemSchema,
  SourceStockPositionResolutionForbiddenProblemSchema,
} from '@app/inventory/api/source-stock-position-resolution';
import type { SourceStockPositionResolutionResponse } from '@app/inventory/api/source-stock-position-resolution';
import { SymmyRouteContextResponseSchema } from '@app/symmy-integration/api/symmy-route-context';
import { SymmyStockPositionFactsSchema, SymmyStockRowsSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { assert, describe, expect, it } from 'effect-rstest';

import {
  SymmyClientIdempotencyKeySchema,
  SymmyStockDependencyNotReadyProblemSchema,
  SymmyStockInputProblemSchema,
  SymmyStockSourceUnavailableProblemSchema,
} from '../../api/symmy/contract.ts';
import { makeSymmyGovernedDispatch } from '../../api/symmy/governed-dispatch.ts';
import type { SymmyIngressAdmission } from '../../api/symmy/transport.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const revision = 'a'.repeat(64);
const ref = (kind: string, resourceId: string) => ({
  moduleId: 'commerce.inventory',
  resourceId,
  resourceType: `commerce.inventory.${kind}`,
  tenantId,
});
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const source = {
  customerConfigurationId: 'configuration',
  externalScope: 'erp-stock',
  issuer: { backendId: 'erp-backend', backendKind: 'external_business_system' },
  locations: [
    { locationKey: 'warehouse-1', stockLocationRef: ref('stock-location', '55555555-5555-4555-8555-555555555555') },
  ],
  namespace: 'erp-items',
  policyRef: ref('source-provisioning-policy', '44444444-4444-4444-8444-444444444444'),
  unitRef,
};
const readOperation = {
  entrypointKey: 'commerce.inventory.api.source-stock-position-resolution',
  moduleId: 'commerce.inventory',
  schemaVersion: '1',
};
const route = Schema.decodeUnknownSync(SymmyRouteContextResponseSchema)({
  allowedOwnerOperations: [
    readOperation,
    { entrypointKey: 'commerce.inventory.import-source-assertion', moduleId: 'commerce.inventory', schemaVersion: '1' },
  ],
  inventorySource: source,
  issuerId: 'erp',
  legalEntityId,
  mappingVersion: 'v1',
  routeId: '66666666-6666-4666-8666-666666666666',
  routeRevision: 'r1',
  sourceMappingVersion: 'v1',
  sourceNamespace: 'erp',
  sourceRouteId: '66666666-6666-4666-8666-666666666666',
  sourceRouteRevision: 'r1',
  tenantId,
});
const row = (itemKey: string) => ({
  businessObservedAt: '2026-01-01T10:00:00.000Z',
  itemKey,
  locationKey: 'warehouse-1',
  quantity: { amount: '10', unitRef },
  revision: '1',
  sourceReference: itemKey,
});
const rows = Schema.decodeUnknownSync(SymmyStockRowsSchema)([row('new-A'), row('new-B')]);
const resolved = (itemKey: string) =>
  Schema.decodeUnknownSync(SourceStockPositionResolutionResponseSchema.members[0])({
    _tag: 'RESOLVED',
    policyRef: source.policyRef,
    positionRef: ref(
      'stock-position',
      itemKey === 'new-A' ? '88888888-8888-4888-8888-888888888881' : '88888888-8888-4888-8888-888888888882',
    ),
    stockItemRef: ref(
      'stock-item',
      itemKey === 'new-A' ? '77777777-7777-4777-8777-777777777771' : '77777777-7777-4777-8777-777777777772',
    ),
    stockLocationRef: source.locations[0]?.stockLocationRef,
  });
const syncPayloadSchema = Schema.Struct({
  stock: SymmyStockRowsSchema,
  stockFacts: Schema.optionalKey(SymmyStockPositionFactsSchema),
});
const assertion = (audience: string) => ({
  apiBaseUrl: `/shell-super-app-api/module-api/${audience}/release/${audience}-api`,
  assertion: Redacted.make('test-assertion'),
  compositionRevision: revision,
});
const harness = (
  options: {
    readonly admissionConflict?: boolean;
    readonly ownerStatus?: 403 | 503;
    readonly response?: SourceStockPositionResolutionResponse;
    readonly route?: typeof route;
  } = {},
) => {
  const requests: Request[] = [];
  const acquisitions: { readonly audience: string; readonly legalEntityId?: string }[] = [];
  const admission: SymmyIngressAdmission = {
    ...assertion('symmy-integration'),
    acquireOwnerAssertion: (input) =>
      Effect.sync(() => {
        acquisitions.push(input);
        return assertion(input.audience);
      }),
    acquireRouteAssertion: () => Effect.succeed({ ...assertion('symmy-integration'), route: options.route ?? route }),
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.includes('/reads/source-stock-position-resolution')) {
      if (options.ownerStatus !== undefined) {
        const details = {
          detail: 'Owner cannot serve this read.',
          title: 'Owner read refused',
          type: 'https://ontos.dev/problems/owner-read',
        };
        const problem =
          options.ownerStatus === 503
            ? SourceStockPositionResolutionUnavailableProblemSchema.make({ ...details, retryable: true, status: 503 })
            : SourceStockPositionResolutionForbiddenProblemSchema.make({ ...details, status: 403 });
        return Response.json(problem, {
          headers: { 'content-type': 'application/problem+json' },
          status: problem.status,
        });
      }
      const payload = await Schema.decodeUnknownPromise(SourceStockPositionResolutionRequestSchema)(
        await request.clone().json(),
      );
      return Response.json(
        Schema.encodeSync(SourceStockPositionResolutionResponseSchema)(options.response ?? resolved(payload.itemKey)),
      );
    }
    if (options.admissionConflict === true) {
      return Response.json(
        {
          _tag: 'AdmitSymmySyncActionConflictProblem',
          code: 'symmy_sync_intent_conflict',
          detail: 'The key records another intent.',
          status: 409,
          title: 'Conflict',
          type: 'https://ontos.dev/problems/admit-symmy-sync-conflict',
        },
        { headers: { 'content-type': 'application/problem+json' }, status: 409 },
      );
    }
    return Response.json({
      items: [
        {
          effects: [
            {
              effectId: '99999999-9999-4999-8999-999999999999',
              owner: 'commerce.inventory',
              status: 'accepted_change',
            },
          ],
          itemId: '99999999-9999-4999-8999-999999999998',
        },
      ],
    });
  };
  const dispatch = makeSymmyGovernedDispatch(Effect.succeed('transport-id'));
  const apply = (stock = rows) =>
    dispatch
      .apply({
        admission,
        request: {
          idempotencyKey: Schema.decodeUnknownSync(SymmyClientIdempotencyKeySchema)('source-key'),
          route: 'inventoryStockBatch',
          stock,
        },
      })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  return { acquisitions, apply, requests };
};

describe('public Symmy stock fresh-admission facts and replay', () => {
  it.effect('reads two unseen keys through the governed Inventory client and passes facts only before admission', () =>
    Effect.gen(function* test() {
      const h = harness();
      yield* h.apply();
      expect(h.requests.map((request) => new URL(request.url).pathname.split('/').at(-1))).toEqual([
        'source-stock-position-resolution',
        'source-stock-position-resolution',
        'admit-symmy-sync',
      ]);
      const request = h.requests.at(-1);
      assert.isDefined(request);
      const payload = yield* Effect.promise(() => request.clone().json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(syncPayloadSchema)),
      );
      expect(payload.stockFacts).toEqual(
        rows.map((stockRow) => ({
          request: {
            customerConfigurationId: source.customerConfigurationId,
            externalScope: source.externalScope,
            issuer: source.issuer,
            itemKey: stockRow.itemKey,
            locationKey: stockRow.locationKey,
            namespace: source.namespace,
          },
          resolution: resolved(stockRow.itemKey),
        })),
      );
      expect(payload.stock).toEqual(rows);
      // The admitting route has a company; Inventory still receives only Tenant authority.
      expect(h.acquisitions).toEqual([{ audience: 'inventory' }, { audience: 'inventory' }]);
    }),
  );

  it.effect('resolves each distinct ITEM+LOCATION once even when several source revisions name the pair', () =>
    Effect.gen(function* test() {
      const h = harness();
      yield* h.apply(
        Schema.decodeUnknownSync(SymmyStockRowsSchema)([
          row('new-A'),
          { ...row('new-A'), revision: '2' },
          row('new-B'),
        ]),
      );
      expect(h.requests.filter((request) => request.url.includes('/reads/'))).toHaveLength(2);
    }),
  );

  it.effect('replay omits facts and makes no Inventory read even when the current source policy is absent', () =>
    Effect.gen(function* test() {
      const { inventorySource: _policy, ...withoutPolicy } = route;
      const replayRoute = Schema.decodeUnknownSync(SymmyRouteContextResponseSchema)({
        ...withoutPolicy,
        allowedOwnerOperations: [],
        replayIdempotencyDigest: 'c'.repeat(64),
      });
      const h = harness({ ownerStatus: 503, route: replayRoute });
      yield* h.apply();
      expect(h.acquisitions).toEqual([]);
      expect(h.requests).toHaveLength(1);
      const [request] = h.requests;
      assert.isDefined(request);
      const payload = yield* Effect.promise(() => request.clone().json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(syncPayloadSchema)),
      );
      expect(payload.stockFacts).toBeUndefined();
      const divergent = harness({ admissionConflict: true, ownerStatus: 503, route: replayRoute });
      expect(
        yield* divergent
          .apply(Schema.decodeUnknownSync(SymmyStockRowsSchema)([{ ...row('new-A'), revision: 'changed' }]))
          .pipe(Effect.flip),
      ).toMatchObject({ status: 409 });
      expect(divergent.acquisitions).toEqual([]);
      expect(divergent.requests).toHaveLength(1);
    }),
  );

  it.effect('a configured saved key recovers without rereading revoked correlations or an unavailable owner', () =>
    Effect.gen(function* test() {
      const original = yield* harness().apply();
      const retained = Schema.decodeUnknownSync(SymmyRouteContextResponseSchema)({
        ...route,
        allowedOwnerOperations: [],
        replayIdempotencyDigest: 'c'.repeat(64),
      });
      for (const h of [
        harness({ response: { _tag: 'UNRESOLVED', reason: 'ITEM_NOT_PROVISIONED' }, route: retained }),
        harness({ ownerStatus: 503, route: retained }),
      ]) {
        expect(yield* h.apply()).toEqual(original);
        expect(h.acquisitions).toEqual([]);
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0]?.url).toContain('/actions/admit-symmy-sync');
      }
      const changed = harness({ admissionConflict: true, ownerStatus: 503, route: retained });
      expect(
        yield* changed
          .apply(
            Schema.decodeUnknownSync(SymmyStockRowsSchema)([
              {
                ...row('new-A'),
                quantity: { amount: '999', unitRef },
              },
            ]),
          )
          .pipe(Effect.flip),
      ).toMatchObject({ status: 409 });
      expect(changed.acquisitions).toEqual([]);
      expect(changed.requests).toHaveLength(1);
    }),
  );

  it.effect('unprovisioned stock remains retryable and causes no admission', () =>
    Effect.gen(function* test() {
      const h = harness({ response: { _tag: 'UNRESOLVED', reason: 'ITEM_NOT_PROVISIONED' } });
      const failure = yield* h.apply().pipe(Effect.flip);
      expect(Schema.is(SymmyStockDependencyNotReadyProblemSchema)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'ITEM_NOT_PROVISIONED', retryable: true, status: 503 });
      expect(h.requests.every((request) => request.url.includes('/reads/'))).toBe(true);
    }),
  );

  it.effect('refuses wrong policy, tenant, location and backend resolution before admission', () =>
    Effect.gen(function* test() {
      const answer = resolved('new-A');

      const responses: readonly SourceStockPositionResolutionResponse[] = [
        Schema.decodeUnknownSync(SourceStockPositionResolutionResponseSchema)({
          ...answer,
          policyRef: { ...answer.policyRef, resourceId: '44444444-4444-4444-8444-444444444445' },
        }),
        Schema.decodeUnknownSync(SourceStockPositionResolutionResponseSchema)({
          ...answer,
          positionRef: { ...answer.positionRef, tenantId: legalEntityId },
        }),
        Schema.decodeUnknownSync(SourceStockPositionResolutionResponseSchema)({
          ...answer,
          stockLocationRef: { ...answer.stockLocationRef, resourceId: '55555555-5555-4555-8555-555555555556' },
        }),
        { _tag: 'UNRESOLVED', reason: 'POLICY_NOT_FOUND' },
      ];
      yield* Effect.forEach(
        responses,
        (response) =>
          Effect.gen(function* refuse() {
            const h = harness({ response });
            expect(yield* h.apply().pipe(Effect.flip)).toMatchObject({ status: 503 });
            expect(h.requests.some((request) => request.url.includes('/actions/'))).toBe(false);
          }),
        { concurrency: 1 },
      );
    }),
  );

  it.effect('denies an unenrolled read or a foreign source-policy Tenant without acquiring Inventory authority', () =>
    Effect.gen(function* test() {
      const deniedRoutes = [
        {
          ...route,
          allowedOwnerOperations: route.allowedOwnerOperations.filter(
            ({ entrypointKey }) => entrypointKey !== readOperation.entrypointKey,
          ),
        },
        { ...route, tenantId: legalEntityId },
      ];
      yield* Effect.forEach(
        deniedRoutes,
        (deniedRoute) =>
          Effect.gen(function* refuse() {
            const h = harness({ route: Schema.decodeUnknownSync(SymmyRouteContextResponseSchema)(deniedRoute) });
            const failure = yield* h.apply().pipe(Effect.flip);
            expect([403, 503]).toContain(failure.status);
            expect(h.requests).toHaveLength(0);
            expect(h.acquisitions).toHaveLength(0);
          }),
        { concurrency: 1 },
      );
    }),
  );

  it.effect('answers actionable nonretryable input errors before calling Inventory', () =>
    Effect.gen(function* test() {
      yield* Effect.forEach(
        [
          { reason: 'LOCATION_NOT_ENROLLED', row: { ...row('new-A'), locationKey: 'foreign-warehouse' } },
          {
            reason: 'UNIT_NOT_ENROLLED',
            row: {
              ...row('new-A'),
              quantity: { amount: '1', unitRef: { ...unitRef, resourceId: '33333333-3333-4333-8333-333333333334' } },
            },
          },
        ],
        ({ reason, row: invalid }) =>
          Effect.gen(function* refuse() {
            const h = harness();
            const failure = yield* h.apply(Schema.decodeUnknownSync(SymmyStockRowsSchema)([invalid])).pipe(Effect.flip);
            expect(Schema.is(SymmyStockInputProblemSchema)(failure)).toBe(true);
            expect(failure).toMatchObject({
              itemKey: invalid.itemKey,
              locationKey: invalid.locationKey,
              reason,
              status: 422,
            });
            expect('retryable' in failure && failure.retryable).not.toBe(true);
            expect(h.requests).toHaveLength(0);
          }),
        { concurrency: 1 },
      );
    }),
  );

  it.effect('preserves owner authority and readiness reasons without blaming the caller', () =>
    Effect.gen(function* test() {
      for (const reason of [
        'POLICY_NOT_FOUND',
        'LOCATION_NOT_ALLOWED',
        'ITEM_CORRELATION_AMBIGUOUS',
        'POSITION_NOT_FOUND',
      ] as const) {
        const h = harness({ response: { _tag: 'UNRESOLVED', reason } });
        const failure = yield* h.apply().pipe(Effect.flip);
        expect(failure).toMatchObject({ reason, retryable: true, status: 503 });
        expect(Schema.is(SymmyStockInputProblemSchema)(failure)).toBe(false);
        expect(h.requests).toHaveLength(1);
      }
      const outage = yield* harness({ ownerStatus: 503 }).apply().pipe(Effect.flip);
      expect(Schema.is(SymmyStockSourceUnavailableProblemSchema)(outage)).toBe(true);
      expect(outage).toMatchObject({ reason: 'OWNER_UNAVAILABLE', status: 503 });
      expect(yield* harness({ ownerStatus: 403 }).apply().pipe(Effect.flip)).toMatchObject({ status: 403 });
      const foreignTenant = harness();
      expect(
        yield* foreignTenant
          .apply(
            Schema.decodeUnknownSync(SymmyStockRowsSchema)([
              {
                ...row('new-A'),
                quantity: { amount: '1', unitRef: { ...unitRef, tenantId: legalEntityId } },
              },
            ]),
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: 'TENANT_SCOPE_MISMATCH', status: 503 });
      expect(foreignTenant.requests).toEqual([]);
    }),
  );
});
