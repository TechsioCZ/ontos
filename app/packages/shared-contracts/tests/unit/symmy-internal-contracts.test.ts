import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  decodeSymmyItemOutcome,
  pinSymmyOwnerEffect,
  qualifySymmySourceRecord,
  selectSymmyRoute,
  summarizeSymmyItemOutcome,
  SYMMY_REST_PREFIX,
  SYMMY_ROUTES,
  SymmyOwnerEffectIntentSchema,
  SymmyOwnerEffectRefSchema,
  SymmyRouteContextSchema,
  SymmyRouteSelectionSchema,
  SymmySourceRecordKeySchema,
} from '../../src/symmy/index.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const itemId = '20000000-0000-4000-8000-000000000001';
const effectId = '30000000-0000-4000-8000-000000000001';
const otherEffectId = '30000000-0000-4000-8000-000000000002';

// INTERNAL_CONTRACT fixtures only. These IDs and operation versions make no claim about Symmy or owner APIs.
const operation = {
  entrypointKey: 'test.catalog.fixture-operation',
  moduleId: 'test.catalog',
  schemaVersion: 'fixture-contract-v1',
};
const registeredRoute = {
  allowedOwnerOperations: [operation],
  factFamily: 'fixture-catalog',
  issuerId: 'fixture-erp-a',
  mappingVersion: 'fixture-mapping-v1',
  principalId: '40000000-0000-4000-8000-000000000001',
  route: { integrationRouteId: 'fixture-catalog-route', tenantId },
  routeRevision: 'fixture-route-v1',
  sourceNamespace: 'fixture-source',
};
const sourceKey = { entityKind: 'fixture-product', sourceRecordId: 'same-literal-source-id' };

const decodeRoute = Schema.decodeUnknownSync(SymmyRouteContextSchema, { onExcessProperty: 'error' });
const decodeSelection = Schema.decodeUnknownSync(SymmyRouteSelectionSchema, { onExcessProperty: 'error' });
const decodeSourceKey = Schema.decodeUnknownSync(SymmySourceRecordKeySchema, { onExcessProperty: 'error' });
const decodeEffect = Schema.decodeUnknownSync(SymmyOwnerEffectRefSchema, { onExcessProperty: 'error' });

it('lists exactly the approved internal methods, paths, response modes and path selectors', () => {
  expect(SYMMY_REST_PREFIX).toBe('/api/symmy/v1');
  const routes = Object.values(SYMMY_ROUTES).map((route) => [
    route.method,
    route.path,
    route.mode,
    route.successStatus,
    'selector' in route ? route.selector : undefined,
  ]);
  const expected = [
    ['GET', '/api/symmy/v1/admin/customers', 'business_read', 200, undefined],
    ['GET', '/api/symmy/v1/admin/products', 'business_read', 200, undefined],
    ['GET', '/api/symmy/v1/admin/regions', 'business_read', 200, undefined],
    ['GET', '/api/symmy/v1/jobs/{id}', 'job_read', 200, 'id'],
    ['GET', '/api/symmy/v1/price-lists', 'business_read', 200, undefined],
    ['POST', '/api/symmy/v1/customer-groups/batch', 'item_results', 200, undefined],
    ['POST', '/api/symmy/v1/customer-groups/{code}/customers/batch', 'durable_job', 202, 'code'],
    ['POST', '/api/symmy/v1/customers/batch', 'durable_job', 202, undefined],
    ['POST', '/api/symmy/v1/inventory/stock/batch', 'item_results', 200, undefined],
    ['POST', '/api/symmy/v1/price-lists/batch-upsert', 'durable_job', 202, undefined],
    ['POST', '/api/symmy/v1/price-lists/{code}/prices/batch', 'durable_job', 202, 'code'],
    ['POST', '/api/symmy/v1/products/batch', 'durable_job', 202, undefined],
  ];
  expect(routes).toHaveLength(expected.length);
  for (const route of expected) {
    expect(routes).toContainEqual(route);
  }
});

it('uses only admitted scope to qualify the same source ID across issuers, routes, namespaces and tenants', () => {
  const key = decodeSourceKey(sourceKey);
  const original = qualifySymmySourceRecord(decodeRoute(registeredRoute), key);
  const variations = [
    { ...registeredRoute, issuerId: 'fixture-erp-b' },
    { ...registeredRoute, route: { ...registeredRoute.route, integrationRouteId: 'fixture-other-route' } },
    { ...registeredRoute, route: { ...registeredRoute.route, tenantId: otherTenantId } },
    { ...registeredRoute, sourceNamespace: 'fixture-other-namespace' },
  ];

  for (const variation of variations) {
    const qualified = qualifySymmySourceRecord(decodeRoute(variation), key);
    expect(qualified.sourceRecordId).toBe(original.sourceRecordId);
    expect(qualified).not.toEqual(original);
  }

  expect(() => decodeSourceKey({ ...sourceKey, issuerId: 'payload-claim' })).toThrow();
  expect(() => decodeRoute({ ...registeredRoute, allowedOwnerOperations: [] })).toThrow();
  expect(() => decodeRoute({ ...registeredRoute, issuerId: ' ' })).toThrow();
});

it('preserves separate occurrence and effect identities with the original owner target and versions', () => {
  const originalTarget = {
    moduleId: operation.moduleId,
    resourceId: 'fixture-canonical-resource-id',
    resourceType: 'test.catalog.fixture-resource',
    tenantId,
  };
  const record = qualifySymmySourceRecord(decodeRoute(registeredRoute), decodeSourceKey(sourceKey));
  const intent = {
    effectId,
    mappingVersion: registeredRoute.mappingVersion,
    occurrence: { occurrenceId: 'fixture-occurrence-v1', record },
    operation,
    originalTarget,
    routeRevision: registeredRoute.routeRevision,
  };
  const pinned = decodeEffect(intent);
  const newerRoute = decodeRoute({
    ...registeredRoute,
    mappingVersion: 'fixture-mapping-v2',
    routeRevision: 'fixture-route-v2',
  });
  expect(qualifySymmySourceRecord(newerRoute, decodeSourceKey(sourceKey))).toEqual(record);
  expect(Schema.encodeSync(SymmyOwnerEffectRefSchema)(pinned)).toEqual(intent);
  expect(pinned.routeRevision).not.toBe(newerRoute.routeRevision);
  expect(pinned.mappingVersion).not.toBe(newerRoute.mappingVersion);
  expect(decodeEffect({ ...intent, effectId: otherEffectId }).occurrence).toEqual(pinned.occurrence);

  expect(() => decodeEffect({ ...intent, originalTarget: { ...originalTarget, tenantId: otherTenantId } })).toThrow();
  expect(() =>
    decodeEffect({ ...intent, originalTarget: { ...originalTarget, moduleId: 'test.other-owner' } }),
  ).toThrow();
  expect(() => decodeEffect({ ...intent, effectId: sourceKey.sourceRecordId })).toThrow();
  expect(() => decodeEffect({ ...intent, occurrence: { record } })).toThrow();
});

it.effect('pins only an exact operation and target from the admitted route', () =>
  Effect.gen(function* pinAdmittedEffect() {
    const registered = decodeRoute(registeredRoute);
    const verifiedScope = { principalId: registered.principalId, tenantId: registered.route.tenantId };
    const selection = decodeSelection({
      integrationRouteId: registered.route.integrationRouteId,
      mappingVersion: registered.mappingVersion,
      routeRevision: registered.routeRevision,
    });
    const route = yield* selectSymmyRoute({
      registrations: [
        {
          context: decodeRoute({
            ...registeredRoute,
            issuerId: 'fixture-foreign-issuer',
            route: { ...registeredRoute.route, tenantId: otherTenantId },
          }),
          state: 'active',
        },
        { context: registered, state: 'active' },
      ],
      selection,
      verifiedScope,
    });
    const originalTarget = {
      moduleId: operation.moduleId,
      resourceId: 'fixture-canonical-resource-id',
      resourceType: 'test.catalog.fixture-resource',
      tenantId,
    };
    const intent = Schema.decodeUnknownSync(SymmyOwnerEffectIntentSchema)({
      effectId,
      occurrenceId: 'fixture-occurrence-v1',
      operation,
      originalTarget,
      record: sourceKey,
    });
    const pinned = yield* pinSymmyOwnerEffect(route, intent);
    expect(pinned).toMatchObject({
      effectId,
      mappingVersion: registeredRoute.mappingVersion,
      occurrence: {
        occurrenceId: 'fixture-occurrence-v1',
        record: { ...sourceKey, issuerId: registeredRoute.issuerId, route: registeredRoute.route },
      },
      operation,
      originalTarget: intent.originalTarget,
      routeRevision: registeredRoute.routeRevision,
    });

    const changedRoute = decodeRoute({
      ...registeredRoute,
      mappingVersion: 'fixture-mapping-v2',
      routeRevision: 'fixture-route-v2',
    });
    const alternateRoute = decodeRoute({
      ...registeredRoute,
      route: { ...registeredRoute.route, integrationRouteId: 'fixture-unrequested-route' },
    });
    const registrations = [
      { context: changedRoute, state: 'active' },
      { context: alternateRoute, state: 'active' },
    ] as const;
    for (const staleSelection of [
      selection,
      decodeSelection({ ...selection, mappingVersion: 'fixture-mapping-v2' }),
      decodeSelection({ ...selection, routeRevision: 'fixture-route-v2' }),
    ]) {
      expect(
        yield* Effect.flip(selectSymmyRoute({ registrations, selection: staleSelection, verifiedScope })),
      ).toMatchObject({ reason: 'route_version_mismatch' });
    }
    const currentRoute = yield* selectSymmyRoute({
      registrations,
      selection: decodeSelection({
        ...selection,
        mappingVersion: 'fixture-mapping-v2',
        routeRevision: 'fixture-route-v2',
      }),
      verifiedScope,
    });
    const newTarget = { ...originalTarget, resourceId: 'fixture-new-resource-id' };
    const newIntent = Schema.decodeUnknownSync(SymmyOwnerEffectIntentSchema)({
      ...intent,
      effectId: otherEffectId,
      originalTarget: newTarget,
    });
    expect(yield* pinSymmyOwnerEffect(currentRoute, newIntent)).toMatchObject({
      effectId: otherEffectId,
      mappingVersion: 'fixture-mapping-v2',
      originalTarget: newTarget,
      routeRevision: 'fixture-route-v2',
    });
    expect(decodeEffect(Schema.encodeSync(SymmyOwnerEffectRefSchema)(pinned))).toMatchObject({
      effectId,
      mappingVersion: 'fixture-mapping-v1',
      originalTarget,
      routeRevision: 'fixture-route-v1',
    });

    for (const wrongOperation of [
      { ...operation, schemaVersion: 'unregistered-version' },
      { ...operation, entrypointKey: 'test.catalog.unregistered-operation' },
      { ...operation, moduleId: 'test.other-owner' },
    ]) {
      expect(yield* Effect.flip(pinSymmyOwnerEffect(route, { ...intent, operation: wrongOperation }))).toMatchObject({
        reason: 'operation_not_allowed',
      });
    }
    const foreignTarget = Schema.decodeUnknownSync(SymmyOwnerEffectIntentSchema)({
      ...intent,
      originalTarget: { ...intent.originalTarget, tenantId: otherTenantId },
    });
    expect(yield* Effect.flip(pinSymmyOwnerEffect(route, foreignTarget))).toMatchObject({
      reason: 'target_scope_mismatch',
    });
  }),
);

it.effect('rejects missing, ambiguous, foreign-scope and revoked route registrations without a fallback', () =>
  Effect.gen(function* rejectUnverifiedRoute() {
    const sellingLegalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('50000000-0000-4000-8000-000000000001');
    const context = decodeRoute({ ...registeredRoute, sellingLegalEntityId });
    const foreignPrincipal = decodeRoute({
      ...registeredRoute,
      principalId: '40000000-0000-4000-8000-000000000002',
      sellingLegalEntityId,
    });
    const foreignTenant = decodeRoute({
      ...registeredRoute,
      route: { ...registeredRoute.route, tenantId: otherTenantId },
    });
    const fallback = decodeRoute({
      ...registeredRoute,
      route: { ...registeredRoute.route, integrationRouteId: 'fixture-unrequested-route' },
      sellingLegalEntityId,
    });
    const selection = decodeSelection({
      integrationRouteId: context.route.integrationRouteId,
      mappingVersion: context.mappingVersion,
      routeRevision: context.routeRevision,
    });
    const verifiedScope = {
      principalId: context.principalId,
      sellingLegalEntityId,
      tenantId: context.route.tenantId,
    };
    const active = { context, state: 'active' } as const;
    const unrequested = { context: fallback, state: 'active' } as const;
    const unrelatedTenant = { context: foreignTenant, state: 'active' } as const;
    const otherPrincipal = { context: foreignPrincipal, state: 'active' } as const;

    expect(yield* selectSymmyRoute({ registrations: [unrelatedTenant, active], selection, verifiedScope })).toEqual(
      context,
    );
    for (const [registrations, reason] of [
      [[unrelatedTenant, unrequested], 'route_missing'],
      [[otherPrincipal, active, unrelatedTenant], 'route_ambiguous'],
      [[otherPrincipal, unrequested], 'scope_mismatch'],
      [[{ context, state: 'revoked' }, unrequested], 'route_revoked'],
    ] as const) {
      expect(yield* Effect.flip(selectSymmyRoute({ registrations, selection, verifiedScope }))).toMatchObject({
        reason,
      });
    }

    const noLegalEntity = { principalId: verifiedScope.principalId, tenantId: verifiedScope.tenantId };
    expect(
      yield* Effect.flip(selectSymmyRoute({ registrations: [active], selection, verifiedScope: noLegalEntity })),
    ).toMatchObject({ reason: 'scope_mismatch' });
    expect(() => decodeSelection({ ...selection, tenantId: otherTenantId })).toThrow();
  }),
);

it.effect('keeps pinned identity values when the caller mutates its input objects', () =>
  Effect.gen(function* isolatePinnedIdentity() {
    const route = decodeRoute(registeredRoute);
    const input = Schema.decodeUnknownSync(SymmyOwnerEffectIntentSchema)({
      effectId,
      occurrenceId: 'fixture-occurrence-v1',
      operation,
      originalTarget: {
        moduleId: operation.moduleId,
        resourceId: 'fixture-canonical-resource-id',
        resourceType: 'test.catalog.fixture-resource',
        tenantId,
      },
      record: sourceKey,
    });
    const routeRef = { ...route.route };
    const intendedOperation = { ...input.operation };
    expect(input.originalTarget).toBeDefined();
    if (input.originalTarget === undefined) {
      return;
    }
    const originalTarget = { ...input.originalTarget };
    const pinned = yield* pinSymmyOwnerEffect(
      { ...route, route: routeRef },
      { ...input, operation: intendedOperation, originalTarget },
    );

    routeRef.integrationRouteId = decodeRoute({
      ...registeredRoute,
      route: { ...registeredRoute.route, integrationRouteId: 'fixture-other-route' },
    }).route.integrationRouteId;
    intendedOperation.entrypointKey = 'test.catalog.other-operation';
    originalTarget.moduleId = 'test.other-owner';

    expect(pinned.occurrence.record.route.integrationRouteId).toBe('fixture-catalog-route');
    expect(pinned.operation.entrypointKey).toBe(operation.entrypointKey);
    expect(pinned.originalTarget?.moduleId).toBe(operation.moduleId);
  }),
);

it.effect('pins the selected route snapshot even if the registration objects change before pinning', () =>
  Effect.gen(function* pinsDetachedRoute() {
    const initial = decodeRoute(registeredRoute);
    const replacement = decodeRoute({
      ...registeredRoute,
      issuerId: 'fixture-erp-b',
      route: { ...registeredRoute.route, integrationRouteId: 'fixture-replacement-route' },
      routeRevision: 'fixture-route-v2',
    });
    const secondOperation = { ...operation, entrypointKey: 'test.catalog.fixture-second-operation' };
    const route = { ...initial.route };
    const secondOperationRef = { ...secondOperation };
    const context = {
      ...initial,
      allowedOwnerOperations: [{ ...operation }, secondOperationRef] as const,
      route,
    };
    const selected = yield* selectSymmyRoute({
      registrations: [{ context, state: 'active' }],
      selection: decodeSelection({
        integrationRouteId: route.integrationRouteId,
        mappingVersion: context.mappingVersion,
        routeRevision: context.routeRevision,
      }),
      verifiedScope: { principalId: initial.principalId, tenantId: route.tenantId },
    });

    context.issuerId = replacement.issuerId;
    context.routeRevision = replacement.routeRevision;
    route.integrationRouteId = replacement.route.integrationRouteId;
    secondOperationRef.entrypointKey = 'test.catalog.fixture-replacement-operation';

    const pinned = yield* pinSymmyOwnerEffect(
      selected,
      Schema.decodeUnknownSync(SymmyOwnerEffectIntentSchema)({
        effectId,
        occurrenceId: 'fixture-occurrence-v1',
        operation: secondOperation,
        record: sourceKey,
      }),
    );
    expect(pinned).toMatchObject({
      occurrence: { record: { issuerId: initial.issuerId, route: initial.route } },
      operation: secondOperation,
      routeRevision: initial.routeRevision,
    });
  }),
);

it.effect('reports accepted siblings alongside unsupported and indeterminate effects as partial', () =>
  Effect.gen(function* partialItemOutcome() {
    const effects = [
      { effectId, owner: 'test.catalog', status: 'accepted_change' },
      { owner: 'test.tax', reason: 'owner_not_activated', status: 'unsupported' },
      { effectId: otherEffectId, owner: 'test.pricing', status: 'indeterminate' },
    ];
    const item = yield* decodeSymmyItemOutcome({ effects, itemId });
    expect(item.effects).toEqual(effects);
    expect(summarizeSymmyItemOutcome(item)).toBe('partial');

    const accepted = yield* decodeSymmyItemOutcome({
      effects: [
        { effectId, owner: 'test.catalog', status: 'accepted_no_change' },
        { effectId: otherEffectId, originalStatus: 'accepted_change', owner: 'test.pricing', status: 'duplicate' },
      ],
      itemId,
    });
    expect(summarizeSymmyItemOutcome(accepted)).toBe('accepted');

    for (const status of ['stale', 'unresolved', 'ambiguous', 'denied', 'conflict', 'unavailable']) {
      const rejected = yield* decodeSymmyItemOutcome({ effects: [{ owner: 'test.catalog', status }], itemId });
      expect(rejected.effects[0].status).toBe(status);
      expect(summarizeSymmyItemOutcome(rejected)).toBe('not_accepted');
    }
  }),
);

it.effect('rejects unsafe outcome fields and preserves the required original effect for recovery', () =>
  Effect.gen(function* rejectsUnsafeOutcome() {
    const accepted = { effectId, owner: 'test.catalog', status: 'accepted_change' };
    const indeterminate = { owner: 'test.catalog', status: 'indeterminate' };
    for (const unsafe of [
      { effects: [], itemId },
      { effects: [accepted], itemId: 'raw-source-id' },
      { effects: [accepted], itemId, sourceRecord: 'protected source data' },
      { effects: [{ ...accepted, ownerDetail: 'private detail' }], itemId },
      { effects: [indeterminate], itemId },
      { effects: [{ ...accepted, status: 'failed' }], itemId },
      { effects: [{ ...accepted, status: 'duplicate' }], itemId },
      { effects: [{ ...accepted, originalStatus: 'indeterminate', status: 'duplicate' }], itemId },
      { effects: [{ ...accepted, originalStatus: 'denied', status: 'duplicate' }], itemId },
      { effects: [{ effectId, owner: 'test.tax', reason: 'owner_not_activated', status: 'unsupported' }], itemId },
    ]) {
      expect(yield* Effect.flip(decodeSymmyItemOutcome(unsafe))).toBeDefined();
    }
  }),
);
