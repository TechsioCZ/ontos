import { ReadPermissionDenied, allowOwnerAuthorizationOverlay, toBusinessPermissionAccessKey } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Effect, Option, Predicate, Schema } from 'effect';

import {
  InventoryReconciliationEvidenceDomainPolicyProblemSchema,
  InventoryReconciliationEvidenceDomainUnavailableProblemSchema,
  InventoryReconciliationEvidenceQuerySchema,
  InventoryReconciliationEvidenceRequestSchema,
  InventoryReconciliationEvidenceResponseSchema,
} from '../../shared/apis/inventory-reconciliation-evidence.ts';
import { makeInventoryReconciliationEvidenceService } from '../../src/services/inventory-reconciliation-evidence.service.ts';
import { InventoryReconciliationEvidenceRejected } from '../../shared/domain/inventory-reconciliation-evidence-rejected.ts';
import { InventoryReconciliationEvidenceUnavailable } from '../../shared/domain/inventory-reconciliation-evidence-unavailable.ts';
import { inventoryReconciliationEvidenceRead } from '../../src/api/inventory-reconciliation-evidence.read.ts';
import { mapInventoryReconciliationEvidenceDomainError } from '../../api/inventory-reconciliation-evidence-read-server.ts';
import {
  getReadPermissionTargetResolver,
  getReadResourcePermissionTargetResolver,
} from '../../../../packages/core-runtime/src/reads/definition.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const scope = {
  authBindingId: '44444444-4444-4444-8444-444444444444',
  authContextRef: 'better-auth-session:inventory-reconciliation-evidence-test',
  authMethod: 'session' as const,
  correlationId: 'inventory-reconciliation-evidence-test',
  legalEntityId,
  principalId: '55555555-5555-4555-8555-555555555555',
  tenantId,
};
const principal = {
  authBindingId: scope.authBindingId,
  authContextRef: scope.authContextRef,
  authMethod: scope.authMethod,
  legalEntityId,
  principalId: scope.principalId,
  tenantId,
};
const input = Schema.decodeSync(InventoryReconciliationEvidenceRequestSchema)({
  query: {
    _tag: 'BINDING_HISTORY',
    bindingRef: {
      moduleId: 'commerce.inventory',
      resourceId: bindingId,
      resourceType: 'commerce.inventory.catalog-to-stock-binding',
      tenantId,
    },
  },
});

it('defines only the seven explicit owner evidence lookup kinds', () => {
  const lookupKinds = [
    'BINDING_HISTORY',
    'ENDED_CORRELATION',
    'SHARING_HISTORY',
    'CONFIRMATION_HISTORY',
    'PROTECTION_HISTORY',
    'EFFECT_OUTCOME',
    'SOURCE_CONFLICT_DETAIL',
  ] as const;

  const requestContract = JSON.stringify(InventoryReconciliationEvidenceRequestSchema.ast);
  const responseContract = JSON.stringify(InventoryReconciliationEvidenceResponseSchema.ast);
  for (const kind of lookupKinds) {
    expect(requestContract).toContain(kind);
    expect(responseContract).toContain(kind);
  }
  expect(requestContract).not.toContain('sql');
});

it('binds inventory.audit.read to the exact requested owner Resource', () => {
  expect(inventoryReconciliationEvidenceRead.descriptor.permissionTarget).toBe('business_permission');
  expect(inventoryReconciliationEvidenceRead.descriptor.legalEntityScope).toBe('required');
  expect(getReadResourcePermissionTargetResolver(inventoryReconciliationEvidenceRead)).toBeUndefined();

  const resolver = getReadPermissionTargetResolver(inventoryReconciliationEvidenceRead);
  expect(Predicate.isFunction(resolver)).toBe(true);
  if (Predicate.isFunction(resolver)) {
    expect(resolver(input, scope)).toEqual({
      businessPermission: {
        permission: 'inventory.audit.read',
        target: {
          kind: 'inventory_resource',
          resource: {
            moduleId: 'commerce.inventory',
            resourceId: bindingId,
            resourceType: 'commerce.inventory.catalog-to-stock-binding',
            tenantId,
          },
          tenantId,
        },
      },
      kind: 'business_permission',
    });
  }
});

it.effect('denies the exact owner Resource before resolving transaction-scoped evidence services', () =>
  Effect.gen(function* denyBeforeOwnerResolution() {
    let businessChecks = 0;
    let resourceChecks = 0;
    const stages: string[] = [];
    const database = { executor: yield* makeTestDatabase(() => Effect.succeed([])) };
    const runtime = makeReadRuntime(
      database,
      openModuleEntrypointGateway,
      { resolve: () => Effect.succeed(scope) },
      {
        businessPermissions: ({ targets }) => {
          businessChecks += 1;
          return Effect.succeed(
            targets.map((target) => ({ decision: 'denied' as const, key: toBusinessPermissionAccessKey(target) })),
          );
        },
        legalEntities: ({ legalEntityIds }) =>
          Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
        modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
        resources: ({ resources }) => {
          resourceChecks += 1;
          return Effect.succeed(
            resources.map((resource) => ({
              decision: 'allowed' as const,
              key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
            })),
          );
        },
        tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
      },
      {
        onStage: (stage) => {
          stages.push(stage);
        },
        ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      },
    );

    const failure = yield* runtime
      .runRead({
        input,
        principal,
        registration: inventoryReconciliationEvidenceRead,
        transport: { correlationId: scope.correlationId },
      })
      .pipe(Effect.flip);

    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    expect(businessChecks).toBe(1);
    expect(resourceChecks).toBe(0);
    expect(stages).toEqual(['input_decoded', 'scope_validated', 'module_state_checked', 'permission_checked']);
  }),
);

it.effect('dispatches only the seven bounded owner evidence lookups and preserves missing as not found', () =>
  Effect.gen(function* dispatchExactLookups() {
    const calls: string[] = [];
    const missing = (kind: string) => {
      calls.push(kind);
      return Effect.succeedNone;
    };
    const missingHistory = (kind: string) => {
      calls.push(kind);
      return Effect.succeed([]);
    };
    const service = makeInventoryReconciliationEvidenceService({
      bindings: { readHistory: () => missingHistory('BINDING_HISTORY') },
      confirmations: { readHistory: () => missingHistory('CONFIRMATION_HISTORY') },
      conflicts: { findLatest: () => missing('SOURCE_CONFLICT_DETAIL') },
      correlations: { findByRef: () => missing('ENDED_CORRELATION') },
      effects: { read: () => missing('EFFECT_OUTCOME') },
      protections: { readHistory: () => missingHistory('PROTECTION_HISTORY') },
      sharing: { readHistory: () => missingHistory('SHARING_HISTORY') },
    });
    const resourceId = '66666666-6666-4666-8666-666666666666';
    const requests = Schema.decodeSync(Schema.Array(InventoryReconciliationEvidenceQuerySchema))([
      {
        _tag: 'BINDING_HISTORY',
        bindingRef: {
          moduleId: 'commerce.inventory',
          resourceId,
          resourceType: 'commerce.inventory.catalog-to-stock-binding',
          tenantId,
        },
      },
      {
        _tag: 'ENDED_CORRELATION',
        correlationRef: {
          moduleId: 'commerce.inventory',
          resourceId,
          resourceType: 'commerce.inventory.external-stock-correlation',
          tenantId,
        },
      },
      {
        _tag: 'SHARING_HISTORY',
        relationRef: {
          moduleId: 'commerce.inventory',
          resourceId,
          resourceType: 'commerce.inventory.stock-sharing-eligibility',
          tenantId,
        },
      },
      {
        _tag: 'CONFIRMATION_HISTORY',
        confirmationRef: {
          moduleId: 'commerce.inventory',
          resourceId,
          resourceType: 'commerce.inventory.reservation-confirmation',
          tenantId,
        },
      },
      {
        _tag: 'PROTECTION_HISTORY',
        protectionRef: {
          moduleId: 'commerce.inventory',
          resourceId,
          resourceType: 'commerce.inventory.commitment-protection',
          tenantId,
        },
      },
      {
        _tag: 'EFFECT_OUTCOME',
        effectId: 'reservation-effect-id',
        ownerRef: {
          moduleId: 'commerce.inventory',
          resourceId,
          resourceType: 'commerce.inventory.inventory-reservation',
          tenantId,
        },
      },
      {
        _tag: 'SOURCE_CONFLICT_DETAIL',
        conflictRef: {
          moduleId: 'commerce.inventory',
          resourceId,
          resourceType: 'commerce.inventory.inventory-source-conflict',
          tenantId,
        },
      },
    ]);

    for (const request of requests) {
      const result = yield* service.read(request, { legalEntityId, tenantId });
      expect(Option.isNone(result)).toBe(true);
    }
    expect(calls).toEqual([
      'BINDING_HISTORY',
      'ENDED_CORRELATION',
      'SHARING_HISTORY',
      'CONFIRMATION_HISTORY',
      'PROTECTION_HISTORY',
      'EFFECT_OUTCOME',
      'SOURCE_CONFLICT_DETAIL',
    ]);
  }),
);

it('maps semantic evidence rejection to typed 422 and owner unavailability to sanitized typed 503', () => {
  const rejected = mapInventoryReconciliationEvidenceDomainError(
    new InventoryReconciliationEvidenceRejected({
      code: 'inventory_reconciliation_evidence_rejected',
      reason: 'CORRELATION_NOT_ENDED',
    }),
  );
  expect(Schema.is(InventoryReconciliationEvidenceDomainPolicyProblemSchema)(rejected)).toBe(true);
  expect(rejected).toMatchObject({ reasonCode: 'CORRELATION_NOT_ENDED', status: 422 });

  const privateReason = 'private inventory database connection detail';
  const unavailable = mapInventoryReconciliationEvidenceDomainError(
    new InventoryReconciliationEvidenceUnavailable({
      code: 'inventory_reconciliation_evidence_unavailable',
      reason: privateReason,
      retryable: true,
    }),
  );
  expect(Schema.is(InventoryReconciliationEvidenceDomainUnavailableProblemSchema)(unavailable)).toBe(true);
  expect(unavailable).toMatchObject({
    reasonCode: 'inventory_reconciliation_evidence_unavailable',
    retryable: true,
    status: 503,
  });
  expect(JSON.stringify(unavailable)).not.toContain(privateReason);
});
