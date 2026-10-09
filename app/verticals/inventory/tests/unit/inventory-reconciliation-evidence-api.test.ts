import { ReadPermissionDenied, allowOwnerAuthorizationOverlay, toBusinessPermissionAccessKey } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Effect, Match, Option, Predicate, Schema } from 'effect';

import {
  InventoryReconciliationEvidenceDomainPolicyProblemSchema,
  InventoryReconciliationEvidenceDomainUnavailableProblemSchema,
  InventoryReconciliationEvidenceQuerySchema,
  InventoryReconciliationEvidenceRequestSchema,
  InventoryReconciliationEvidenceResponseSchema,
} from '../../shared/apis/inventory-reconciliation-evidence.ts';
import { ExternalStockCorrelationSchema } from '../../shared/domain/external-stock-correlation.ts';
import { inventoryPrivacyOwnerScopeParts } from '../../shared/inventory-privacy-owner-contract.ts';
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

it('defines the existing owner evidence lookups plus repository-backed privacy owner coverage', () => {
  const lookupKinds = [
    'BINDING_HISTORY',
    'ENDED_CORRELATION',
    'SHARING_HISTORY',
    'CONFIRMATION_HISTORY',
    'PROTECTION_HISTORY',
    'EFFECT_OUTCOME',
    'SOURCE_CONFLICT_DETAIL',
    'PRIVACY_OWNER_COVERAGE',
  ] as const;

  const requestContract = JSON.stringify(InventoryReconciliationEvidenceRequestSchema.ast);
  const responseContract = JSON.stringify(InventoryReconciliationEvidenceResponseSchema.ast);
  for (const kind of lookupKinds) {
    expect(requestContract).toContain(kind);
    expect(responseContract).toContain(kind);
  }
  expect(requestContract).not.toContain('observations');
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
      obligations: { read: () => missing('RESERVATION_OBLIGATION') },
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

it.effect(
  'derives privacy coverage from owner repositories and preserves historical evidence when Current is absent',
  () =>
    Effect.gen(function* derivePrivacyCoverageFromOwnerRepositories() {
      const reservationId = '66666666-6666-4666-8666-666666666666';
      const correlationId = '77777777-7777-4777-8777-777777777777';
      const lookupCalls: string[] = [];
      const ownerRef = {
        moduleId: 'commerce.inventory' as const,
        resourceId: reservationId,
        resourceType: 'commerce.inventory.inventory-reservation' as const,
        tenantId,
      };
      const correlationRef = {
        moduleId: 'commerce.inventory' as const,
        resourceId: correlationId,
        resourceType: 'commerce.inventory.external-stock-correlation' as const,
        tenantId,
      };
      const correlation = Schema.decodeUnknownSync(ExternalStockCorrelationSchema)({
        confirmedAt: '2026-09-28T11:00:00.000Z',
        correlationRef,
        effectivePeriod: { from: '2026-09-27T10:00:00.000Z', to: '2026-09-28T10:00:00.000Z' },
        externalKey: {
          customerConfigurationId: 'customer-configuration-primary',
          externalScope: 'warehouse-primary',
          externalValue: 'external-item-858',
          identifierKind: 'ITEM',
          issuer: { backendId: 'erp-primary', backendKind: 'external_business_system' },
          namespace: 'erp-item',
          tenantId,
        },
        lifecycle: 'ENDED',
        ownerEvidenceRef: 'inventory-correlation-evidence:858',
        revision: 2,
        target: {
          _tag: 'STOCK_ITEM',
          ref: {
            moduleId: 'commerce.inventory',
            resourceId: '88888888-8888-4888-8888-888888888888',
            resourceType: 'commerce.inventory.stock-item',
            tenantId,
          },
        },
      });
      const trustedLookups = [
        { _tag: 'RESERVATION_OBLIGATION' as const, lookupRef: 'inventory-obligation:858' },
        {
          _tag: 'EXTERNAL_CORRELATION' as const,
          correlationRef,
          lookupRef: 'inventory-external-correlation:858',
        },
      ];
      const privacyRequest = Schema.decodeSync(InventoryReconciliationEvidenceQuerySchema)({
        _tag: 'PRIVACY_OWNER_COVERAGE',
        ownerRef,
        scope: {
          controllerRef: `legal-entity:${legalEntityId}`,
          dsrControllerObligationRef: 'privacy:dsr-obligation-858',
          ownerCapability: 'commerce.inventory',
          requestedScopePartRefs: inventoryPrivacyOwnerScopeParts.map(
            (scopePart) => `commerce.inventory/privacy-owner-scope/${scopePart}`,
          ),
          requestedScopeRef: 'privacy-owner-scope:inventory/858',
          subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'privacy-subject:858' },
          tenantId,
          trustedLookupRefs: trustedLookups.map(({ lookupRef }) => lookupRef),
        },
        trustedLookups,
      });
      const service = makeInventoryReconciliationEvidenceService({
        bindings: { readHistory: () => Effect.succeed([]) },
        confirmations: { readHistory: () => Effect.succeed([]) },
        conflicts: { findLatest: () => Effect.succeedNone },
        correlations: {
          findByRef: () => {
            lookupCalls.push('EXTERNAL_CORRELATION');
            return Effect.succeedSome(correlation);
          },
        },
        effects: { read: () => Effect.succeedNone },
        obligations: {
          read: () => {
            lookupCalls.push('RESERVATION_OBLIGATION');
            return Effect.succeedNone;
          },
        },
        protections: { readHistory: () => Effect.succeed([]) },
        sharing: { readHistory: () => Effect.succeed([]) },
      });

      const result = yield* service.read(privacyRequest, { legalEntityId, tenantId });

      expect(Option.isSome(result)).toBe(true);
      const privacyResult = Option.isSome(result)
        ? Match.value(result.value).pipe(
            Match.tag('PRIVACY_OWNER_COVERAGE', (value) => value),
            Match.orElse(() => null),
          )
        : null;
      expect(privacyResult).not.toBeNull();
      if (privacyResult !== null) {
        expect(privacyResult.coverage.contentStatus).toBe('FOUND');
        expect(privacyResult.coverage.coverageStatus).toBe('INDETERMINATE');
        expect(
          privacyResult.coverage.coverageParts.find(({ scopeRef }) =>
            scopeRef.endsWith('/CURRENT_RESERVATION_CORRELATIONS'),
          ),
        ).toMatchObject({ coverageStatus: 'COMPLETE', foundContentRefs: [] });
        expect(
          privacyResult.coverage.coverageParts.find(({ scopeRef }) =>
            scopeRef.endsWith('/EXTERNAL_SOURCE_ASSERTION_COVERAGE_AND_CORRELATION_HISTORY'),
          ),
        ).toMatchObject({
          coverageStatus: 'PARTIAL',
          evidenceRefs: ['inventory-correlation-evidence:858'],
          foundContentRefs: ['inventory-external-correlation:858'],
        });
        expect(
          privacyResult.coverage.coverageParts.find(({ scopeRef }) =>
            scopeRef.endsWith('/IMPORT_REPLAY_PROJECTION_AND_BACKUP_RESPONSIBILITIES'),
          ),
        ).toMatchObject({
          coverageStatus: 'INDETERMINATE',
          foundContentRefs: [],
        });
        expect(() =>
          Schema.decodeUnknownSync(InventoryReconciliationEvidenceResponseSchema)(privacyResult),
        ).not.toThrow();
      }
      expect(lookupCalls).toEqual(['RESERVATION_OBLIGATION', 'EXTERNAL_CORRELATION']);
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
