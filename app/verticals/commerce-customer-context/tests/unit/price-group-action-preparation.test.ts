import {
  TrustedPrincipalContextSchema,
  extractVerticalRuntimeSafeDescriptors,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import type { InstalledModuleCatalog, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import { getActionHandler } from '@app/core-runtime/testing/actions';
import { PriceGroupCompatibilityDecisionSchema } from '@app/price-group-catalog-contracts';
import { ValidatePriceGroupCompatibilityRequestSchema } from '@app/price-group-catalog-contracts/validate-price-group-compatibility';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, ConfigProvider, DateTime, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import type { ActionOwnerTransaction } from '../../../../packages/core-runtime/src/actions/context.ts';
import {
  getActionServiceFactory,
  getActionServicePreflight,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  OpenDatabaseTransaction,
  insideDatabaseTransaction,
} from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { withModuleOperationExecution } from '../../../../packages/core-runtime/src/modules/module-operation-execution.ts';
import { AssignCustomerPriceGroupPayloadSchema } from '../../shared/actions/assign-customer-price-group.ts';
import { PriceGroupCompatibilityEvidenceSchema } from '../../shared/domain/price-group-contracts.ts';
import type { PriceGroupCompatibilityEvidence } from '../../shared/domain/price-group-contracts.ts';
import { CustomerPriceGroupOverlapConflict } from '../../shared/domain/price-group-errors.ts';
import { CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT } from '../../shared/domain/price-group-ports.ts';
import type {
  AssignCustomerPriceGroupStoreInput,
  MigrateCustomerPriceGroupStoreInput,
} from '../../shared/domain/price-group-ports.ts';
import { assignCustomerPriceGroupAction } from '../../src/actions/assign-customer-price-group.action.ts';
import { assignCounterpartyPriceGroupAction } from '../../src/actions/assign-counterparty-price-group.action.ts';
import { migrateCustomerPriceGroupAction } from '../../src/actions/migrate-customer-price-group.action.ts';
import { migrateCounterpartyPriceGroupAction } from '../../src/actions/migrate-counterparty-price-group.action.ts';
import { removeCustomerPriceGroupAction } from '../../src/actions/remove-customer-price-group.action.ts';
import { removeCounterpartyPriceGroupAction } from '../../src/actions/remove-counterparty-price-group.action.ts';
import {
  prepareAssignCounterpartyPriceGroupServices,
  prepareAssignCustomerPriceGroupServices,
  prepareMigrateCounterpartyPriceGroupServices,
  prepareMigrateCustomerPriceGroupServices,
  priceGroupMutationCanReachCatalog,
  preparedPriceGroupAssignmentMatches,
  preparedPriceGroupMigrationMatches,
  preparedPriceGroupPayloadMatches,
  preparedPriceGroupScopeMatches,
  preparedPriceGroupWindowOpen,
  samePreparedPriceGroupProfile,
} from '../../src/actions/price-group-action-preparation.ts';
import {
  assignCounterpartyPriceGroupServicesForTransaction,
  assignCustomerPriceGroupServicesForTransaction,
  priceGroupActionServicesForTransaction,
} from '../../src/actions/price-group-action-services.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

const scope: OperationalScope = {
  audience: 'commerce-customer-context',
  authBindingId: '12480000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:price-group-preparation',
  authenticationNamespaceId: 'staff',
  authMethod: 'session',
  correlationId: 'price-group-preparation',
  legalEntityId: '12480000-0000-4000-8000-000000000002',
  principalId: '12480000-0000-4000-8000-000000000003',
  tenantId: '12480000-0000-4000-8000-000000000004',
  traceId: 'price-group-preparation-trace',
};
const millis = (instant: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(instant));
const compositionRevision = 'a'.repeat(64);
const invocation = '12480000-0000-4000-8000-000000000005';
const trustedOperationAt = '2026-10-31T12:00:00.000Z';
const ownerEnd = '2026-10-31T12:00:05.000Z';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: '12480000-0000-4000-8000-000000000006',
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId: scope.tenantId,
};
const profile = {
  kind: 'RETAIL',
  moduleId: 'commerce.customer-context',
  resourceId: '12480000-0000-4000-8000-000000000007',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId: scope.tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '12480000-0000-4000-8000-000000000008',
  resourceType: 'party.registry.counterparty',
  tenantId: scope.tenantId,
} as const;
const compatibility: PriceGroupCompatibilityEvidence = {
  catalogRevision: 7,
  definitionEffectivePeriod: { effectiveFrom: trustedOperationAt, effectiveTo: ownerEnd },
  definitionRevisionId: '12480000-0000-4000-8000-000000000009',
  definitionRevisionNumber: 3,
  meaningFingerprint: 'b'.repeat(64),
  priceGroupRef,
  requiredContract: { contractId: CUSTOMER_PRICE_GROUP_COMPATIBILITY_CONTRACT, version: 1 },
  trustedOperationAt,
  verifiedAt: '2026-10-31T12:00:01.000Z',
};
const payload = {
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  effectiveTo: '2026-12-01T00:00:00.000Z',
  expectedProfileRevision: 2,
  priceGroupRef,
  profile,
  reason: 'Assign the current contract group.',
};
const input: AssignCustomerPriceGroupStoreInput = {
  ...payload,
  actionInvocationId: invocation,
  compatibility,
  principalId: scope.principalId,
  recordedAt: '2026-10-31T12:00:02.000Z',
  tenantId: scope.tenantId,
};

it('prepares all four Catalog-dependent Actions and leaves Remove Actions local', () => {
  expect(getActionServicePreflight(assignCustomerPriceGroupAction)).toBe(prepareAssignCustomerPriceGroupServices);
  expect(getActionServicePreflight(assignCounterpartyPriceGroupAction)).toBe(
    prepareAssignCounterpartyPriceGroupServices,
  );
  expect(getActionServicePreflight(migrateCustomerPriceGroupAction)).toBe(prepareMigrateCustomerPriceGroupServices);
  expect(getActionServicePreflight(migrateCounterpartyPriceGroupAction)).toBe(
    prepareMigrateCounterpartyPriceGroupServices,
  );
  expect(getActionServicePreflight(removeCustomerPriceGroupAction)).toBeUndefined();
  expect(getActionServicePreflight(removeCounterpartyPriceGroupAction)).toBeUndefined();
  expect(getActionServiceFactory(assignCustomerPriceGroupAction)).toBe(assignCustomerPriceGroupServicesForTransaction);
  expect(getActionServiceFactory(assignCounterpartyPriceGroupAction)).toBe(
    assignCounterpartyPriceGroupServicesForTransaction,
  );
  expect(getActionServiceFactory(migrateCustomerPriceGroupAction)).toBe(priceGroupActionServicesForTransaction);
  expect(getActionServiceFactory(migrateCounterpartyPriceGroupAction)).toBe(priceGroupActionServicesForTransaction);
});

// Owner phase: the real IO guard marks both owner transactions exactly as the Action runtime does.
const ownerPhaseKey = assignCustomerPriceGroupAction.descriptor.actionKey;
const ownerPhaseNow = DateTime.makeUnsafe('2026-11-10T09:00:00.000Z');
const gatewayConfiguration = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    ONTOS_GATEWAY_MODULE_API_KEY: 'test-only-customer-context-module-key',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
  }),
);
const gatewayScope = trustVerifiedGatewayPrincipalContext(
  {
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: scope.authBindingId,
      authContextRef: scope.authContextRef,
      authMethod: 'session',
      legalEntityId: scope.legalEntityId,
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    }),
    correlationId: 'price-group-owner-phase',
  },
  compositionRevision,
  { assertion: Redacted.make('test-only-source-assertion'), audience: 'commerce-customer-context' },
);
const ownerPhasePayload = Schema.decodeUnknownSync(AssignCustomerPriceGroupPayloadSchema)({
  effectiveFrom: '2026-12-01T00:00:00.000Z',
  expectedProfileRevision: 2,
  priceGroupRef,
  profile,
  reason: 'Assign the current contract group.',
});
const ownerDescriptors = extractVerticalRuntimeSafeDescriptors(commerceCustomerContextRegistration);
const operationCatalog = (providerInstalled: boolean) => {
  const operations = ownerDescriptors.requirements?.operations ?? [];
  const modules = new Map<string, unknown>([[ownerDescriptors.moduleId, { manifest: ownerDescriptors }]]);
  for (const { provider } of providerInstalled ? operations : []) {
    modules.set(provider.moduleId, {
      manifest: {
        publicSurface: {
          operationContracts: operations.map((operation) => ({
            entrypoint: { entrypointKey: operation.provider.entrypointKey },
            schemaVersion: operation.provider.schemaVersion,
          })),
        },
      },
    });
  }
  // SAFETY: the operation requirement check reads only getByModuleId(...).manifest requirements and contracts.
  return { getByModuleId: (moduleId: string) => modules.get(moduleId) } as unknown as InstalledModuleCatalog;
};

const failureOf = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
const causeOf = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : '';

interface OwnerPhaseOptions {
  readonly decision?: 'MISSING' | 'USABLE';
  readonly profileRevisionAtCommit?: number;
  readonly providerInstalled?: boolean;
}

const ownerPhase = Effect.fn('PriceGroupPreparationTest.ownerPhase')(function* ownerPhase(
  options: OwnerPhaseOptions = {},
) {
  yield* TestClock.setTime(DateTime.toEpochMillis(ownerPhaseNow));
  const events: string[] = [];
  const shellBodies: unknown[] = [];
  let inspections = 0;
  const invoke: ScopedTransactionExecutor['invoke'] = (routine) =>
    Effect.gen(function* answerRoutine() {
      const open = yield* OpenDatabaseTransaction;
      events.push(`${Option.isSome(open) ? 'sql' : 'sql-outside-transaction'}:${routine.name}`);
      if (routine.name === 'inspect_price_group_profile') {
        inspections += 1;
        const revision = inspections > 1 ? (options.profileRevisionAtCommit ?? 2) : 2;
        return yield* Schema.decodeUnknownEffect(Schema.Array(routine.resultSchema))([
          { counterparty_resource_id: null, outcome: 'CURRENT', profile_state: 'ACTIVE', revision },
        ]).pipe(Effect.orDie);
      }
      if (routine.name === 'assign_price_group') {
        return yield* Schema.decodeUnknownEffect(Schema.Array(routine.resultSchema))([
          {
            assignment_id: null,
            catalog_revision: null,
            changed: false,
            compatibility_contract_id: null,
            compatibility_contract_revision: null,
            definition_revision: null,
            effective_from: null,
            effective_to: null,
            lifecycle: null,
            outcome: 'OVERLAP',
            price_group_module_id: null,
            price_group_resource_id: null,
            price_group_resource_type: null,
            profile_state: null,
            reason: null,
            recorded_at: null,
            replaced_assignment_id: null,
            revision: null,
          },
        ]).pipe(Effect.orDie);
      }
      return yield* Effect.die(`Unexpected Price Group owner routine ${routine.name}`);
    });
  // SAFETY: Price Group persistence consumes only `invoke`; this fake supplies that exact test seam.
  const executor = { invoke } as unknown as ScopedTransactionExecutor;
  const transaction: ActionOwnerTransaction = (operation) =>
    operation(executor).pipe(insideDatabaseTransaction(ownerPhaseKey));
  const answer = (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    events.push(`fetch:${pathname}`);
    if (pathname === '/shell-super-app-api/auth/delegated/gateway-context') {
      return request
        .json()
        .then(Schema.decodeUnknownSync(GatewayDelegatedContextRequestSchema))
        .then((asked) => {
          shellBodies.push(Schema.encodeSync(GatewayDelegatedContextRequestSchema)(asked));
          return Response.json({
            apiBaseUrl: '/price-group-catalog-api',
            compositionRevision,
            expiresAt: Math.floor(DateTime.toEpochMillis(ownerPhaseNow) / 1000) + 30,
            token: 'test-only-gateway-assertion',
          });
        });
    }
    return request
      .json()
      .then(Schema.decodeUnknownSync(ValidatePriceGroupCompatibilityRequestSchema))
      .then((decoded) => {
        const asked = Schema.encodeSync(ValidatePriceGroupCompatibilityRequestSchema)(decoded);
        const observed = {
          catalogRevision: 7,
          observedAt: asked.trustedOperationAt,
          trustedOperationAt: asked.trustedOperationAt,
        };
        const decision =
          options.decision === 'MISSING'
            ? { catalogObservation: observed, kind: 'MISSING', priceGroupRef: asked.priceGroupRef }
            : {
                evidence: {
                  ...compatibility,
                  definitionEffectivePeriod: { effectiveFrom: trustedOperationAt, effectiveTo: null },
                  priceGroupRef: asked.priceGroupRef,
                  requiredContract: asked.requiredContract,
                  trustedOperationAt: asked.trustedOperationAt,
                  verifiedAt: asked.trustedOperationAt,
                },
                kind: 'USABLE',
              };
        return Response.json(
          Schema.encodeSync(PriceGroupCompatibilityDecisionSchema)(
            Schema.decodeUnknownSync(PriceGroupCompatibilityDecisionSchema)(decision),
          ),
        );
      });
  };
  const fakeFetch: typeof fetch = (target, init) => answer(new Request(target, init));
  const lease = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    withModuleOperationExecution(
      {
        loadCatalog: Effect.succeed(operationCatalog(options.providerInstalled ?? true)),
        ownerRegistration: commerceCustomerContextRegistration,
        phase: 'execution',
        registration: assignCustomerPriceGroupAction,
        revision: compositionRevision,
        scope: gatewayScope,
      },
      effect,
    );
  const preflight = getActionServicePreflight(assignCustomerPriceGroupAction);
  const prepared =
    preflight === undefined
      ? Exit.succeed(getActionServiceFactory(assignCustomerPriceGroupAction))
      : yield* lease(
          preflight(ownerPhasePayload, {
            actionInvocationId: invocation,
            compositionRevision,
            evaluatePolicy: () => Effect.die('Price Group preparation evaluates no Policy'),
            scope: gatewayScope,
            transaction,
          }),
        ).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
          Effect.provide(gatewayConfiguration),
          Effect.exit,
        );
  if (Exit.isFailure(prepared)) {
    return { cause: causeOf(prepared), events, failure: failureOf(prepared), shellBodies };
  }
  const collector = createActionCollector(
    assignCustomerPriceGroupAction.descriptor.domainEvents,
    'commerce.customer-context',
    assignCustomerPriceGroupAction.descriptor.accessEvidencePolicy,
    assignCustomerPriceGroupAction.descriptor.auditEvidenceSchema,
  );
  const outcome = yield* lease(
    prepared.value(executor, gatewayScope, compositionRevision).pipe(
      Effect.flatMap((services) =>
        getActionHandler(assignCustomerPriceGroupAction)(ownerPhasePayload, {
          actionInvocationId: invocation,
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          compositionRevision,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope: gatewayScope,
          services,
        }),
      ),
      insideDatabaseTransaction(ownerPhaseKey),
    ),
  ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch), Effect.provide(gatewayConfiguration), Effect.exit);
  return { cause: causeOf(outcome), events, failure: failureOf(outcome), shellBodies };
});

it.layer(Layer.mergeAll(NodeCrypto.layer, TestClock.layer()))('Price Group Action owner phase', (suite) => {
  suite.effect('reads the Catalog between released owner snapshots and commits on prepared evidence only', () =>
    Effect.gen(function* releasedCatalogRead() {
      const { cause, events, failure, shellBodies } = yield* ownerPhase();
      // No outbound call ran inside either transaction, so the guard raised nothing.
      expect(cause).not.toContain('IoInsideDatabaseTransaction');
      // The store was reached inside the transaction: the overlap answer is the owner's, not a guard defect.
      expect(Schema.is(CustomerPriceGroupOverlapConflict)(failure)).toBe(true);
      expect(events).toEqual([
        'sql:inspect_price_group_profile',
        'fetch:/shell-super-app-api/auth/delegated/gateway-context',
        expect.stringMatching(/^fetch:\/price-group-catalog-api\//u),
        'sql:inspect_price_group_profile',
        'sql:inspect_price_group_profile',
        'sql:assign_price_group',
      ]);
      // Customer Context delegates the requester's verified assertion; it never acts as itself.
      expect(shellBodies).toMatchObject([
        {
          audience: 'price-group-catalog',
          legalEntityScope: 'tenant',
          subject: { _tag: 'Assertion', sourceAssertion: 'test-only-source-assertion' },
        },
      ]);
    }),
  );

  suite.effect('keeps a missing Catalog operation unavailable, without any delegated call, until the handler', () =>
    Effect.gen(function* missingProvider() {
      const { events, failure } = yield* ownerPhase({ providerInstalled: false });
      // The requirement refusal is reported in SQL, after the runtime's owner decision, as main reported it.
      expect(failure).toMatchObject({
        _tag: 'CustomerPriceGroupCatalogUnavailable',
        cause: { code: 'module_operation_requirement_unsatisfied' },
      });
      expect(events).toEqual([
        'sql:inspect_price_group_profile',
        'sql:inspect_price_group_profile',
        'sql:inspect_price_group_profile',
      ]);
    }),
  );

  suite.effect('keeps a Catalog rejection a rejection inside the transaction', () =>
    Effect.gen(function* rejectedCatalog() {
      const { events, failure } = yield* ownerPhase({ decision: 'MISSING' });
      expect(failure).toMatchObject({ _tag: 'CustomerPriceGroupCatalogRejected', reasonCode: 'MISSING' });
      expect(events).not.toContain('sql:assign_price_group');
    }),
  );

  suite.effect('refuses to commit when the profile changed after preparation', () =>
    Effect.gen(function* staleSnapshot() {
      const { events, failure } = yield* ownerPhase({ profileRevisionAtCommit: 3 });
      expect(failure).toMatchObject({ _tag: 'OperationContextUnavailable' });
      expect(events).not.toContain('sql:assign_price_group');
    }),
  );
});

it('defers retroactive schedules to the handler without reaching Catalog for any Assign or Migrate Action', () => {
  const current = { _tag: 'CURRENT', counterpartyRef: null, revision: 2, state: 'ACTIVE' } as const;
  const counterpartyCurrent = { ...current, counterpartyRef };
  const counterpartyProfile = {
    ...profile,
    kind: 'COUNTERPARTY',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  } as const;
  const assignmentRef = {
    moduleId: 'commerce.customer-context',
    resourceId: '12480000-0000-4000-8000-000000000010',
    resourceType: 'commerce.customer-context.customer-price-group-assignment',
    tenantId: scope.tenantId,
  } as const;
  const migration = {
    effectiveFrom: payload.effectiveFrom,
    reason: payload.reason,
    sourcePriceGroupRef: { ...priceGroupRef, resourceId: 'source-group' },
    targetPriceGroupRef: priceGroupRef,
    targets: [{ assignmentRef, expectedProfileRevision: 2, expectedRevision: 4, profile }],
  };
  const counterpartyMigration = {
    ...migration,
    counterpartyRef,
    targets: [{ assignmentRef, expectedProfileRevision: 2, expectedRevision: 4, profile: counterpartyProfile }],
  };
  const cases = [
    { facts: [current], intent: payload },
    { facts: [counterpartyCurrent], intent: { ...payload, counterpartyRef, profile: counterpartyProfile } },
    { facts: [current], intent: migration },
    { facts: [counterpartyCurrent], intent: counterpartyMigration },
  ];
  for (const { facts, intent } of cases) {
    const effectiveAt = millis(intent.effectiveFrom);
    expect(priceGroupMutationCanReachCatalog(intent, facts, effectiveAt - 1)).toBe(true);
    expect(priceGroupMutationCanReachCatalog(intent, facts, effectiveAt)).toBe(true);
    expect(priceGroupMutationCanReachCatalog(intent, facts, effectiveAt + 1)).toBe(false);
  }
});

it('does not let schedule deferral bypass the exact owner profile snapshot gate', () => {
  const current = { _tag: 'CURRENT', counterpartyRef: null, revision: 2, state: 'ACTIVE' } as const;
  const beforeSchedule = millis(payload.effectiveFrom) - 1;
  expect(priceGroupMutationCanReachCatalog(payload, [current], beforeSchedule)).toBe(true);
  expect(priceGroupMutationCanReachCatalog(payload, [], beforeSchedule)).toBe(false);
  expect(priceGroupMutationCanReachCatalog(payload, [{ _tag: 'NOT_FOUND' }], beforeSchedule)).toBe(false);
  expect(priceGroupMutationCanReachCatalog(payload, [{ ...current, revision: 3 }], beforeSchedule)).toBe(false);
  expect(priceGroupMutationCanReachCatalog(payload, [{ ...current, state: 'SUSPENDED' }], beforeSchedule)).toBe(false);
});

it('honors the actual exclusive owner End without relabeling the prepared trustedOperationAt', () => {
  const original = structuredClone(compatibility);
  expect(preparedPriceGroupWindowOpen(compatibility, trustedOperationAt, millis(ownerEnd) - 1)).toBe(true);
  expect(preparedPriceGroupWindowOpen(compatibility, trustedOperationAt, millis(ownerEnd))).toBe(false);
  expect(preparedPriceGroupWindowOpen(compatibility, trustedOperationAt, millis(ownerEnd) + 1)).toBe(false);
  expect(preparedPriceGroupWindowOpen(compatibility, input.recordedAt, millis(input.recordedAt))).toBe(false);
  expect(compatibility).toEqual(original);
});

it('caps long and explicitly open-ended owner periods without extending the observation on reuse', () => {
  const long = {
    ...compatibility,
    definitionEffectivePeriod: { ...compatibility.definitionEffectivePeriod, effectiveTo: payload.effectiveTo },
  };
  const open = {
    ...compatibility,
    definitionEffectivePeriod: { ...compatibility.definitionEffectivePeriod, effectiveTo: null },
  };
  const cap = millis(trustedOperationAt) + 30_000;
  expect(preparedPriceGroupWindowOpen(long, trustedOperationAt, cap - 1)).toBe(true);
  expect(preparedPriceGroupWindowOpen(long, trustedOperationAt, cap)).toBe(false);
  expect(preparedPriceGroupWindowOpen(open, trustedOperationAt, cap - 1)).toBe(true);
  expect(preparedPriceGroupWindowOpen(open, trustedOperationAt, cap)).toBe(false);
  expect(preparedPriceGroupWindowOpen(compatibility, trustedOperationAt, millis(trustedOperationAt))).toBe(false);
  expect(preparedPriceGroupWindowOpen(compatibility, trustedOperationAt, Number.NaN)).toBe(false);
});

it('does not invent an owner period or End when validity is absent or malformed', () => {
  const { effectiveTo: _end, ...withoutEnd } = compatibility.definitionEffectivePeriod;
  const { definitionEffectivePeriod: _period, ...withoutPeriod } = compatibility;
  const accepts = Schema.is(PriceGroupCompatibilityEvidenceSchema);
  expect(accepts({ ...compatibility, definitionEffectivePeriod: withoutEnd })).toBe(false);
  expect(accepts(withoutPeriod)).toBe(false);
  expect(
    accepts({
      ...compatibility,
      definitionEffectivePeriod: { ...compatibility.definitionEffectivePeriod, effectiveTo: 'invalid' },
    }),
  ).toBe(false);
});

it('binds exact scope, principal authentication, Legal Entity, Storefront, and composition', () => {
  const matches = (actual: OperationalScope, revision = compositionRevision) =>
    preparedPriceGroupScopeMatches(scope, actual, compositionRevision, revision);
  expect(matches({ ...scope })).toBe(true);
  expect(matches({ ...scope, principalId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...scope, tenantId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...scope, legalEntityId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...scope, authBindingId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...scope, authenticationNamespaceId: 'another-namespace' })).toBe(false);
  expect(matches({ ...scope, trustedStorefrontId: 'another-storefront' })).toBe(false);
  expect(matches({ ...scope, audience: 'another-owner' })).toBe(false);
  expect(matches({ ...scope, correlationId: 'another-request' })).toBe(false);
  expect(matches({ ...scope, traceId: 'another-trace' })).toBe(false);
  expect(matches(scope, 'c'.repeat(64))).toBe(false);
});

it('binds the complete assignment intent and invocation but permits a fresh final recordedAt', () => {
  const matches = (actual: AssignCustomerPriceGroupStoreInput) =>
    preparedPriceGroupAssignmentMatches(payload, invocation, scope, compatibility, actual);
  expect(matches(input)).toBe(true);
  expect(matches({ ...input, recordedAt: '2026-10-31T12:00:03.000Z' })).toBe(true);
  expect(matches({ ...input, actionInvocationId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...input, principalId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...input, tenantId: counterpartyRef.resourceId })).toBe(false);
  expect(matches({ ...input, reason: 'A different intent' })).toBe(false);
  expect(matches({ ...input, counterpartyRef })).toBe(false);
  expect(matches({ ...input, expectedProfileRevision: 3 })).toBe(false);
  expect(matches({ ...input, effectiveFrom: payload.effectiveTo })).toBe(false);
  expect(matches({ ...input, effectiveTo: null })).toBe(false);
  expect(matches({ ...input, priceGroupRef: { ...priceGroupRef, resourceId: 'another-group' } })).toBe(false);
  expect(matches({ ...input, compatibility: { ...compatibility, trustedOperationAt: input.recordedAt } })).toBe(false);
  expect(
    matches({
      ...input,
      compatibility: {
        ...compatibility,
        definitionEffectivePeriod: { ...compatibility.definitionEffectivePeriod, effectiveTo: null },
      },
    }),
  ).toBe(false);
});

it('binds every migration target revision, source, order, and Counterparty association', () => {
  const counterpartyProfile = {
    ...profile,
    kind: 'COUNTERPARTY',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  } as const;
  const target = {
    assignmentRef: {
      moduleId: 'commerce.customer-context',
      resourceId: '12480000-0000-4000-8000-000000000010',
      resourceType: 'commerce.customer-context.customer-price-group-assignment',
      tenantId: scope.tenantId,
    },
    expectedProfileRevision: 2,
    expectedRevision: 4,
    profile: counterpartyProfile,
  } as const;
  const second = { ...target, assignmentRef: { ...target.assignmentRef, resourceId: 'another-assignment' } };
  const migration = {
    counterpartyRef,
    effectiveFrom: payload.effectiveFrom,
    reason: payload.reason,
    sourcePriceGroupRef: { ...priceGroupRef, resourceId: 'source-group' },
    targetPriceGroupRef: priceGroupRef,
    targets: [target, second],
  };
  const mutation: MigrateCustomerPriceGroupStoreInput = {
    ...migration,
    actionInvocationId: invocation,
    compatibility,
    principalId: scope.principalId,
    recordedAt: input.recordedAt,
    tenantId: scope.tenantId,
  };
  expect(preparedPriceGroupMigrationMatches(migration, invocation, scope, compatibility, mutation)).toBe(true);
  expect(preparedPriceGroupPayloadMatches(migration, { ...migration, targets: [second, target] })).toBe(false);
  expect(
    preparedPriceGroupPayloadMatches(migration, {
      ...migration,
      targets: [{ ...target, expectedRevision: 5 }, second],
    }),
  ).toBe(false);
  expect(
    preparedPriceGroupPayloadMatches(migration, {
      ...migration,
      counterpartyRef: { ...counterpartyRef, resourceId: 'another-counterparty' },
    }),
  ).toBe(false);
  expect(preparedPriceGroupPayloadMatches(migration, { ...migration, sourcePriceGroupRef: priceGroupRef })).toBe(false);
});

it('rechecks profile existence, revision, lifecycle, and exact association rather than only its ID', () => {
  const current = { _tag: 'CURRENT', counterpartyRef, revision: 2, state: 'ACTIVE' } as const;
  expect(samePreparedPriceGroupProfile(current, structuredClone(current))).toBe(true);
  expect(samePreparedPriceGroupProfile(current, { _tag: 'NOT_FOUND' })).toBe(false);
  expect(samePreparedPriceGroupProfile(current, { ...current, revision: 3 })).toBe(false);
  expect(samePreparedPriceGroupProfile(current, { ...current, state: 'SUSPENDED' })).toBe(false);
  expect(samePreparedPriceGroupProfile(current, { ...current, counterpartyRef: null })).toBe(false);
  expect(
    samePreparedPriceGroupProfile(current, {
      ...current,
      counterpartyRef: { ...counterpartyRef, resourceId: 'another-counterparty' },
    }),
  ).toBe(false);
});
