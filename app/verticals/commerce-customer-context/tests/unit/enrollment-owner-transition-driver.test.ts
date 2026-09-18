import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AttemptClaimResult, AttemptRecordResult } from '../../src/enrollment/attempts/attempt-persistence.ts';
import type { CommerceEnrollmentAttemptService } from '../../src/enrollment/attempts/attempt-service.ts';
import { CommerceEnrollmentAttemptIndeterminate } from '../../src/enrollment/attempts/errors.ts';
import {
  CommerceEnrollmentOwnerEffectIndeterminate,
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from '../../src/enrollment/orchestration/owner-transition-errors.ts';
import {
  CommerceEnrollmentOwnerEffectOutcomeSchema,
  CommerceEnrollmentOwnerTransitionSchema,
  commerceEnrollmentOwnerAttemptStoreForFreshService,
  makeCommerceEnrollmentCoreIdentityOwnerEffect,
  makeCommerceEnrollmentOwnerTransitionDriver,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import type {
  CommerceEnrollmentCoreIdentityOwnerEffectOptions,
  CommerceEnrollmentOwnerAttemptFreshServiceFactory,
  CommerceEnrollmentOwnerAttemptStore,
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerTransition,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import type {
  ClaimEnrollmentTransitionInput,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
  ReadEnrollmentAttemptInput,
  ReadEnrollmentOwnerOperationInput,
  ReconcileEnrollmentRequest,
  ReconcileEnrollmentResolution,
  RecordEnrollmentOutcomeInput,
} from '../../shared/enrollment-contracts.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentKeySchema,
  EnrollmentLeaseTokenSchema,
  EnrollmentModuleKeySchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import type { ReadPrincipalBindingRequest } from '@app/shared-contracts/server/external-identity-client';
import {
  AuthBindingIdSchema,
  ReadPrincipalBindingResultSchema,
} from '@app/core-runtime/auth/external-identity-contracts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('20000000-0000-4000-8000-000000000001');
const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('30000000-0000-4000-8000-000000000001');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('40000000-0000-4000-8000-000000000001');
const operationId = Schema.decodeSync(EnrollmentOwnerOperationIdSchema)('50000000-0000-4000-8000-000000000001');
const leaseToken = Schema.decodeSync(EnrollmentLeaseTokenSchema)('60000000-0000-4000-8000-000000000001');
const reconciliationRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('70000000-0000-4000-8000-000000000001');
const ownerModuleKey = Schema.decodeSync(EnrollmentModuleKeySchema)('commerce.portal-auth');
const transitionKey = Schema.decodeSync(EnrollmentTransitionKeySchema)('provider.account.create');
const workerId = Schema.decodeSync(EnrollmentKeySchema)('worker-1');
const requestDigest = 'a'.repeat(64);
const at = DateTime.makeUnsafe('2026-09-17T10:00:00.000Z');
const activeUntil = DateTime.makeUnsafe('2099-09-17T10:00:00.000Z');
const expiredAt = DateTime.makeUnsafe('1960-09-17T10:00:00.000Z');

const transition: CommerceEnrollmentOwnerTransition = Schema.decodeSync(CommerceEnrollmentOwnerTransitionSchema)({
  actorPrincipalId,
  correlationId: 'owner-driver-unit',
  expectedRevision: 1,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  requestDigest,
  tenantId,
  transitionKey,
});

const attempt = (overrides: Partial<EnrollmentAttemptSnapshot> = {}): EnrollmentAttemptSnapshot => ({
  createdAt: at,
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'b'.repeat(64),
  intentKey: Schema.decodeSync(EnrollmentKeySchema)('portal-intent-1'),
  journey: 'RETAIL_SELF_ENROLLMENT',
  lease: {
    leaseExpiresAt: activeUntil,
    leaseToken,
    workerId,
  },
  portalEnrollmentAttemptId: attemptId,
  revision: 2,
  state: 'IN_PROGRESS',
  tenantId,
  updatedAt: at,
  ...overrides,
});

const operation = (overrides: Partial<EnrollmentOwnerOperationSnapshot> = {}): EnrollmentOwnerOperationSnapshot => ({
  actorPrincipalId,
  createdAt: at,
  lease: {
    leaseExpiresAt: activeUntil,
    leaseToken,
    workerId,
  },
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  portalEnrollmentOwnerOperationId: operationId,
  requestDigest,
  required: true,
  revision: 1,
  status: 'IN_PROGRESS',
  tenantId,
  transitionKey,
  updatedAt: at,
  ...overrides,
});

const claimResult = (overrides: Partial<AttemptClaimResult> = {}): AttemptClaimResult => ({
  attempt: attempt(),
  operation: operation(),
  outcome: 'CLAIMED',
  ...overrides,
});

const recordResult: AttemptRecordResult = {
  attempt: attempt({ revision: 3, state: 'COMPLETE' }),
  operation: operation({ revision: 2, status: 'SUCCEEDED' }),
  outcome: 'RECORDED',
};

const outcome = Schema.decodeSync(CommerceEnrollmentOwnerEffectOutcomeSchema)({
  outcomeCode: 'provider_account_created',
  resultReference: 'provider-result-1',
  status: 'SUCCEEDED',
});

const makeAttemptStore = (
  claim: AttemptClaimResult = claimResult(),
  overrides: Partial<CommerceEnrollmentOwnerAttemptStore> = {},
): CommerceEnrollmentOwnerAttemptStore => {
  const claimTransition = (_input: ClaimEnrollmentTransitionInput) => Effect.succeed(claim);
  const read = (_input: Parameters<CommerceEnrollmentAttemptService['read']>[0]) => Effect.succeed(attempt());
  const readOwnerOperation = (_input: Parameters<CommerceEnrollmentAttemptService['readOwnerOperation']>[0]) =>
    Effect.succeed(operation());
  const reconcileOutcome = (_input: ReconcileEnrollmentRequest, _resolution: ReconcileEnrollmentResolution) =>
    Effect.succeed(recordResult);
  const recordOutcome = (input: RecordEnrollmentOutcomeInput) =>
    Effect.sync(() => {
      void input;
      return recordResult;
    });
  return {
    claimTransition,
    read,
    readOwnerOperation,
    reconcileOutcome,
    recordOutcome,
    ...overrides,
  };
};

const successfulOwner = (onDispatch?: () => void): CommerceEnrollmentOwnerEffect => ({
  dispatch: () =>
    Effect.sync(() => {
      onDispatch?.();
      return outcome;
    }),
  reconcile: () => Effect.succeed({ actorPrincipalId, reconciliationRef, status: 'SUCCEEDED' as const }),
});

it.effect('dispatches only from a claimed immutable active lease and records the owner result', () =>
  Effect.gen(function* dispatchesAfterClaim() {
    let dispatches = 0;
    let recorded: RecordEnrollmentOutcomeInput | undefined;
    const store = makeAttemptStore(claimResult(), {
      recordOutcome: (input) =>
        Effect.sync(() => {
          recorded = input;
          return recordResult;
        }),
    });
    const driver = makeCommerceEnrollmentOwnerTransitionDriver({
      attempt: store,
      owner: successfulOwner(() => {
        dispatches += 1;
      }),
      workerId: () => workerId,
    });
    const result = yield* driver.execute(transition);
    expect(result.outcome).toBe('RECORDED');
    expect(dispatches).toBe(1);
    expect(recorded?.status).toBe('SUCCEEDED');
    expect(recorded?.leaseToken).toBe(leaseToken);
  }),
);

it.effect('builds a fresh Attempt service for every persisted owner phase', () =>
  Effect.gen(function* usesFreshServicePerPhase() {
    const reconciliationResolution: ReconcileEnrollmentResolution = {
      actorPrincipalId,
      reconciliationRef,
      status: 'SUCCEEDED',
    };
    const claimInput: ClaimEnrollmentTransitionInput = {
      actorPrincipalId,
      expectedRevision: transition.expectedRevision,
      leaseDurationMs: 30_000,
      ownerInvocationId,
      ownerModuleKey,
      portalEnrollmentAttemptId: attemptId,
      requestDigest,
      required: true,
      tenantId,
      transitionKey,
      workerId,
    };
    const readInput: ReadEnrollmentAttemptInput = {
      portalEnrollmentAttemptId: attemptId,
      tenantId,
    };
    const readOperationInput: ReadEnrollmentOwnerOperationInput = {
      ownerModuleKey,
      portalEnrollmentAttemptId: attemptId,
      tenantId,
      transitionKey,
    };
    const recordInput: RecordEnrollmentOutcomeInput = {
      actorPrincipalId,
      expectedRevision: 2,
      leaseToken,
      ownerInvocationId,
      ownerModuleKey,
      portalEnrollmentAttemptId: attemptId,
      status: 'SUCCEEDED',
      tenantId,
      transitionKey,
      workerId,
    };
    const reconcileInput: ReconcileEnrollmentRequest = {
      expectedRevision: 1,
      ownerInvocationId,
      ownerModuleKey,
      portalEnrollmentAttemptId: attemptId,
      tenantId,
      transitionKey,
    };
    let builds = 0;
    const service: CommerceEnrollmentAttemptService = {
      claimTransition: () => Effect.succeed(claimResult()),
      read: () => Effect.succeed(attempt()),
      readOwnerOperation: () => Effect.succeed(operation()),
      reconcileOutcome: () => Effect.succeed(recordResult),
      recordOutcome: () => Effect.succeed(recordResult),
      start: () => Effect.die('unused start'),
      terminate: () => Effect.die('unused terminate'),
    };
    const factory: CommerceEnrollmentOwnerAttemptFreshServiceFactory = {
      make: (resolution) =>
        Effect.sync(() => {
          builds += 1;
          if (resolution !== undefined) {
            expect(resolution).toBe(reconciliationResolution);
          }
          return service;
        }),
    };
    const store = commerceEnrollmentOwnerAttemptStoreForFreshService(factory);
    yield* store.claimTransition(claimInput);
    yield* store.read(readInput);
    yield* store.readOwnerOperation(readOperationInput);
    yield* store.recordOutcome(recordInput);
    yield* store.reconcileOutcome(reconcileInput, reconciliationResolution);
    expect(builds).toBe(5);
  }),
);

it.effect('refuses dispatch when claim identity or lease is missing, expired, or worker-mismatched', () =>
  Effect.gen(function* gatesExternalEffect() {
    let dispatches = 0;
    const { lease: _operationLease, ...operationWithoutLease } = operation();
    const { lease: _attemptLease, ...attemptWithoutLease } = attempt();
    const cases: readonly AttemptClaimResult[] = [
      claimResult({ operation: operationWithoutLease }),
      claimResult({
        attempt: { ...attemptWithoutLease, lease: { leaseExpiresAt: expiredAt, leaseToken, workerId } },
        operation: operation({ lease: { leaseExpiresAt: expiredAt, leaseToken, workerId } }),
      }),
      claimResult({
        operation: operation({
          lease: {
            leaseExpiresAt: activeUntil,
            leaseToken,
            workerId: Schema.decodeSync(EnrollmentKeySchema)('other-worker'),
          },
        }),
      }),
    ];
    const owner: CommerceEnrollmentOwnerEffect = {
      dispatch: () =>
        Effect.sync(() => {
          dispatches += 1;
          return outcome;
        }),
      reconcile: () => Effect.succeed({ actorPrincipalId, reconciliationRef, status: 'SUCCEEDED' as const }),
    };
    for (const claim of cases) {
      const driver = makeCommerceEnrollmentOwnerTransitionDriver({
        attempt: makeAttemptStore(claim),
        owner,
        workerId: () => workerId,
      });
      const error = yield* Effect.flip(driver.execute(transition));
      expect(error).toBeInstanceOf(CommerceEnrollmentAttemptIndeterminate);
    }
    expect(dispatches).toBe(0);
  }),
);

it.effect('does not record an unavailable or indeterminate owner effect', () =>
  Effect.gen(function* preservesUnknownProviderOutcome() {
    let records = 0;
    const owner: CommerceEnrollmentOwnerEffect = {
      dispatch: () =>
        Effect.fail(
          new CommerceEnrollmentOwnerEffectUnavailable({
            code: 'provider_unavailable',
            reason: 'provider timed out',
          }),
        ),
      reconcile: () =>
        Effect.fail(
          new CommerceEnrollmentOwnerEffectIndeterminate({
            code: 'provider_unknown',
            reason: 'provider outcome is unknown',
          }),
        ),
    };
    const driver = makeCommerceEnrollmentOwnerTransitionDriver({
      attempt: makeAttemptStore(claimResult(), {
        recordOutcome: () =>
          Effect.sync(() => {
            records += 1;
            return recordResult;
          }),
      }),
      owner,
      workerId: () => workerId,
    });
    const error = yield* Effect.flip(driver.execute(transition));
    expect(error).toBeInstanceOf(CommerceEnrollmentAttemptIndeterminate);
    expect(records).toBe(0);
  }),
);

it.effect('turns a typed owner rejection into one durable FAILED outcome', () =>
  Effect.gen(function* recordsOwnerRejection() {
    let recordStatus: RecordEnrollmentOutcomeInput['status'] | undefined;
    const owner: CommerceEnrollmentOwnerEffect = {
      dispatch: () =>
        Effect.fail(
          new CommerceEnrollmentOwnerEffectRejected({
            code: 'provider_account_rejected',
            reason: 'duplicate provider account',
          }),
        ),
      reconcile: () => Effect.succeed({ actorPrincipalId, reconciliationRef, status: 'SUCCEEDED' as const }),
    };
    const driver = makeCommerceEnrollmentOwnerTransitionDriver({
      attempt: makeAttemptStore(claimResult(), {
        recordOutcome: (input) =>
          Effect.sync(() => {
            recordStatus = input.status;
            return recordResult;
          }),
      }),
      owner,
      workerId: () => workerId,
    });
    const result = yield* driver.execute(transition);
    expect(result.outcome).toBe('RECORDED');
    expect(recordStatus).toBe('FAILED');
  }),
);

it.effect('does not classify a current Core binding without exact owner evidence', () =>
  Effect.gen(function* rejectsUnprovenCoreRead() {
    const authBindingId = Schema.decodeSync(AuthBindingIdSchema)('80000000-0000-4000-8000-000000000001');
    const found = Schema.decodeSync(ReadPrincipalBindingResultSchema)({
      authBindingId,
      authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
      bindingRevision: 2,
      bindingStatus: 'active',
      originalInvocationId: null,
      outcome: 'FOUND',
      principalId: '90000000-0000-4000-8000-000000000001',
      principalStatus: 'active',
      tenantStatus: 'active',
    });
    const client = {
      activatePrincipalBinding: () => Effect.die('unused'),
      changePrincipalBindingStatus: () => Effect.die('unused'),
      issueExternalGatewayContext: () => Effect.die('unused'),
      readPrincipalBinding: (_payload: ReadPrincipalBindingRequest) => Effect.succeed(found),
      reservePrincipalBinding: () => Effect.die('unused'),
      resolveExternalSubject: () => Effect.die('unused'),
    };
    const options: CommerceEnrollmentCoreIdentityOwnerEffectOptions = {
      client,
      clientOptions: () => ({
        apiKey: Redacted.make('test'),
        baseUrl: 'https://core.invalid',
        requestCorrelation: 'core-driver-unit',
      }),
      makeDispatchRequest: () => {
        throw new Error('The reconcile-only test must not dispatch');
      },
      makeReconciliationRequest: () => ({ operation: 'read', payload: { authBindingId, lookup: 'binding' } }),
    };
    const effect = makeCommerceEnrollmentCoreIdentityOwnerEffect(options).reconcile({
      ...transition,
      observedRevision: 2,
      ownerOperationRevision: 1,
    });
    const error = yield* effect.pipe(Effect.flip);
    expect(error).toBeInstanceOf(CommerceEnrollmentOwnerEffectUnavailable);
  }),
);

it.effect('requires original invocation provenance before invoking Core read interpretation', () =>
  Effect.gen(function* acceptsExactCoreRead() {
    let interpretations = 0;
    const authBindingId = Schema.decodeSync(AuthBindingIdSchema)('80000000-0000-4000-8000-000000000001');
    const found = Schema.decodeSync(ReadPrincipalBindingResultSchema)({
      authBindingId,
      authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
      bindingRevision: 2,
      bindingStatus: 'active',
      originalInvocationId: ownerInvocationId,
      outcome: 'FOUND',
      principalId: '90000000-0000-4000-8000-000000000001',
      principalStatus: 'active',
      tenantStatus: 'active',
    });
    const client = {
      activatePrincipalBinding: () => Effect.die('unused'),
      changePrincipalBindingStatus: () => Effect.die('unused'),
      issueExternalGatewayContext: () => Effect.die('unused'),
      readPrincipalBinding: () => Effect.succeed(found),
      reservePrincipalBinding: () => Effect.die('unused'),
      resolveExternalSubject: () => Effect.die('unused'),
    };
    const options: CommerceEnrollmentCoreIdentityOwnerEffectOptions = {
      client,
      clientOptions: () => ({
        apiKey: Redacted.make('test'),
        baseUrl: 'https://core.invalid',
        requestCorrelation: 'core-driver-unit',
      }),
      interpretReadResult: (input, result) =>
        Effect.sync(() => {
          interpretations += 1;
          expect(input.requestDigest).toBe(requestDigest);
          expect(result.originalInvocationId).toStrictEqual(Option.some(ownerInvocationId));
          return { actorPrincipalId, reconciliationRef, status: 'SUCCEEDED' as const };
        }),
      makeDispatchRequest: () => {
        throw new Error('The reconcile-only test must not dispatch');
      },
      makeReconciliationRequest: () => ({ operation: 'read', payload: { authBindingId, lookup: 'binding' } }),
    };
    const resolution = yield* makeCommerceEnrollmentCoreIdentityOwnerEffect(options).reconcile({
      ...transition,
      observedRevision: 2,
      ownerOperationRevision: 1,
    });
    expect(resolution.status).toBe('SUCCEEDED');
    expect(interpretations).toBe(1);
  }),
);
