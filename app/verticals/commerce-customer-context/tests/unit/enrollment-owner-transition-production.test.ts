import type { OperationalScope, ScopedTransactionExecutor, TrustedPrincipalContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  ClaimEnrollmentTransitionInput,
  ReconcileEnrollmentRequest,
  ReconcileEnrollmentResolution,
  RecordEnrollmentOutcomeInput,
  ReadEnrollmentAttemptInput,
  ReadEnrollmentOwnerOperationInput,
} from '../../shared/enrollment-contracts.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentDigestSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentKeySchema,
  EnrollmentLeaseTokenSchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../../src/enrollment/attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../../src/enrollment/attempts/errors.ts';
import { RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  makeCommerceEnrollmentOwnerAttemptStoreForProduction,
  makeCommerceEnrollmentOwnerTransitionPreparationAuthorityForPorts,
} from '../../src/enrollment/orchestration/owner-transition-production.ts';
import type { CommerceEnrollmentOwnerTransactionRunnerService } from '../../src/enrollment/orchestration/owner-transition-production.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('20000000-0000-4000-8000-000000000001');
const actionInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)(
  '30000000-0000-4000-8000-000000000001',
);
const ownerInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('40000000-0000-4000-8000-000000000001');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('50000000-0000-4000-8000-000000000001');
const leaseToken = Schema.decodeSync(EnrollmentLeaseTokenSchema)('70000000-0000-4000-8000-000000000001');
const ownerModuleKey = Schema.decodeSync(EnrollmentModuleKeySchema)('commerce.portal-auth');
const transitionKey = Schema.decodeSync(EnrollmentTransitionKeySchema)('provider.account.create');
const evidenceRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('80000000-0000-4000-8000-000000000001');
const requestDigest = Schema.decodeSync(EnrollmentDigestSchema)('a'.repeat(64));

const principal: TrustedPrincipalContext = {
  authContextRef: 'job:enrollment:production-unit',
  authMethod: 'system',
  principalId: actorPrincipalId,
  tenantId,
};

const scope: OperationalScope = {
  ...principal,
  correlationId: 'enrollment-owner-production-unit',
};

const unavailable = () =>
  new CommerceEnrollmentAttemptUnavailable({
    attemptId,
    code: 'attempt_unavailable',
    reason: 'unit transaction unavailable',
    retryable: true,
  });

const claimInput: ClaimEnrollmentTransitionInput = {
  actorPrincipalId,
  expectedRevision: 1,
  leaseDurationMs: 30_000,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  requestDigest,
  required: true,
  tenantId,
  transitionKey,
  workerId: Schema.decodeSync(EnrollmentKeySchema)('worker-1'),
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
  workerId: Schema.decodeSync(EnrollmentKeySchema)('worker-1'),
};

const reconcileInput: ReconcileEnrollmentRequest = {
  expectedRevision: 1,
  ownerInvocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  tenantId,
  transitionKey,
};

const resolution: ReconcileEnrollmentResolution = {
  actorPrincipalId,
  reconciliationRef: evidenceRef,
  status: 'SUCCEEDED',
};

it.effect('opens a fresh transaction runner call for every production Attempt phase', () =>
  Effect.gen(function* usesFreshTransactionPerPhase() {
    let transactions = 0;
    const runner: CommerceEnrollmentOwnerTransactionRunnerService = {
      run: <Value>(
        _scope: OperationalScope,
        operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, CommerceEnrollmentAttemptError>,
      ): Effect.Effect<Value, CommerceEnrollmentAttemptError> => {
        void operation;
        transactions += 1;
        return Effect.fail(unavailable());
      },
    };
    const store = yield* makeCommerceEnrollmentOwnerAttemptStoreForProduction(scope).pipe(
      Effect.provideService(CommerceEnrollmentOwnerTransactionRunner, runner),
    );
    yield* store.claimTransition(claimInput).pipe(Effect.flip);
    yield* store.read(readInput).pipe(Effect.flip);
    yield* store.readOwnerOperation(readOperationInput).pipe(Effect.flip);
    yield* store.recordOutcome(recordInput).pipe(Effect.flip);
    yield* store.reconcileOutcome(reconcileInput, resolution).pipe(Effect.flip);
    expect(transactions).toBe(5);
  }),
);

it.effect('routes preparation through the matching owner port and fails closed when absent', () =>
  Effect.gen(function* routesExplicitOwnerPorts() {
    const binding = {
      actionInvocationId,
      actionKey: RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
      actorPrincipalId,
      expectedRevision: 2,
      ownerInvocationId,
      ownerModuleKey,
      portalEnrollmentAttemptId: attemptId,
      tenantId,
      transitionKey,
    } as const;
    let calls = 0;
    const authority = makeCommerceEnrollmentOwnerTransitionPreparationAuthorityForPorts([
      {
        ownerModuleKey,
        prepare: (input) =>
          Effect.sync(() => {
            calls += 1;
            expect(input).toBe(binding);
            return { evidenceRef, outcome: 'prepared' as const };
          }),
        transitionKey,
      },
    ]);
    const prepared = yield* authority.prepare(binding);
    expect(prepared.outcome).toBe('prepared');
    expect(calls).toBe(1);

    const missing = makeCommerceEnrollmentOwnerTransitionPreparationAuthorityForPorts([]);
    const unavailableResult = yield* missing.prepare(binding);
    expect(unavailableResult.outcome).toBe('unavailable');
  }),
);
