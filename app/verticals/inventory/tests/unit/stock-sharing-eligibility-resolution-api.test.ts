import { ReadPermissionDenied, allowOwnerAuthorizationOverlay, toBusinessPermissionAccessKey } from '@app/core-runtime';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { mapStockSharingEligibilityResolutionDomainError } from '../../api/stock-sharing-eligibility-resolution-read-server.ts';
import {
  StockSharingEligibilityResolutionDomainPolicyProblemSchema,
  StockSharingEligibilityResolutionDomainUnavailableProblemSchema,
  StockSharingEligibilityResolutionRequestSchema,
  StockSharingEligibilityResolutionResponseSchema,
} from '../../shared/apis/stock-sharing-eligibility-resolution.ts';
import {
  StockSharingEligibilityRejected,
  StockSharingEligibilityDecisionSchema,
  StockSharingEligibilitySchema,
} from '../../shared/domain/stock-sharing-eligibility.ts';
import type { StockSharingEligibilityPersistence } from '../../shared/domain/stock-sharing-eligibility.ts';
import { StockSharingEligibilityUnavailable } from '../../shared/domain/stock-sharing-eligibility-unavailable.ts';
import {
  executeStockSharingEligibilityResolution,
  executeStockSharingEligibilityResolutionWithAuthorization,
} from '../../src/api/stock-sharing-eligibility-resolution-client.ts';
import { stockSharingEligibilityResolutionRead } from '../../src/api/stock-sharing-eligibility-resolution.read.ts';
import { makeStockSharingEligibilityEvaluator } from '../../src/services/stock-sharing-eligibility-service.ts';
import {
  getReadHandler,
  getReadPermissionTargetResolver,
} from '../../../../packages/core-runtime/src/reads/definition.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const positionId = '33333333-3333-4333-8333-333333333333';
const configurationId = '44444444-4444-4444-8444-444444444444';
const relationId = '55555555-5555-4555-8555-555555555555';
const observedAt = '2026-09-25T10:00:00.000Z';
const commerceContextEvidenceRef = 'commerce-owner:context:current:1';
const scope = {
  authBindingId: '66666666-6666-4666-8666-666666666666',
  authContextRef: 'better-auth-session:stock-sharing-resolution-test',
  authMethod: 'session' as const,
  correlationId: 'stock-sharing-resolution-test',
  legalEntityId,
  principalId: '77777777-7777-4777-8777-777777777777',
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
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const request = Schema.decodeUnknownSync(StockSharingEligibilityResolutionRequestSchema)({
  commerceContextEvidence: {
    channel: 'B2C',
    commerceMarketRef: {
      moduleId: 'commerce.market-catalog',
      resourceId: 'market-cz',
      resourceType: 'commerce.market-catalog.market',
      tenantId,
    },
    customerConfigurationId: 'customer-configuration-primary',
    evidenceRef: commerceContextEvidenceRef,
    observedAt,
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    status: 'CURRENT_OWNER_VERIFIED',
    storefrontRef: { appId: 'storefront-primary', tenantId },
    tenantId,
  },
  scope: {
    customerConfigurationId: 'customer-configuration-primary',
    ownerConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    positionRef,
  },
});
const decision = Schema.decodeUnknownSync(StockSharingEligibilityDecisionSchema)({
  applicableRelationRefs: [
    {
      moduleId: 'commerce.inventory',
      resourceId: relationId,
      resourceType: 'commerce.inventory.stock-sharing-eligibility',
      tenantId,
    },
  ],
  contextEvidenceRef: commerceContextEvidenceRef,
  outcome: 'ELIGIBLE',
  positionRef,
  rule: 'POSITIVE_CURRENT_RELATION_UNION',
});
const relation = Schema.decodeUnknownSync(StockSharingEligibilitySchema)({
  commerceValidation: {
    evidenceRef: 'commerce-owner:relation-validation:1',
    observedAt,
    verification: 'OWNER_VERIFIED_CURRENT',
  },
  effectivePeriod: { from: observedAt, to: null },
  lifecycle: 'CURRENT',
  ref: decision.applicableRelationRefs[0],
  revision: 1,
  scope: request.scope,
  subject: {
    channel: 'B2C',
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
  },
});
const unusedPersistenceOperation = () => Effect.die('Unused Stock Sharing Eligibility persistence operation');
const evaluationPersistence: StockSharingEligibilityPersistence = {
  findByRef: unusedPersistenceOperation,
  insertCurrent: unusedPersistenceOperation,
  listCurrent: () => Effect.succeed([relation]),
  readHistory: unusedPersistenceOperation,
  saveRevision: unusedPersistenceOperation,
};

it('declares an exact Position-scoped governed Read with typed decision output', () => {
  expect(stockSharingEligibilityResolutionRead.descriptor.permissionTarget).toBe('business_permission');
  expect(stockSharingEligibilityResolutionRead.descriptor.legalEntityScope).toBe('required');
  expect(stockSharingEligibilityResolutionRead.descriptor.evidencePolicy.captureMode).toBe('metadata_only');

  const resolver = getReadPermissionTargetResolver(stockSharingEligibilityResolutionRead);
  expect(Predicate.isFunction(resolver)).toBe(true);
  if (Predicate.isFunction(resolver)) {
    expect(resolver(request, scope)).toEqual({
      businessPermission: {
        permission: 'inventory.resource.read',
        target: {
          kind: 'inventory_resource',
          resource: {
            moduleId: positionRef.moduleId,
            resourceId: positionRef.resourceId,
            resourceType: positionRef.resourceType,
          },
          tenantId,
        },
      },
      kind: 'business_permission',
    });
  }

  expect(Schema.is(StockSharingEligibilityResolutionResponseSchema)({ decision })).toBe(true);
  expect(Predicate.isFunction(executeStockSharingEligibilityResolution)).toBe(true);
  expect(Predicate.isFunction(executeStockSharingEligibilityResolutionWithAuthorization)).toBe(true);
});

it.effect('returns only a proven positive-union decision and records result evidence', () =>
  Effect.gen(function* resolvePositiveUnion() {
    const calls: unknown[] = [];
    const evaluationService = makeStockSharingEligibilityEvaluator(evaluationPersistence);
    const result = yield* getReadHandler(stockSharingEligibilityResolutionRead)(request, {
      readKey: stockSharingEligibilityResolutionRead.descriptor.readKey,
      scope,
      services: {
        evaluate: (input) => {
          calls.push(input);
          return evaluationService.evaluate(input);
        },
      },
    });

    expect(calls).toEqual([{ context: request.commerceContextEvidence, scope: request.scope }]);
    expect(result).toEqual({ evidence: { resultCount: 1 }, result: { decision } });
  }),
);

it.effect('fails closed before evaluation when the trusted seller is not the selected Legal Entity', () =>
  Effect.gen(function* rejectCrossLegalEntityContext() {
    let evaluationCalls = 0;
    const evaluationService = makeStockSharingEligibilityEvaluator(evaluationPersistence);
    const crossLegalEntityRequest = Schema.decodeUnknownSync(StockSharingEligibilityResolutionRequestSchema)({
      ...request,
      commerceContextEvidence: {
        ...request.commerceContextEvidence,
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: '88888888-8888-4888-8888-888888888888',
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      },
    });
    const failure = yield* getReadHandler(stockSharingEligibilityResolutionRead)(crossLegalEntityRequest, {
      readKey: stockSharingEligibilityResolutionRead.descriptor.readKey,
      scope,
      services: {
        evaluate: (input) => {
          evaluationCalls += 1;
          return evaluationService.evaluate(input);
        },
      },
    }).pipe(Effect.flip);

    expect(failure).toMatchObject({ reason: 'POSITION_SCOPE_MISMATCH' });
    expect(evaluationCalls).toBe(0);
  }),
);

it.effect('denies the exact Stock Position before owner services are resolved', () =>
  Effect.gen(function* denyBeforeOwnerResolution() {
    let businessChecks = 0;
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
        resources: ({ resources }) =>
          Effect.succeed(
            resources.map((resource) => ({
              decision: 'allowed' as const,
              key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
            })),
          ),
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
        input: request,
        principal,
        registration: stockSharingEligibilityResolutionRead,
        transport: { correlationId: scope.correlationId },
      })
      .pipe(Effect.flip);

    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    expect(businessChecks).toBe(1);
    expect(stages).toEqual(['input_decoded', 'scope_validated', 'module_state_checked', 'permission_checked']);
  }),
);

it('maps no applicable relation and unverifiable owner evidence to typed semantic non-success', () => {
  for (const reason of ['NO_APPLICABLE_CURRENT_RELATION', 'COMMERCE_CONTEXT_UNVERIFIABLE'] as const) {
    const problem = mapStockSharingEligibilityResolutionDomainError(
      new StockSharingEligibilityRejected({ code: 'stock_sharing_eligibility_rejected', reason }),
    );
    expect(Schema.is(StockSharingEligibilityResolutionDomainPolicyProblemSchema)(problem)).toBe(true);
    expect(problem).toMatchObject({ reasonCode: reason, status: 422 });
  }
});

it('maps persistence or owner-proof unavailability to a sanitized typed retryable failure', () => {
  const privateReason = 'private database endpoint detail';
  const failure = new StockSharingEligibilityUnavailable({
    code: 'stock_sharing_eligibility_unavailable',
    reason: 'Stock Sharing Eligibility persistence or owner validation is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { value: privateReason });
  const problem = mapStockSharingEligibilityResolutionDomainError(failure);

  expect(Schema.is(StockSharingEligibilityResolutionDomainUnavailableProblemSchema)(problem)).toBe(true);
  expect(problem).toMatchObject({
    reasonCode: 'stock_sharing_eligibility_unavailable',
    retryable: true,
    status: 503,
  });
  expect(JSON.stringify(problem)).not.toContain(privateReason);
});
