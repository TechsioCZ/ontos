import { GatewayUnavailableProblemSchema } from '@app/shared-contracts';
import {
  AdmitSymmySyncActionIneligibleProblemSchema,
  AdmitSymmySyncActionUnavailableProblemSchema,
} from '@app/symmy-integration/api/admit-symmy-sync-action';
import { SymmyRouteContextResponseSchema } from '@app/symmy-integration/api/symmy-route-context';
import { SymmyStockRowsSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Exit, Logger, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  SymmyClientIdempotencyKeySchema,
  SymmyStockDependencyNotReadyProblemSchema,
  SymmyStockInputProblemSchema,
  SymmyStockSourceUnavailableProblemSchema,
  SymmyUnavailableProblemSchema,
} from '../../apps/shell-super-app/api/symmy/contract.ts';
import { makeSymmyGovernedDispatch } from '../../apps/shell-super-app/api/symmy/governed-dispatch.ts';
import type { SymmyIngressAdmission } from '../../apps/shell-super-app/api/symmy/transport.ts';
import {
  decodeInternalSyncProblem,
  syncNegativeResponseSchemas,
} from '../integration/support/symmy-c14-sync-response-contracts.mts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const inventoryModuleId = 'commerce.inventory';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const row = {
  businessObservedAt: '2026-01-01T10:00:00.000Z',
  itemKey: 'unprovisioned-stock',
  locationKey: 'warehouse',
  quantity: { amount: '10', unitRef },
  revision: '1',
  sourceReference: 'stock-source',
};
const route = Schema.decodeUnknownSync(SymmyRouteContextResponseSchema)({
  allowedOwnerOperations: [
    {
      entrypointKey: 'commerce.inventory.api.source-stock-position-resolution',
      moduleId: inventoryModuleId,
      schemaVersion: '1',
    },
  ],
  inventorySource: {
    customerConfigurationId: 'configuration',
    externalScope: 'stock',
    issuer: { backendId: 'backend', backendKind: 'external_business_system' },
    locations: [
      {
        locationKey: row.locationKey,
        stockLocationRef: {
          moduleId: inventoryModuleId,
          resourceId: otherId,
          resourceType: 'commerce.inventory.stock-location',
          tenantId,
        },
      },
    ],
    namespace: 'stock',
    policyRef: {
      moduleId: inventoryModuleId,
      resourceId: otherId,
      resourceType: 'commerce.inventory.source-provisioning-policy',
      tenantId,
    },
    unitRef,
  },
  issuerId: 'issuer',
  mappingVersion: 'v1',
  routeId: otherId,
  routeRevision: 'r1',
  sourceMappingVersion: 'v1',
  sourceNamespace: 'stock',
  sourceRouteId: otherId,
  sourceRouteRevision: 'r1',
  tenantId,
});
const assertion = {
  apiBaseUrl: '/shell-super-app-api/module-api/symmy-integration/release/symmy-integration-api',
  assertion: Redacted.make('test-only-assertion'),
  compositionRevision: 'a'.repeat(64),
};
const admission: SymmyIngressAdmission = {
  ...assertion,
  acquireOwnerAssertion: () =>
    Effect.succeed({
      ...assertion,
      apiBaseUrl: '/shell-super-app-api/module-api/inventory/release/inventory-api',
    }),
  acquireRouteAssertion: () => Effect.succeed({ ...assertion, route }),
};
const dispatch = makeSymmyGovernedDispatch(Effect.succeed('test-request'));
const idempotencyKey = Schema.decodeUnknownSync(SymmyClientIdempotencyKeySchema)('test-stock-key');
const stockFailure = (input: {
  readonly admission?: SymmyIngressAdmission;
  readonly fetch: typeof globalThis.fetch;
  readonly row?: typeof row;
}) =>
  dispatch
    .apply({
      admission: input.admission ?? admission,
      request: {
        idempotencyKey,
        route: 'inventoryStockBatch',
        stock: Schema.decodeUnknownSync(SymmyStockRowsSchema)([input.row ?? row]),
      },
    })
    .pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, input.fetch));

const problemBody = <A extends { readonly status: number }>(schema: Schema.ConstraintEncoder<A>, value: A) =>
  HttpServerResponse.schemaJson(schema)(value, { status: value.status }).pipe(
    Effect.flatMap((response) => Effect.promise(() => HttpServerResponse.toWeb(response).text())),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
  );

for (const reason of ['ITEM_NOT_PROVISIONED', 'POSITION_NOT_FOUND'] as const) {
  it.effect(`decodes Shell's public ${reason} refusal without admitting or importing Stock`, () =>
    Effect.gen(function* stockReadinessContract() {
      const requests: string[] = [];
      const failure = yield* stockFailure({
        fetch: (url) => {
          requests.push(new Request(url).url);
          return Promise.resolve(Response.json({ _tag: 'UNRESOLVED', reason }));
        },
      });
      expect(Schema.is(SymmyStockDependencyNotReadyProblemSchema)(failure)).toBe(true);
      const publicProblem = yield* Schema.decodeUnknownEffect(SymmyStockDependencyNotReadyProblemSchema)(failure);
      expect(Schema.is(syncNegativeResponseSchemas.unavailable)(publicProblem)).toBe(false);
      const body = yield* problemBody(SymmyStockDependencyNotReadyProblemSchema, publicProblem);
      const decoded = yield* decodeInternalSyncProblem({
        body,
        phase: 'stock-unprovisioned-row',
        schema: syncNegativeResponseSchemas.stockDependency,
        status: 503,
      });
      expect(decoded).toMatchObject({
        itemKey: row.itemKey,
        locationKey: row.locationKey,
        reason,
        retryable: true,
        status: 503,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain('/reads/source-stock-position-resolution');
    }),
  );
}

it.effect('validates exact unit, location and tenant refusals before any owner request', () =>
  Effect.gen(function* stockInputContracts() {
    for (const input of [
      { changed: { ...row, locationKey: 'not-enrolled' }, reason: 'LOCATION_NOT_ENROLLED' },
      {
        changed: { ...row, quantity: { ...row.quantity, unitRef: { ...unitRef, resourceId: otherId } } },
        reason: 'UNIT_NOT_ENROLLED',
      },
    ] as const) {
      let requests = 0;
      const failure = yield* stockFailure({
        fetch: () => {
          requests += 1;
          return Promise.resolve(Response.json({}));
        },
        row: input.changed,
      });
      const problem = yield* Schema.decodeUnknownEffect(SymmyStockInputProblemSchema)(failure);
      const decoded = yield* decodeInternalSyncProblem({
        body: yield* problemBody(SymmyStockInputProblemSchema, problem),
        phase: input.reason === 'LOCATION_NOT_ENROLLED' ? 'stock-unenrolled-location' : 'stock-unenrolled-unit',
        schema: syncNegativeResponseSchemas.stockInput,
        status: problem.status,
      });
      expect(decoded).toMatchObject({
        itemKey: row.itemKey,
        locationKey: input.changed.locationKey,
        reason: input.reason,
        status: 422,
      });
      expect('retryable' in decoded).toBe(false);
      expect(requests).toBe(0);
    }
    let tenantRequests = 0;
    const failure = yield* stockFailure({
      fetch: () => {
        tenantRequests += 1;
        return Promise.resolve(Response.json({}));
      },
      row: { ...row, quantity: { ...row.quantity, unitRef: { ...unitRef, tenantId: otherId } } },
    });
    const problem = yield* Schema.decodeUnknownEffect(SymmyStockSourceUnavailableProblemSchema)(failure);
    const decoded = yield* decodeInternalSyncProblem({
      body: yield* problemBody(SymmyStockSourceUnavailableProblemSchema, problem),
      phase: 'stock-foreign-unit-tenant',
      schema: syncNegativeResponseSchemas.stockSourceUnavailable,
      status: problem.status,
    });
    expect(decoded).toMatchObject({ reason: 'TENANT_SCOPE_MISMATCH', retryable: true, status: 503 });
    expect(tenantRequests).toBe(0);
  }),
);

it.effect(
  'keeps admission ineligibility, cancellation and revoked authority on the exact generic unavailable contract',
  () =>
    Effect.gen(function* admissionRefusalContracts() {
      const details = { detail: 'Test refusal', title: 'Refused', type: 'https://ontos.dev/problems/test-refusal' };
      const refusals = [
        AdmitSymmySyncActionIneligibleProblemSchema.make({ ...details, code: 'symmy_sync_route_denied', status: 422 }),
        AdmitSymmySyncActionUnavailableProblemSchema.make({
          ...details,
          code: 'symmy_sync_unavailable',
          retryable: true,
          status: 503,
        }),
        AdmitSymmySyncActionUnavailableProblemSchema.make({
          ...details,
          code: 'action_transaction_failed',
          retryable: true,
          status: 503,
        }),
      ];
      const replayRoute = yield* Schema.decodeUnknownEffect(SymmyRouteContextResponseSchema)({
        ...route,
        allowedOwnerOperations: [],
        replayIdempotencyDigest: 'b'.repeat(64),
      });
      const replayAdmission: SymmyIngressAdmission = {
        ...admission,
        acquireRouteAssertion: () =>
          Effect.succeed({
            ...assertion,
            route: replayRoute,
          }),
      };
      for (const refusal of refusals) {
        const requests: string[] = [];
        const failure = yield* stockFailure({
          admission: replayAdmission,
          fetch: (url) => {
            requests.push(new Request(url).url);
            return Promise.resolve(
              Response.json(refusal, {
                headers: { 'content-type': 'application/problem+json' },
                status: refusal.status,
              }),
            );
          },
        });
        const decoded = yield* decodeInternalSyncProblem({
          body: failure,
          phase: 'stock-cancelled-replay',
          schema: syncNegativeResponseSchemas.unavailable,
          status: 503,
        });
        expect(Schema.is(SymmyUnavailableProblemSchema)(decoded)).toBe(true);
        expect(decoded).toMatchObject({ retryable: true, status: 503 });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain('/actions/admit-symmy-sync');
      }
      const revoked = GatewayUnavailableProblemSchema.make({ ...details, retryable: true, status: 503 });
      let requests = 0;
      const failure = yield* stockFailure({
        admission: { ...admission, acquireRouteAssertion: () => Effect.fail(revoked) },
        fetch: () => {
          requests += 1;
          return Promise.resolve(Response.json({}));
        },
      });
      expect(
        yield* decodeInternalSyncProblem({
          body: failure,
          phase: 'stock-revoked-writer',
          schema: syncNegativeResponseSchemas.unavailable,
          status: 503,
        }),
      ).toEqual(revoked);
      expect(requests).toBe(0);
    }),
);

it.effect('logs only closed metadata on a mismatch and never accepts or exposes the rejected body', () =>
  Effect.gen(function* safeContractDiagnostics() {
    const entries: unknown[] = [];
    const body = {
      _tag: 'AdmitSymmySyncActionUnavailableProblem',
      code: 'action_transaction_failed',
      detail: 'DO_NOT_LOG',
      payload: { secret: 'DO_NOT_LOG' },
      retryable: true,
      status: 503,
    };
    const result = yield* Effect.exit(
      decodeInternalSyncProblem({
        body,
        phase: 'group-revoked-writer',
        schema: syncNegativeResponseSchemas.unavailable,
        status: 503,
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            if (Array.isArray(message)) {
              const messages: readonly unknown[] = message;
              entries.push(...messages);
            } else {
              entries.push(message);
            }
          }),
        ]),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(entries).toEqual([
      'Internal C14 negative response contract mismatch',
      {
        code: 'action_transaction_failed',
        phase: 'group-revoked-writer',
        retryable: true,
        status: 503,
        tag: 'AdmitSymmySyncActionUnavailableProblem',
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain('DO_NOT_LOG');
    const unknown = yield* Effect.exit(
      decodeInternalSyncProblem({
        body: { _tag: 'DO_NOT_LOG', code: 'DO_NOT_LOG', retryable: 'DO_NOT_LOG' },
        phase: 'stock-cancelled-replay',
        schema: syncNegativeResponseSchemas.unavailable,
        status: 503,
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            entries.push(message);
          }),
        ]),
      ),
    );
    expect(Exit.isFailure(unknown)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('DO_NOT_LOG');
  }),
);
