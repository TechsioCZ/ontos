import {
  loadDatabaseConnectionPair,
  scopedRoutineInvokerFromTransaction,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';

import { acquirePoolResource } from '../../../../packages/core-runtime/src/db/client.ts';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { CommerceCustomerContextTransaction } from '../../src/database/types.ts';
import type {
  ClaimEnrollmentTransitionInput,
  CommercePortalAccountSubject,
  EnrollmentAttemptSnapshot,
  StartEnrollmentAttemptInput,
} from '../../shared/enrollment-contracts.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentDigestSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentKeySchema,
  EnrollmentLeaseTokenSchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentProviderSubjectIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import { commerceEnrollmentProofServiceForTransaction } from '../../src/enrollment/attempts/enrollment-proof-service.ts';
import { commerceEnrollmentAttemptPersistenceForTransaction } from '../../src/enrollment/attempts/attempt-persistence.ts';
import { commerceEnrollmentAttemptServiceForPersistence } from '../../src/enrollment/attempts/attempt-service.ts';
import type {
  CommerceEnrollmentAttemptReconciliationAuthority,
  CommerceEnrollmentAttemptService,
} from '../../src/enrollment/attempts/attempt-service.ts';
import { CommerceEnrollmentAttemptRejected } from '../../src/enrollment/attempts/errors.ts';
import { commerceEnrollmentCompletionAuthorityForPersistence } from '../../src/enrollment/orchestration/completion.ts';
import {
  OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
  retailSelfEnrollmentJourneyDefinition,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import type {
  AttemptClaimResult,
  AttemptClaimedResult,
  CommerceEnrollmentAttemptPersistence,
} from '../../src/enrollment/attempts/attempt-persistence.ts';
import type { CommerceEnrollmentAttemptError } from '../../src/enrollment/attempts/errors.ts';
import {
  commerceCustomerContextRelations,
  portalEnrollmentAttempts,
  portalEnrollmentOwnerOperations,
} from '../../src/database/schema.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('d6000000-0000-4000-8000-000000000001');
const principalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('d6000000-0000-4000-8000-000000000002');
const ownerModuleKey = Schema.decodeSync(EnrollmentModuleKeySchema)('commerce.portal-auth');
const requestDigest = Schema.decodeSync(EnrollmentDigestSchema)('a'.repeat(64));
const resultDigest = Schema.decodeSync(EnrollmentDigestSchema)('b'.repeat(64));
const subject: CommercePortalAccountSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
  providerSubjectId: Schema.decodeSync(EnrollmentProviderSubjectIdSchema)('provider-enrollment-live-1'),
  subjectType: 'user',
});
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:commerce-enrollment-attempts:run:integration',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'commerce-enrollment-attempts.integration',
};

interface OwnerState extends Record<string, unknown> {
  readonly reconciliation_ref: string | null;
  readonly status: string;
}

interface AttemptState extends Record<string, unknown> {
  readonly revision: number;
  readonly state: string;
}

const one = <Row>(rows: readonly Row[]): Row => {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('Expected one PostgreSQL result row');
  }
  return row;
};

const actionInvocationId = (value: string) => Schema.decodeSync(EnrollmentActionInvocationIdSchema)(value);
const enrollmentKey = (value: string) => Schema.decodeSync(EnrollmentKeySchema)(value);
const enrollmentResourceId = (value: string) => Schema.decodeSync(EnrollmentResourceIdSchema)(value);
const leaseToken = (value: string) => Schema.decodeSync(EnrollmentLeaseTokenSchema)(value);
const transitionKey = (value: string) => Schema.decodeSync(EnrollmentTransitionKeySchema)(value);

const startInput = (intentKey: string, invocationId: string): StartEnrollmentAttemptInput => ({
  actionInvocationId: actionInvocationId(invocationId),
  actorPrincipalId: principalId,
  intentDigest: requestDigest,
  intentKey: enrollmentKey(intentKey),
  journey: 'RETAIL_SELF_ENROLLMENT',
  tenantId,
});

const claimInput = (
  portalEnrollmentAttemptId: EnrollmentAttemptSnapshot['portalEnrollmentAttemptId'],
  expectedRevision: number,
  ownerInvocationId: string,
  transition: string,
  worker: string,
  owner: string = ownerModuleKey,
): ClaimEnrollmentTransitionInput => ({
  accountSubject: subject,
  actorPrincipalId: principalId,
  expectedRevision,
  leaseDurationMs: 1000,
  ownerInvocationId: actionInvocationId(ownerInvocationId),
  ownerModuleKey: Schema.decodeSync(EnrollmentModuleKeySchema)(owner),
  portalEnrollmentAttemptId,
  requestDigest,
  required: true,
  tenantId,
  transitionKey: transitionKey(transition),
  workerId: enrollmentKey(worker),
});

/** One claim for a declared journey transition, against the Attempt's own current revision. */
const journeyClaim = (
  current: EnrollmentAttemptSnapshot,
  transition: JourneyTransitionSpec,
  ownerInvocationId: string,
): ClaimEnrollmentTransitionInput => ({
  ...claimInput(
    current.portalEnrollmentAttemptId,
    current.revision,
    ownerInvocationId,
    transition.transitionKey,
    `worker-${transition.transitionKey}`,
    transition.ownerModuleKey,
  ),
  leaseDurationMs: 30_000,
});

/** Recovery is exercised directly against the routine façade here, never through the service. */
const unusedReconciliationAuthority: CommerceEnrollmentAttemptReconciliationAuthority = {
  resolve: () =>
    Effect.fail(
      new CommerceEnrollmentAttemptRejected({
        code: 'attempt_unavailable',
        reason: 'This acceptance drives reconciliation through the durable routine façade',
        retryable: true,
      }),
    ),
};

const attemptCode = <Value>(effect: Effect.Effect<Value, CommerceEnrollmentAttemptError>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => 'unexpected' }));

/** Every scenario below claims a live transition; a fenced claim would be a different scenario. */
const requireClaimed = (result: AttemptClaimResult): Effect.Effect<AttemptClaimedResult, Error> =>
  result.outcome === 'INDETERMINATE'
    ? Effect.fail(new Error('The durable claim fenced an expired owner transition instead of claiming one'))
    : Effect.succeed(result);

type ClaimRaceResult = { readonly code: string; readonly kind: 'failure' } | { readonly kind: 'success' };

const claimRaceResult = (
  effect: Effect.Effect<AttemptClaimResult, CommerceEnrollmentAttemptError>,
): Effect.Effect<ClaimRaceResult> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ code: error.code, kind: 'failure' as const }),
      onSuccess: () => ({ kind: 'success' as const }),
    }),
  );

const makeTransactionExecutor =
  (transaction: CommerceCustomerContextTransaction) => (statement: Parameters<typeof transaction.execute>[0]) =>
    transaction.execute(statement, 'objects');

/** Every scenario's fixtures are this Tenant's Attempts and owner operations, torn down the same way. */
const cleanupTenantFixtures = (
  admin: Effect.Success<ReturnType<typeof makeTestDatabaseFromPool<typeof commerceCustomerContextRelations>>>,
) =>
  admin.transaction((transaction: CommerceCustomerContextTransaction) =>
    Effect.gen(function* cleanFixtures() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction
        .delete(portalEnrollmentOwnerOperations)
        .where(eq(portalEnrollmentOwnerOperations.tenantId, tenantId));
      yield* transaction.delete(portalEnrollmentAttempts).where(eq(portalEnrollmentAttempts.tenantId, tenantId));
    }),
  );

it.live('proves durable Attempt CAS, expiry fencing, governed recovery, and RLS in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* postgresAcceptance() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* acquirePoolResource(
        () => new Pool({ connectionString: connections.admin.connectionString }),
      );
      const runtimePool = yield* acquirePoolResource(
        () => new Pool({ connectionString: connections.runtime.connectionString, max: 4 }),
      );
      const admin = yield* makeTestDatabaseFromPool(adminPool, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, commerceCustomerContextRelations);

      const cleanup = () => cleanupTenantFixtures(admin);

      const inScope = <Value>(
        operation: (
          persistence: CommerceEnrollmentAttemptPersistence,
          proof: ReturnType<typeof commerceEnrollmentProofServiceForTransaction>,
          service: CommerceEnrollmentAttemptService,
        ) => Effect.Effect<Value, Error>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedAttemptTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            const invoker = scopedRoutineInvokerFromTransaction(makeTransactionExecutor(transaction), scope);
            const persistence = commerceEnrollmentAttemptPersistenceForTransaction(invoker, scope);
            const proof = commerceEnrollmentProofServiceForTransaction(invoker, scope);
            // The deployed Attempt service, including the derived-completion authority: every
            // recorded outcome concludes the Attempt's state from this journey's declaration.
            const service = commerceEnrollmentAttemptServiceForPersistence(
              persistence,
              unusedReconciliationAuthority,
              commerceEnrollmentCompletionAuthorityForPersistence(persistence),
            );
            return yield* operation(persistence, proof, service);
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const created = yield* inScope((persistence) =>
        persistence.create(startInput('durable-enrollment-live', 'd6100000-0000-4000-8000-000000000001')),
      );
      const replayedCreate = yield* inScope((persistence) =>
        persistence.create(startInput('durable-enrollment-live', 'd6100000-0000-4000-8000-000000000002')),
      );
      expect(created.outcome).toBe('CREATED');
      expect(replayedCreate.outcome).toBe('EXISTING');
      expect(replayedCreate.attempt.portalEnrollmentAttemptId).toBe(created.attempt.portalEnrollmentAttemptId);

      const firstClaim = yield* inScope((persistence) =>
        persistence
          .claim(
            claimInput(
              created.attempt.portalEnrollmentAttemptId,
              created.attempt.revision,
              'd6100000-0000-4000-8000-000000000003',
              'provider.account.create',
              'worker-a',
            ),
          )
          .pipe(Effect.flatMap(requireClaimed)),
      );
      yield* admin.transaction((transaction) =>
        Effect.gen(function* extendFixtureLease() {
          yield* transaction.execute(
            sql`
            update commerce_customer_context.portal_enrollment_attempts
               set lease_expires_at = statement_timestamp() + interval '30 seconds'
             where tenant_id = ${tenantId}::uuid
               and portal_enrollment_attempt_id = ${created.attempt.portalEnrollmentAttemptId}::uuid
          `,
            'objects',
          );
          yield* transaction.execute(
            sql`
            update commerce_customer_context.portal_enrollment_owner_operations
               set lease_expires_at = statement_timestamp() + interval '30 seconds'
             where tenant_id = ${tenantId}::uuid
               and portal_enrollment_attempt_id = ${created.attempt.portalEnrollmentAttemptId}::uuid
          `,
            'objects',
          );
        }),
      );
      const busyCode = yield* inScope((persistence) =>
        attemptCode(
          persistence.claim(
            claimInput(
              created.attempt.portalEnrollmentAttemptId,
              firstClaim.attempt.revision,
              'd6100000-0000-4000-8000-000000000004',
              'provider.account.verify',
              'worker-b',
            ),
          ),
        ),
      );
      expect(busyCode).toBe('attempt_lease_conflict');

      yield* admin.transaction((transaction) =>
        Effect.gen(function* expireFixtureLease() {
          yield* transaction.execute(
            sql`
            update commerce_customer_context.portal_enrollment_attempts
               set lease_expires_at = statement_timestamp() - interval '1 second'
             where tenant_id = ${tenantId}::uuid
               and portal_enrollment_attempt_id = ${created.attempt.portalEnrollmentAttemptId}::uuid
          `,
            'objects',
          );
          yield* transaction.execute(
            sql`
            update commerce_customer_context.portal_enrollment_owner_operations
               set lease_expires_at = statement_timestamp() - interval '1 second'
             where tenant_id = ${tenantId}::uuid
               and portal_enrollment_attempt_id = ${created.attempt.portalEnrollmentAttemptId}::uuid
          `,
            'objects',
          );
        }),
      );
      // The fence is reported as a claim outcome, never as a failure: a failure would roll the
      // very transaction back that wrote it, and the durable assertions below would be unreachable.
      const expiredClaim = yield* inScope((persistence) =>
        persistence.claim(
          claimInput(
            created.attempt.portalEnrollmentAttemptId,
            firstClaim.attempt.revision,
            'd6100000-0000-4000-8000-000000000004',
            'provider.account.verify',
            'worker-b',
          ),
        ),
      );
      expect(expiredClaim.outcome).toBe('INDETERMINATE');
      const expiredState = yield* admin.transaction((transaction) =>
        transaction
          .execute<AttemptState>(
            sql`
            select state, revision
              from commerce_customer_context.portal_enrollment_attempts
             where tenant_id = ${tenantId}::uuid
               and portal_enrollment_attempt_id = ${created.attempt.portalEnrollmentAttemptId}::uuid
          `,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      const expiredOwner = yield* admin.transaction((transaction) =>
        transaction
          .execute<OwnerState>(
            sql`
            select status, reconciliation_ref
              from commerce_customer_context.portal_enrollment_owner_operations
             where tenant_id = ${tenantId}::uuid
               and portal_enrollment_attempt_id = ${created.attempt.portalEnrollmentAttemptId}::uuid
               and owner_invocation_id = ${firstClaim.operation.ownerInvocationId}::uuid
          `,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(expiredState.state).toBe('RECONCILIATION_REQUIRED');
      expect(expiredOwner.status).toBe('INDETERMINATE');
      expect(expiredOwner.reconciliation_ref).toBe(null);
      const unseenOperationCount = yield* admin.transaction((transaction) =>
        transaction
          .execute<{ readonly operation_count: string }>(
            sql`
            select count(*)::text as operation_count
              from commerce_customer_context.portal_enrollment_owner_operations
             where tenant_id = ${tenantId}::uuid
               and portal_enrollment_attempt_id = ${created.attempt.portalEnrollmentAttemptId}::uuid
               and transition_key = 'provider.account.verify'
          `,
            'objects',
          )
          .pipe(Effect.map(one)),
      );
      expect(unseenOperationCount.operation_count).toBe('0');

      const staleRecordCode = yield* inScope((persistence) =>
        persistence.read({ portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId, tenantId }).pipe(
          Effect.flatMap((current) =>
            attemptCode(
              persistence.record(
                {
                  accountSubject: subject,
                  actorPrincipalId: principalId,
                  expectedRevision: current.revision,
                  failureCode: enrollmentKey('provider_unknown'),
                  failureReason: 'A stale worker must not resolve an indeterminate provider effect',
                  leaseToken: leaseToken('d6100000-0000-4000-8000-000000000005'),
                  ownerInvocationId: firstClaim.operation.ownerInvocationId,
                  ownerModuleKey,
                  portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
                  status: 'FAILED',
                  tenantId,
                  transitionKey: firstClaim.operation.transitionKey,
                  workerId: enrollmentKey('worker-stale'),
                },
                'IN_PROGRESS',
              ),
            ),
          ),
        ),
      );
      expect(staleRecordCode).toBe('attempt_indeterminate');

      const reconciliationRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)(
        'd6100000-0000-4000-8000-000000000006',
      );
      const reconciled = yield* inScope((persistence) =>
        persistence.read({ portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId, tenantId }).pipe(
          Effect.flatMap((current) =>
            persistence.reconcile(
              {
                accountSubject: subject,
                actorPrincipalId: principalId,
                expectedRevision: current.revision,
                failureCode: enrollmentKey('provider_failed'),
                failureReason: 'The authoritative owner lookup found no provider account',
                nextState: 'IN_PROGRESS',
                outcomeCode: enrollmentKey('provider_reconciled'),
                ownerInvocationId: firstClaim.operation.ownerInvocationId,
                ownerModuleKey,
                portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
                reconciliationRef,
                status: 'FAILED',
                tenantId,
                transitionKey: firstClaim.operation.transitionKey,
              },
              'IN_PROGRESS',
            ),
          ),
        ),
      );
      expect(reconciled.outcome).toBe('RECORDED');
      expect(reconciled.operation.status).toBe('FAILED');
      expect(reconciled.operation.reconciliationRef).toBe(reconciliationRef);

      const retriedClaim = yield* inScope((persistence) =>
        persistence
          .claim(
            claimInput(
              created.attempt.portalEnrollmentAttemptId,
              reconciled.attempt.revision,
              firstClaim.operation.ownerInvocationId,
              'provider.account.create',
              'worker-recovery',
            ),
          )
          .pipe(Effect.flatMap(requireClaimed)),
      );
      expect(retriedClaim.outcome).toBe('CLAIMED');
      const retryLease = retriedClaim.operation.lease;
      if (retryLease === undefined) {
        throw new Error('Expected a lease on the recovered owner transition');
      }

      const proof = yield* inScope((_persistence, proofService) =>
        proofService.verify({
          authenticationNamespaceId: subject.authenticationNamespaceId,
          enrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
          providerSubjectId: subject.providerSubjectId,
          subjectType: subject.subjectType,
          tenantId,
        }),
      );
      expect(proof.policyVersion).toBe('commerce-enrollment-proof.v1');
      expect(proof.enrollmentAttemptId).toBe(created.attempt.portalEnrollmentAttemptId);

      // Provider account creation is only the journey's first required transition.  Recording it
      // through the deployed service proves the Attempt cannot present itself as COMPLETE while
      // the rest of the declared journey has not happened, whatever the owner would like to say.
      const recorded = yield* inScope((_persistence, _proofService, service) =>
        service.recordOutcome({
          accountSubject: subject,
          actorPrincipalId: principalId,
          expectedRevision: retriedClaim.attempt.revision,
          leaseToken: retryLease.leaseToken,
          outcomeCode: enrollmentKey('provider_created'),
          ownerInvocationId: retriedClaim.operation.ownerInvocationId,
          ownerModuleKey,
          portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
          resultDigest,
          resultReference: enrollmentResourceId('provider-account-live-1'),
          status: 'SUCCEEDED',
          tenantId,
          transitionKey: retriedClaim.operation.transitionKey,
          workerId: retryLease.workerId,
        }),
      );
      expect(recorded.attempt.state).toBe('IN_PROGRESS');

      const remainingTransitions = retailSelfEnrollmentJourneyDefinition.requiredTransitions.filter(
        (transition) => transition.transitionKey !== retriedClaim.operation.transitionKey,
      );
      expect(remainingTransitions.length).toBeGreaterThan(0);
      let journeyState = recorded.attempt.state;
      for (const [index, transition] of remainingTransitions.entries()) {
        const ownerInvocation = `d6100000-0000-4000-8000-0000000000${(0x21 + index).toString(16)}`;
        const claimed = yield* inScope((_persistence, _proofService, service) =>
          service.read({ portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId, tenantId }).pipe(
            Effect.flatMap((current) => service.claimTransition(journeyClaim(current, transition, ownerInvocation))),
            Effect.flatMap(requireClaimed),
          ),
        );
        const { lease } = claimed.operation;
        if (lease === undefined) {
          throw new Error('Expected a lease on the claimed journey transition');
        }
        const step = yield* inScope((_persistence, _proofService, service) =>
          service.recordOutcome({
            accountSubject: subject,
            actorPrincipalId: principalId,
            expectedRevision: claimed.attempt.revision,
            leaseToken: lease.leaseToken,
            outcomeCode: enrollmentKey('journey_step_recorded'),
            ownerInvocationId: claimed.operation.ownerInvocationId,
            ownerModuleKey: claimed.operation.ownerModuleKey,
            portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
            resultDigest,
            status: 'SUCCEEDED',
            tenantId,
            transitionKey: claimed.operation.transitionKey,
            workerId: lease.workerId,
          }),
        );
        journeyState = step.attempt.state;
        expect(journeyState).toBe(index === remainingTransitions.length - 1 ? 'COMPLETE' : 'IN_PROGRESS');
      }
      // Only the outcome that proves the journey's last required transition derives COMPLETE.
      expect(journeyState).toBe('COMPLETE');

      const terminalProof = yield* inScope((_persistence, proofService) =>
        proofService
          .verify({
            authenticationNamespaceId: subject.authenticationNamespaceId,
            enrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
            providerSubjectId: subject.providerSubjectId,
            subjectType: subject.subjectType,
            tenantId,
          })
          .pipe(Effect.match({ onFailure: () => 'rejected', onSuccess: () => 'unexpected' })),
      );
      expect(terminalProof).toBe('rejected');

      const concurrentAttempt = yield* inScope((persistence) =>
        persistence.create(startInput('durable-enrollment-concurrent', 'd6100000-0000-4000-8000-000000000007')),
      );
      const concurrentResults = yield* Effect.all(
        [
          inScope((persistence) =>
            claimRaceResult(
              persistence.claim(
                claimInput(
                  concurrentAttempt.attempt.portalEnrollmentAttemptId,
                  concurrentAttempt.attempt.revision,
                  'd6100000-0000-4000-8000-000000000008',
                  'provider.account.create',
                  'worker-concurrent-a',
                ),
              ),
            ),
          ),
          inScope((persistence) =>
            claimRaceResult(
              persistence.claim(
                claimInput(
                  concurrentAttempt.attempt.portalEnrollmentAttemptId,
                  concurrentAttempt.attempt.revision,
                  'd6100000-0000-4000-8000-000000000009',
                  'provider.account.verify',
                  'worker-concurrent-b',
                ),
              ),
            ),
          ),
        ],
        { concurrency: 2 },
      );
      const successfulClaims = concurrentResults.filter((result) => result.kind === 'success');
      const failedClaim = concurrentResults.find((result) => result.kind === 'failure');
      expect(successfulClaims.length).toBe(1);
      if (failedClaim === undefined || failedClaim.kind !== 'failure') {
        throw new Error('Expected one concurrent claim to lose the Attempt revision race');
      }
      expect(failedClaim.code).toBe('attempt_revision_conflict');

      const rawTableResult = yield* Effect.exit(
        runtime.transaction((transaction) =>
          Effect.gen(function* deniedRawTableRead() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            return yield* transaction.execute(
              sql`select portal_enrollment_attempt_id from commerce_customer_context.portal_enrollment_attempts`,
              'objects',
            );
          }),
        ),
      );
      expect(Exit.isFailure(rawTableResult)).toBe(true);
    }),
  ),
);

it.live('reconciles a FAILED owner_reconciliation_required outcome instead of reporting CONFLICT', () =>
  Effect.scoped(
    Effect.gen(function* reconcileOwnerRequiredFailureAcceptance() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* acquirePoolResource(
        () => new Pool({ connectionString: connections.admin.connectionString }),
      );
      const runtimePool = yield* acquirePoolResource(
        () => new Pool({ connectionString: connections.runtime.connectionString, max: 4 }),
      );
      const admin = yield* makeTestDatabaseFromPool(adminPool, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, commerceCustomerContextRelations);

      const cleanup = () => cleanupTenantFixtures(admin);

      const inScope = <Value>(
        operation: (persistence: CommerceEnrollmentAttemptPersistence) => Effect.Effect<Value, Error>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedAttemptTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            const invoker = scopedRoutineInvokerFromTransaction(makeTransactionExecutor(transaction), scope);
            const persistence = commerceEnrollmentAttemptPersistenceForTransaction(invoker, scope);
            return yield* operation(persistence);
          }),
        );

      yield* cleanup();
      yield* Effect.addFinalizer(() => cleanup().pipe(Effect.orDie));

      const created = yield* inScope((persistence) =>
        persistence.create(
          startInput('durable-enrollment-owner-required-failure', 'd6200000-0000-4000-8000-000000000001'),
        ),
      );

      const [transition] = retailSelfEnrollmentJourneyDefinition.requiredTransitions;
      if (transition === undefined) {
        throw new Error('Expected the retail self-enrollment journey to declare at least one required transition');
      }

      const claimed = yield* inScope((persistence) =>
        persistence
          .claim(journeyClaim(created.attempt, transition, 'd6200000-0000-4000-8000-000000000002'))
          .pipe(Effect.flatMap(requireClaimed)),
      );
      const { lease } = claimed.operation;
      if (lease === undefined) {
        throw new Error('Expected a lease on the claimed owner transition');
      }

      // The owner reports "reconcile later" (a Party match style ambiguity): journaled as FAILED
      // with the owner_reconciliation_required failure code, which is the case the new routine
      // makes reconcilable — the fixture the fail-without-fix run exercises against the old body.
      const recorded = yield* inScope((persistence) =>
        persistence.record(
          {
            accountSubject: subject,
            actorPrincipalId: principalId,
            expectedRevision: claimed.attempt.revision,
            failureCode: enrollmentKey(OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE),
            failureReason: 'The owner candidate is ambiguous and must be reconciled',
            leaseToken: lease.leaseToken,
            nextState: 'RECONCILIATION_REQUIRED',
            ownerInvocationId: claimed.operation.ownerInvocationId,
            ownerModuleKey: claimed.operation.ownerModuleKey,
            portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
            status: 'FAILED',
            tenantId,
            transitionKey: claimed.operation.transitionKey,
            workerId: lease.workerId,
          },
          'RECONCILIATION_REQUIRED',
        ),
      );
      expect(recorded.outcome).toBe('RECORDED');
      expect(recorded.attempt.state).toBe('RECONCILIATION_REQUIRED');
      expect(recorded.operation.status).toBe('FAILED');
      expect(recorded.operation.failureCode).toBe(enrollmentKey(OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE));

      // A reconciliation that itself reports the same owner_reconciliation_required failure must
      // not be rejected either, and it must leave the Attempt exactly where it was.
      const repeatedFailureRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)(
        'd6200000-0000-4000-8000-000000000003',
      );
      const stillRequired = yield* inScope((persistence) =>
        persistence.reconcile(
          {
            accountSubject: subject,
            actorPrincipalId: principalId,
            expectedRevision: recorded.attempt.revision,
            failureCode: enrollmentKey(OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE),
            failureReason: 'The owner candidate is still ambiguous',
            ownerInvocationId: claimed.operation.ownerInvocationId,
            ownerModuleKey: claimed.operation.ownerModuleKey,
            portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
            reconciliationRef: repeatedFailureRef,
            status: 'FAILED',
            tenantId,
            transitionKey: claimed.operation.transitionKey,
          },
          'RECONCILIATION_REQUIRED',
        ),
      );
      expect(stillRequired.outcome).toBe('RECORDED');
      expect(stillRequired.attempt.state).toBe('RECONCILIATION_REQUIRED');

      const reconciliationRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)(
        'd6200000-0000-4000-8000-000000000004',
      );
      const reconciled = yield* inScope((persistence) =>
        persistence.reconcile(
          {
            accountSubject: subject,
            actorPrincipalId: principalId,
            expectedRevision: stillRequired.attempt.revision,
            outcomeCode: enrollmentKey('owner_candidate_resolved'),
            ownerInvocationId: claimed.operation.ownerInvocationId,
            ownerModuleKey: claimed.operation.ownerModuleKey,
            portalEnrollmentAttemptId: created.attempt.portalEnrollmentAttemptId,
            reconciliationRef,
            resultReference: enrollmentResourceId('owner-candidate-live-1'),
            status: 'SUCCEEDED',
            tenantId,
            transitionKey: claimed.operation.transitionKey,
          },
          'IN_PROGRESS',
        ),
      );
      expect(reconciled.outcome).toBe('RECORDED');
      expect(reconciled.operation.status).toBe('SUCCEEDED');
      expect(reconciled.attempt.state).not.toBe('RECONCILIATION_REQUIRED');
      expect(reconciled.attempt.state).toBe('IN_PROGRESS');
    }),
  ),
);
