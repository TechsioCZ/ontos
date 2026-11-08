import { inventoryRegistration } from '../../vertical.registration.ts';
import {
  ReadPermissionDenied,
  allowOwnerAuthorizationOverlay,
  defineDatabaseIdentityEnrollment,
} from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import { mapCurrentStockEvidenceForAvailabilityDomainError } from '../../api/current-stock-evidence-for-availability-read-server.ts';
import { CurrentStockEvidenceForAvailabilityDomainPolicyProblemSchema } from '../../shared/apis/current-stock-evidence-for-availability-domain-policy-problem.ts';
import { CurrentStockEvidenceForAvailabilityDomainUnavailableProblemSchema } from '../../shared/apis/current-stock-evidence-for-availability-domain-unavailable-problem.ts';
import { CurrentStockEvidenceForAvailabilityRequestSchema } from '../../shared/apis/current-stock-evidence-for-availability.ts';
import {
  CurrentStockEvidenceForAvailabilityRejected,
  CurrentStockEvidenceForAvailabilityUnavailable,
} from '../../shared/domain/current-stock-evidence-for-availability.ts';
import { inventoryResourceReadPermission } from '../../shared/permissions/inventory-resource-read.ts';
import {
  executeCurrentStockEvidenceForAvailability as exportedExecuteCurrentStockEvidenceForAvailability,
  executeCurrentStockEvidenceForAvailabilityWithAuthorization as exportedExecuteCurrentStockEvidenceForAvailabilityWithAuthorization,
} from '../../src/api/inventory-client.ts';
import {
  executeCurrentStockEvidenceForAvailability,
  executeCurrentStockEvidenceForAvailabilityWithAuthorization,
} from '../../src/api/current-stock-evidence-for-availability-client.ts';
import { currentStockEvidenceForAvailabilityRead } from '../../src/api/current-stock-evidence-for-availability.read.ts';
import {
  getReadPermissionTargetResolver,
  getReadResourcePermissionTargetResolver,
} from '../../../../packages/core-runtime/src/reads/definition.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { makeTestBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const positionId = '33333333-3333-4333-8333-333333333333';
const scope = {
  authBindingId: '44444444-4444-4444-8444-444444444444',
  authContextRef: 'better-auth-session:current-stock-evidence-api-test',
  authMethod: 'session' as const,
  correlationId: 'current-stock-evidence-api-test',
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
const input = Schema.decodeSync(CurrentStockEvidenceForAvailabilityRequestSchema)({
  positionRef: {
    moduleId: 'commerce.inventory',
    resourceId: positionId,
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
});

it('binds the Read and public client to the exact Stock Position contract', () => {
  // The one gate decides the read's own scope-wide capability (O62): the read declares it and carries
  // no legacy permission target or positional resolver any more.
  expect(currentStockEvidenceForAvailabilityRead.descriptor).toMatchObject({
    accessDeclaration: {
      key: 'commerce.inventory.stock-position.read-availability-evidence',
      kind: 'read',
      selectors: [],
    },
  });
  expect(Object.keys(currentStockEvidenceForAvailabilityRead.descriptor)).not.toContain('permissionTarget');
  expect(inventoryResourceReadPermission.protectedEntrypoints).toEqual([
    'commerce.inventory.api.catalog-to-stock-binding-resolution',
    'commerce.inventory.api.commitment-protection-verification',
    'commerce.inventory.api.current-stock-evidence-for-availability',
    'commerce.inventory.api.inventory-effect-outcome',
    'commerce.inventory.api.inventory-reservation-detail',
    'commerce.inventory.api.reservation-confirmation-verification',
    'commerce.inventory.api.stock-sharing-eligibility-resolution',
  ]);
  expect(getReadPermissionTargetResolver(currentStockEvidenceForAvailabilityRead)).toBeUndefined();
  expect(getReadResourcePermissionTargetResolver(currentStockEvidenceForAvailabilityRead)).toBeUndefined();

  expect(exportedExecuteCurrentStockEvidenceForAvailability).toBe(executeCurrentStockEvidenceForAvailability);
  expect(exportedExecuteCurrentStockEvidenceForAvailabilityWithAuthorization).toBe(
    executeCurrentStockEvidenceForAvailabilityWithAuthorization,
  );
});

it.effect('denies the exact Stock Position before owner services are resolved', () =>
  Effect.gen(function* denyBeforeOwnerResolution() {
    const stages: string[] = [];
    const gate = makeTestBoundAccessGate();
    const database = {
      executor: yield* makeTestDatabase((text) =>
        Effect.succeed(
          text.includes('current_setting')
            ? [{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }]
            : [],
        ),
      ),
    };
    const runtime = makeReadRuntime(
      database,
      openModuleEntrypointGateway,
      { resolve: () => Effect.succeed(scope) },
      {
        // The gate is the only authority: the retired target checks are never consulted (O62).
        legalEntities: ({ legalEntityIds }) =>
          Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
        modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
        ownerPermissions: () => Effect.die('The gate decides; no legacy owner target is checked'),
        resources: () => Effect.die('The gate decides; no legacy resource target is checked'),
        tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
      },
      {
        accessDecision: gate.bound,
        databaseIdentities: defineDatabaseIdentityEnrollment([]),
        onStage: (stage) => {
          stages.push(stage);
        },

        ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
        ownerRegistration: inventoryRegistration,
      },
    );

    const failure = yield* runtime
      .runRead({
        input,
        principal,
        registration: currentStockEvidenceForAvailabilityRead,
        transport: { correlationId: scope.correlationId },
      })
      .pipe(Effect.flip);

    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    // The one gate asked this read's own declaration, in the trusted scope (CUTOVER-PLAN §3.2).
    expect(gate.accessDecision.askedDecisions).toHaveLength(1);
    expect(gate.accessDecision.askedDecisions[0]?.carrier.accessDeclaration?.key).toBe(
      'commerce.inventory.stock-position.read-availability-evidence',
    );
    expect(gate.accessDecision.askedDecisions[0]?.scope.legalEntityId).toBe(legalEntityId);
    expect(stages).toEqual(['input_decoded', 'scope_validated', 'module_state_checked', 'permission_checked']);
  }),
);

it('maps semantic rejection to the declared typed 422 Problem', () => {
  const problem = mapCurrentStockEvidenceForAvailabilityDomainError(
    new CurrentStockEvidenceForAvailabilityRejected({
      code: 'current_stock_evidence_for_availability_rejected',
      reason: 'BINDING_NOT_FOUND',
    }),
  );

  expect(Schema.is(CurrentStockEvidenceForAvailabilityDomainPolicyProblemSchema)(problem)).toBe(true);
  expect(problem).toMatchObject({ reasonCode: 'BINDING_NOT_FOUND', status: 422 });
});

it('maps owner unavailability to the declared sanitized typed 503 Problem', () => {
  const privateReason = 'private inventory database connection detail';
  const problem = mapCurrentStockEvidenceForAvailabilityDomainError(
    new CurrentStockEvidenceForAvailabilityUnavailable({
      code: 'current_stock_evidence_for_availability_unavailable',
      reason: privateReason,
      retryable: true,
    }),
  );

  expect(Schema.is(CurrentStockEvidenceForAvailabilityDomainUnavailableProblemSchema)(problem)).toBe(true);
  expect(problem).toMatchObject({
    reasonCode: 'current_stock_evidence_for_availability_unavailable',
    retryable: true,
    status: 503,
  });
  expect(JSON.stringify(problem)).not.toContain(privateReason);
});
