import {
  loadDatabaseConnectionPair,
  scopedRoutineInvokerFromTransaction,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';

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
import type {
  AttemptClaimResult,
  CommerceEnrollmentAttemptError,
  CommerceEnrollmentAttemptPersistence,
} from '../../src/enrollment/attempts/index.ts';
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
): ClaimEnrollmentTransitionInput => ({
  accountSubject: subject,
  actorPrincipalId: principalId,
  expectedRevision,
  leaseDurationMs: 1000,
  ownerInvocationId: actionInvocationId(ownerInvocationId),
  ownerModuleKey,
  portalEnrollmentAttemptId,
  requestDigest,
  required: true,
  tenantId,
  transitionKey: transitionKey(transition),
  workerId: enrollmentKey(worker),
});

const attemptCode = <Value>(effect: Effect.Effect<Value, CommerceEnrollmentAttemptError>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => 'unexpected' }));

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

it.live('proves durable Attempt CAS, expiry fencing, governed recovery, and RLS in PostgreSQL', () =>
  Effect.scoped(
    Effect.gen(function* postgresAcceptance() {
      const connections = yield* loadDatabaseConnectionPair();
      const adminPool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: connections.admin.connectionString })),
        (pool) => Effect.promise(() => pool.end()).pipe(Effect.orDie),
      );
      const runtimePool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: connections.runtime.connectionString, max: 4 })),
        (pool) => Effect.promise(() => pool.end()).pipe(Effect.orDie),
      );
      const admin = yield* makeTestDatabaseFromPool(adminPool, commerceCustomerContextRelations);
      const runtime = yield* makeTestDatabaseFromPool(runtimePool, commerceCustomerContextRelations);

      const cleanup = () =>
        admin.transaction((transaction) =>
          Effect.gen(function* cleanFixtures() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
            yield* transaction
              .delete(portalEnrollmentOwnerOperations)
              .where(eq(portalEnrollmentOwnerOperations.tenantId, tenantId));
            yield* transaction.delete(portalEnrollmentAttempts).where(eq(portalEnrollmentAttempts.tenantId, tenantId));
          }),
        );

      const inScope = <Value>(
        operation: (
          persistence: CommerceEnrollmentAttemptPersistence,
          proof: ReturnType<typeof commerceEnrollmentProofServiceForTransaction>,
        ) => Effect.Effect<Value, Error>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedAttemptTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            const invoker = scopedRoutineInvokerFromTransaction(makeTransactionExecutor(transaction), scope);
            const persistence = commerceEnrollmentAttemptPersistenceForTransaction(invoker, scope);
            const proof = commerceEnrollmentProofServiceForTransaction(invoker, scope);
            return yield* operation(persistence, proof);
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
        persistence.claim(
          claimInput(
            created.attempt.portalEnrollmentAttemptId,
            created.attempt.revision,
            'd6100000-0000-4000-8000-000000000003',
            'provider.account.create',
            'worker-a',
          ),
        ),
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
      const expiredCode = yield* inScope((persistence) =>
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
      expect(expiredCode).toBe('attempt_indeterminate');
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
              persistence.record({
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
              }),
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
            persistence.reconcile({
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
            }),
          ),
        ),
      );
      expect(reconciled.outcome).toBe('RECORDED');
      expect(reconciled.operation.status).toBe('FAILED');
      expect(reconciled.operation.reconciliationRef).toBe(reconciliationRef);

      const retriedClaim = yield* inScope((persistence) =>
        persistence.claim(
          claimInput(
            created.attempt.portalEnrollmentAttemptId,
            reconciled.attempt.revision,
            firstClaim.operation.ownerInvocationId,
            'provider.account.create',
            'worker-recovery',
          ),
        ),
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

      const recorded = yield* inScope((persistence) =>
        persistence.record({
          accountSubject: subject,
          actorPrincipalId: principalId,
          expectedRevision: retriedClaim.attempt.revision,
          leaseToken: retryLease.leaseToken,
          nextState: 'COMPLETE',
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
      expect(recorded.attempt.state).toBe('COMPLETE');
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
