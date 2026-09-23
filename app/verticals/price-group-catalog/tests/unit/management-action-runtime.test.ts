import { Struct, DateTime, Effect, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import { TestClock } from 'effect/testing';

import {
  ActionCommitIndeterminate,
  TrustedPrincipalContextSchema,
} from '../../../../packages/core-runtime/src/index.ts';
import { defineAction, getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import type {
  ActionInvocationRecord,
  ActionRepositoryService,
  FlushActionSuccessInput,
} from '../../../../packages/core-runtime/src/actions/repository.ts';
import { ActionTransactionError } from '../../../../packages/core-runtime/src/actions/errors.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/permissions/owner-authorization-overlay.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { toBusinessPermissionAccessKey } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import type { ModuleEntrypointDescriptor } from '../../../../packages/core-runtime/src/modules/module-entrypoint.ts';
import {
  checkModuleEntrypoint,
  makeModuleStateSnapshot,
} from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { makeOperationalScopeResolver } from '../../../../packages/core-runtime/src/operations/context.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { CreatePriceGroupDefinitionRevisionPayload } from '../../shared/actions/create-price-group-definition-revision.ts';
import type { CreatePriceGroupPayload } from '../../shared/actions/create-price-group.ts';
import type { RetirePriceGroupPayload } from '../../shared/actions/retire-price-group.ts';
import {
  PriceGroupExpectedCurrentConflict,
  PriceGroupPersistenceUnavailable,
} from '../../shared/domain/price-group-errors.ts';
import type { PriceGroupDefinitionRevision } from '../../shared/domain/price-group.ts';
import { createPriceGroupDefinitionRevisionAction } from '../../src/actions/create-price-group-definition-revision.action.ts';
import { createPriceGroupAction } from '../../src/actions/create-price-group.action.ts';
import { retirePriceGroupAction } from '../../src/actions/retire-price-group.action.ts';
import type { PriceGroupCatalogPersistence } from '../../src/persistence/price-group-catalog-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '77777777-7777-4777-8777-777777777777';
const principalId = '22222222-2222-4222-8222-222222222222';
const priceGroupId = '33333333-3333-4333-8333-333333333333';
const definitionRevisionId = '44444444-4444-4444-8444-444444444444';
const invocationId = '55555555-5555-4555-8555-555555555555';
const fingerprint = 'a'.repeat(64);

const legalPrincipal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'better-auth-session:price-group-runtime',
  authMethod: 'session',
  legalEntityId: '88888888-8888-4888-8888-888888888888',
  principalId,
  tenantId,
});
const tenantPrincipal = Struct.omit(legalPrincipal, ['legalEntityId']);

const createPayload = {
  businessCode: 'DEALER',
  classificationPurpose: 'Classifies approved resellers for the dealer pricing path.',
  compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment', version: 1 }],
  description: 'Dealer classification for approved resellers.',
  displayName: 'Dealer',
  effectiveFrom: '2026-10-01T00:00:00.000Z',
  effectiveTo: null,
  expectedCatalogRevision: 0,
  meaningFingerprint: fingerprint,
  reason: 'Create the approved dealer classification.',
} satisfies CreatePriceGroupPayload;

const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: priceGroupId,
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const expectedCurrent = {
  catalogRevision: 1,
  definitionRevisionId,
  definitionRevisionNumber: 1,
  meaningFingerprint: fingerprint,
  priceGroupRef,
};
const revisionPayload = {
  classificationPurpose: createPayload.classificationPurpose,
  compatibilityContracts: createPayload.compatibilityContracts,
  description: 'Clarified dealer classification for approved resellers.',
  displayName: createPayload.displayName,
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  effectiveTo: null,
  expectedCurrent,
  meaningFingerprint: fingerprint,
  reason: 'Clarify the classification without changing its meaning.',
  sameMeaningAttested: true,
} satisfies CreatePriceGroupDefinitionRevisionPayload;
const retirementPayload = {
  effectiveAt: '2026-12-01T00:00:00.000Z',
  expectedCurrent,
  reason: 'Retire the dealer classification from future use.',
} satisfies RetirePriceGroupPayload;

const definition: PriceGroupDefinitionRevision = {
  acceptedCatalogRevision: 1,
  classificationPurpose: createPayload.classificationPurpose,
  compatibilityContracts: createPayload.compatibilityContracts,
  created: {
    actionInvocationId: invocationId,
    actorPrincipalId: principalId,
    reason: createPayload.reason,
    trustedAt: '2026-09-23T12:00:00.000Z',
  },
  definitionRevisionId,
  description: createPayload.description,
  displayName: createPayload.displayName,
  effectivePeriod: { effectiveFrom: createPayload.effectiveFrom, effectiveTo: null },
  meaningFingerprint: fingerprint,
  previousDefinitionRevisionId: null,
  priceGroupRef,
  revisionNumber: 1,
};
const createResult = {
  definition,
  outcome: 'RECONCILIATION_REQUIRED' as const,
  reconciliation: {
    mutationId: '66666666-6666-4666-8666-666666666666',
    operation: 'touch_containment' as const,
    staged: true as const,
  },
};

const activeScope = {
  bindingAuthenticationNamespaceId: null,
  bindingPrincipalId: principalId,
  bindingRevokedAt: null,
  bindingStatus: 'active' as const,
  bindingTenantId: tenantId,
  legalEntityStatus: 'active' as const,
  legalEntityTenantId: tenantId,
  principalStatus: 'active' as const,
  principalTenantId: tenantId,
  tenantStatus: 'active' as const,
};

const DecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
type Decision = typeof DecisionSchema.Type;

interface HarnessOptions {
  readonly businessDecision?: Decision;
  readonly commitIndeterminate?: boolean;
  readonly createFailure?: 'expected-current' | 'unavailable';
  readonly flushFailure?: boolean;
}

const makeHarness = Effect.fn(function* makeHarness(options: HarnessOptions = {}) {
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-11-30T00:00:00.000Z')));
  const flushAttempts: FlushActionSuccessInput[] = [];
  const successfulFlushes: FlushActionSuccessInput[] = [];
  const businessChecks: unknown[] = [];
  let createInvocationCount = 0;
  let handlerResolutionCount = 0;
  let serviceResolutionCount = 0;
  let rollbackCount = 0;
  let commitCount = 0;
  let currentInvocation: ActionInvocationRecord = {
    actionInvocationId: invocationId,
    completedAt: null,
    requestHash: '',
    status: 'received',
  };

  const repository: ActionRepositoryService = {
    createOrResolveInvocation: (_executor, input) => {
      createInvocationCount += 1;
      if (currentInvocation.requestHash.length === 0) {
        currentInvocation = { ...currentInvocation, requestHash: input.requestHash };
      }
      return Effect.succeed(currentInvocation);
    },
    finalizePolicyDenial: () => Effect.void,
    flushSuccess: (_transaction, input) => {
      flushAttempts.push(input);
      if (options.flushFailure === true) {
        return Effect.fail(
          new ActionTransactionError({
            code: 'action_transaction_failed',
            reason: 'The success evidence flush failed after collection.',
          }),
        );
      }
      successfulFlushes.push(input);
      currentInvocation = {
        ...currentInvocation,
        completedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-23T12:00:00.000Z')),
        status: 'succeeded',
      };
      return Effect.void;
    },
    lockInvocation: () => Effect.succeed(currentInvocation),
    rejectPermissionDenied: () => {
      currentInvocation = {
        ...currentInvocation,
        completedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-23T12:00:00.000Z')),
        status: 'rejected',
      };
      return Effect.void;
    },
    resolveInvocation: () => Effect.succeed(currentInvocation),
    transitionInvocationToRunning: () => {
      currentInvocation = { ...currentInvocation, status: 'running' };
      return Effect.succeed(currentInvocation);
    },
  };

  let installedTenantId = tenantId;
  let installedLegalEntityId = '';
  const database = {
    executor: yield* makeTestDatabase((statement, values) => {
      const sql = statement.toLowerCase();
      if (sql.includes('set_config')) {
        const [installedTenant, installedLegalEntity] = values;
        if (Predicate.isString(installedTenant)) {
          installedTenantId = installedTenant;
        }
        if (Predicate.isString(installedLegalEntity)) {
          installedLegalEntityId = installedLegalEntity;
        }
      }
      if (sql === 'commit' && options.commitIndeterminate === true) {
        return Effect.fail(new SqlError({ reason: new ConnectionError({ cause: { code: '08007' } }) }));
      }
      if (sql === 'commit') {
        commitCount += 1;
      }
      if (sql === 'rollback') {
        rollbackCount += 1;
      }
      if (sql.includes('current_setting')) {
        return Effect.succeed([{ legal_entity_id: installedLegalEntityId, tenant_id: installedTenantId }]);
      }
      if (sql.startsWith('select')) {
        return Effect.succeed([{ authBindingId: legalPrincipal.authBindingId }]);
      }
      return Effect.succeed([]);
    }),
  };

  const contextAccess: ContextAccessService = {
    businessPermissions: (input) => {
      businessChecks.push(input);
      return Effect.succeed(
        input.targets.map((target) => ({
          decision: options.businessDecision ?? ('allowed' as const),
          key: toBusinessPermissionAccessKey(target),
        })),
      );
    },
    legalEntities: ({ legalEntityIds }: { readonly legalEntityIds: readonly string[] }) =>
      Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
    modules: () => Effect.succeed([]),
    resources: () => Effect.succeed([]),
    tenants: () => Effect.succeed([]),
  };
  const scopeResolver = makeOperationalScopeResolver({ load: () => Effect.succeed(activeScope) }, contextAccess);
  const moduleStateGate = {
    check: checkModuleEntrypoint,
    prepareSnapshot: (scopeTenantId: string, entrypoints: readonly ModuleEntrypointDescriptor[]) =>
      Effect.succeed(
        makeModuleStateSnapshot(
          scopeTenantId,
          entrypoints,
          entrypoints.map((entrypoint) => ({ moduleKey: entrypoint.moduleKey, state: 'active' as const })),
        ),
      ),
    recheckWrite: () => Effect.void,
  };

  const persistence: PriceGroupCatalogPersistence = {
    createDefinitionRevision: () =>
      options.createFailure === 'expected-current'
        ? Effect.fail(
            new PriceGroupExpectedCurrentConflict({
              code: 'price_group_expected_current_conflict',
              priceGroupRef,
              reason: 'The Price Group revision lost the expected-current race.',
            }),
          )
        : Effect.succeed(definition),
    createPriceGroup: () =>
      options.createFailure === 'unavailable'
        ? Effect.fail(
            new PriceGroupPersistenceUnavailable({
              code: 'price_group_persistence_unavailable',
              reason: 'The persistence transaction failed.',
              retryable: true,
            }),
          )
        : Effect.succeed(createResult),
    readCurrentDefinition: () => Effect.die('unused'),
    readDefinitionRevision: () => Effect.die('unused'),
    retirePriceGroup: () =>
      options.createFailure === 'expected-current'
        ? Effect.fail(
            new PriceGroupExpectedCurrentConflict({
              code: 'price_group_expected_current_conflict',
              priceGroupRef,
              reason: 'The Price Group retirement lost the expected-current race.',
            }),
          )
        : Effect.die('unused'),
    validateCompatibility: () => Effect.die('unused'),
  };
  const services = () => {
    serviceResolutionCount += 1;
    return Effect.succeed(persistence);
  };
  const createRegistration = defineAction(
    createPriceGroupAction.descriptor,
    getActionHandler(createPriceGroupAction),
    services,
  );
  const revisionRegistration = defineAction(
    createPriceGroupDefinitionRevisionAction.descriptor,
    getActionHandler(createPriceGroupDefinitionRevisionAction),
    services,
  );
  const retirementRegistration = defineAction(
    retirePriceGroupAction.descriptor,
    getActionHandler(retirePriceGroupAction),
    services,
  );
  const runtime = makeActionRuntime(
    database,
    repository,
    { checkActionPermission: () => Effect.succeed('allowed') },
    scopeResolver,
    {
      contextAccess,
      moduleEntrypointGateway: makeModuleEntrypointGateway(moduleStateGate),
      moduleStateGate,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      resolveHandler: (registration) => {
        handlerResolutionCount += 1;
        return getActionHandler(registration);
      },
    },
  );
  const runCreate = (
    principal: typeof legalPrincipal = tenantPrincipal,
    candidate: CreatePriceGroupPayload = createPayload,
  ) =>
    runtime.runAction({
      payload: candidate,
      principal,
      registration: createRegistration,
      transport: { correlationId: 'create-price-group', idempotencyKey: 'create-dealer' },
    });
  const runRevision = (candidate: CreatePriceGroupDefinitionRevisionPayload = revisionPayload) =>
    runtime.runAction({
      payload: candidate,
      principal: tenantPrincipal,
      registration: revisionRegistration,
      transport: { correlationId: 'revise-price-group', idempotencyKey: 'revise-dealer' },
    });
  const runRetirement = (candidate: RetirePriceGroupPayload = retirementPayload) =>
    runtime.runAction({
      payload: candidate,
      principal: tenantPrincipal,
      registration: retirementRegistration,
      transport: { correlationId: 'retire-price-group', idempotencyKey: 'retire-dealer' },
    });

  return {
    businessChecks,
    counts: () => ({
      commitCount,
      createInvocationCount,
      handlerResolutionCount,
      rollbackCount,
      serviceResolutionCount,
    }),
    flushAttempts,
    resolveCommit: () => runtime.resolveActionCommit({ invocationId, principal: tenantPrincipal }),
    runCreate,
    runRetirement,
    runRevision,
    successfulFlushes,
  };
});

describe('Price Group management Actions through the Core runtime', () => {
  it.effect('rejects cross-Tenant and forbidden legal-entity context before service or handler resolution', () =>
    Effect.gen(function* rejectInvalidTrustedScope() {
      const crossTenant = yield* makeHarness();
      const crossTenantFailure = yield* Effect.flip(
        crossTenant.runRevision({
          ...revisionPayload,
          expectedCurrent: {
            ...revisionPayload.expectedCurrent,
            priceGroupRef: { ...revisionPayload.expectedCurrent.priceGroupRef, tenantId: foreignTenantId },
          },
        }),
      );
      expect(Predicate.isTagged(crossTenantFailure, 'ActionPermissionCheckError')).toBe(true);
      expect(crossTenant.counts()).toMatchObject({
        createInvocationCount: 0,
        handlerResolutionCount: 0,
        serviceResolutionCount: 0,
      });

      const legalEntity = yield* makeHarness();
      const legalEntityFailure = yield* Effect.flip(legalEntity.runCreate(legalPrincipal));
      expect(Predicate.isTagged(legalEntityFailure, 'OperationContextInvalid')).toBe(true);
      expect(legalEntity.counts()).toMatchObject({
        createInvocationCount: 0,
        handlerResolutionCount: 0,
        serviceResolutionCount: 0,
      });
    }),
  );

  it.effect('keeps definite denial and indeterminate authorization ahead of owner service resolution', () =>
    Effect.gen(function* rejectUnauthorized() {
      const denied = yield* makeHarness({ businessDecision: 'denied' });
      expect(Predicate.isTagged(yield* Effect.flip(denied.runCreate()), 'ActionPermissionDenied')).toBe(true);
      expect(denied.counts()).toMatchObject({ handlerResolutionCount: 0, serviceResolutionCount: 0 });
      expect(denied.businessChecks).toHaveLength(1);

      const unavailable = yield* makeHarness({ businessDecision: 'unavailable' });
      expect(Predicate.isTagged(yield* Effect.flip(unavailable.runCreate()), 'ActionPermissionCheckError')).toBe(true);
      expect(unavailable.counts()).toMatchObject({ handlerResolutionCount: 0, serviceResolutionCount: 0 });
      expect(unavailable.businessChecks).toHaveLength(1);
    }),
  );

  it.effect('rolls back typed owner failures without flushing audit, event, or outbox success evidence', () =>
    Effect.gen(function* rollBackOwnerFailure() {
      const harness = yield* makeHarness({ createFailure: 'unavailable' });
      const failure = yield* Effect.flip(harness.runCreate());

      expect(Predicate.isTagged(failure, 'PriceGroupPersistenceUnavailable')).toBe(true);
      expect(harness.counts()).toMatchObject({
        handlerResolutionCount: 1,
        rollbackCount: 1,
        serviceResolutionCount: 1,
      });
      expect(harness.flushAttempts).toEqual([]);
      expect(harness.successfulFlushes).toEqual([]);
    }),
  );

  it.effect('distinguishes equivalent replay from request-hash conflict for one idempotency key', () =>
    Effect.gen(function* enforceActionIdempotency() {
      const equivalent = yield* makeHarness();
      yield* equivalent.runCreate();
      expect(Predicate.isTagged(yield* Effect.flip(equivalent.runCreate()), 'ActionAlreadyCommitted')).toBe(true);
      expect(equivalent.counts().serviceResolutionCount).toBe(1);

      const conflicting = yield* makeHarness();
      yield* conflicting.runCreate();
      expect(
        Predicate.isTagged(
          yield* Effect.flip(
            conflicting.runCreate(tenantPrincipal, { ...createPayload, displayName: 'Changed intent' }),
          ),
          'ActionRequestHashConflict',
        ),
      ).toBe(true);
      expect(conflicting.counts().serviceResolutionCount).toBe(1);
    }),
  );

  it.effect('returns the invocation identity when a completed transaction loses commit acknowledgement', () =>
    Effect.gen(function* reportCommitUncertainty() {
      const harness = yield* makeHarness({ commitIndeterminate: true });
      const failure = yield* Effect.flip(harness.runCreate());

      expect(Schema.is(ActionCommitIndeterminate)(failure)).toBe(true);
      if (!Schema.is(ActionCommitIndeterminate)(failure)) {
        throw new Error('Expected an indeterminate Action commit');
      }
      expect(failure.code).toBe('action_commit_indeterminate');
      expect(failure.invocationId).toBe(invocationId);
      expect(harness.flushAttempts).toHaveLength(1);
      expect(harness.successfulFlushes).toHaveLength(1);
      const resolution = yield* Effect.flip(harness.resolveCommit());
      expect(Predicate.isTagged(resolution, 'ActionAlreadyCommitted')).toBe(true);
      if (!Predicate.isTagged(resolution, 'ActionAlreadyCommitted')) {
        throw new Error('Expected commit resolution to report the completed invocation');
      }
      expect(resolution.invocationId).toBe(invocationId);
      expect(harness.counts().serviceResolutionCount).toBe(1);
    }),
  );

  it.effect('preserves racing revision and retirement conflicts without success evidence', () =>
    Effect.gen(function* rejectStaleMutations() {
      const revision = yield* makeHarness({ createFailure: 'expected-current' });
      const revisionFailure = yield* Effect.flip(revision.runRevision());
      expect(Predicate.isTagged(revisionFailure, 'PriceGroupExpectedCurrentConflict')).toBe(true);
      expect(revision.flushAttempts).toEqual([]);
      expect(revision.counts()).toMatchObject({ rollbackCount: 1, serviceResolutionCount: 1 });

      const retirement = yield* makeHarness({ createFailure: 'expected-current' });
      const retirementFailure = yield* Effect.flip(retirement.runRetirement());
      expect(Predicate.isTagged(retirementFailure, 'PriceGroupExpectedCurrentConflict')).toBe(true);
      expect(retirement.flushAttempts).toEqual([]);
      expect(retirement.counts()).toMatchObject({ rollbackCount: 1, serviceResolutionCount: 1 });
    }),
  );

  it.effect('rolls back collected audit, event, and outbox evidence when the atomic success flush fails', () =>
    Effect.gen(function* rollBackCollectedEvidence() {
      const harness = yield* makeHarness({ flushFailure: true });
      const failure = yield* Effect.flip(harness.runCreate());

      expect(Predicate.isTagged(failure, 'ActionTransactionError')).toBe(true);
      expect(harness.flushAttempts).toHaveLength(1);
      expect(harness.flushAttempts[0]?.evidence).toMatchObject({
        auditEvidence: {
          expectedCatalogRevision: createPayload.expectedCatalogRevision,
          reason: createPayload.reason,
        },
        domainEvents: [{ eventType: 'pricing.price-group-catalog.price-group-containment-projection-requested.v1' }],
        outboxMessages: [{ message: { topic: 'pricing.price-group.containment-projection-requested' } }],
      });
      expect(harness.successfulFlushes).toEqual([]);
      expect(harness.counts()).toMatchObject({ commitCount: 0, rollbackCount: 1 });
    }),
  );
});
