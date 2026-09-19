import { readFileSync } from 'node:fs';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { commerceEnrollmentAttemptServiceForPersistence } from '../../src/enrollment/attempts/attempt-service.ts';
import type { CommerceEnrollmentAttemptCompletionAuthority } from '../../src/enrollment/attempts/attempt-service.ts';
import type {
  AttemptClaimResult,
  AttemptCreateResult,
  AttemptRecordResult,
  AttemptTerminateResult,
  CommerceEnrollmentAttemptPersistence,
} from '../../src/enrollment/attempts/attempt-persistence.ts';
import {
  CommerceEnrollmentAttemptConflict,
  CommerceEnrollmentAttemptIndeterminate,
} from '../../src/enrollment/attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../../src/enrollment/attempts/errors.ts';
import type {
  ClaimEnrollmentTransitionInput,
  CommercePortalAccountSubject,
  DerivedEnrollmentAttemptState,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
  ReconcileEnrollmentRequest,
  ReconcileEnrollmentResolution,
  RecordEnrollmentOutcomeInput,
  StartEnrollmentAttemptInput,
  TerminateEnrollmentAttemptInput,
} from '../../shared/enrollment-contracts.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentKeySchema,
  EnrollmentLeaseTokenSchema,
  EnrollmentModuleKeySchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentProviderSubjectIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
  RecordEnrollmentOutcomeInputSchema,
} from '../../shared/enrollment-contracts.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('20000000-0000-4000-8000-000000000001');
const invocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('30000000-0000-4000-8000-000000000001');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('40000000-0000-4000-8000-000000000001');
const operationId = Schema.decodeSync(EnrollmentOwnerOperationIdSchema)('50000000-0000-4000-8000-000000000001');
const leaseToken = Schema.decodeSync(EnrollmentLeaseTokenSchema)('60000000-0000-4000-8000-000000000001');
const intentKey = Schema.decodeSync(EnrollmentKeySchema)('portal-intent-1');
const ownerModuleKey = Schema.decodeSync(EnrollmentModuleKeySchema)('commerce.portal-auth');
const transitionKey = Schema.decodeSync(EnrollmentTransitionKeySchema)('provider.account.create');
const workerId = Schema.decodeSync(EnrollmentKeySchema)('worker-1');
const failureCode = Schema.decodeSync(EnrollmentKeySchema)('provider_failed');
const at = DateTime.makeUnsafe('2026-09-16T10:00:00.000Z');
const subject: CommercePortalAccountSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
  providerSubjectId: Schema.decodeSync(EnrollmentProviderSubjectIdSchema)('provider-user-1'),
  subjectType: 'user',
});

const attempt = (overrides: Partial<EnrollmentAttemptSnapshot> = {}): EnrollmentAttemptSnapshot => ({
  createdAt: at,
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'a'.repeat(64),
  intentKey,
  journey: 'RETAIL_SELF_ENROLLMENT',
  portalEnrollmentAttemptId: attemptId,
  revision: 1,
  state: 'IN_PROGRESS',
  tenantId,
  updatedAt: at,
  ...overrides,
});

const operation: EnrollmentOwnerOperationSnapshot = {
  actorPrincipalId,
  createdAt: at,
  ownerInvocationId: invocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  portalEnrollmentOwnerOperationId: operationId,
  requestDigest: 'b'.repeat(64),
  required: true,
  revision: 1,
  status: 'IN_PROGRESS',
  tenantId,
  transitionKey,
  updatedAt: at,
};

const claimInput: ClaimEnrollmentTransitionInput = {
  accountSubject: subject,
  actorPrincipalId,
  expectedRevision: 1,
  leaseDurationMs: 30_000,
  ownerInvocationId: invocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  requestDigest: 'b'.repeat(64),
  required: true,
  tenantId,
  transitionKey,
  workerId,
};

const recordInput: RecordEnrollmentOutcomeInput = {
  accountSubject: subject,
  actorPrincipalId,
  expectedRevision: 2,
  failureCode,
  failureReason: 'The provider rejected the account request',
  leaseToken,
  ownerInvocationId: invocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  status: 'FAILED',
  tenantId,
  transitionKey,
  workerId,
};

const reconciliationResolution: ReconcileEnrollmentResolution = {
  actorPrincipalId,
  reconciliationRef: Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('60000000-0000-4000-8000-000000000002'),
  status: 'FAILED',
};

const reconciliationRequest: ReconcileEnrollmentRequest = {
  expectedRevision: 1,
  ownerInvocationId: invocationId,
  ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  tenantId,
  transitionKey,
};

const makePersistence = (
  overrides: Partial<CommerceEnrollmentAttemptPersistence> = {},
): CommerceEnrollmentAttemptPersistence => {
  const currentAttempt = attempt();
  const currentOperation = operation;
  const createResult: AttemptCreateResult = { attempt: currentAttempt, outcome: 'CREATED' };
  const claimResult: AttemptClaimResult = { attempt: currentAttempt, operation: currentOperation, outcome: 'CLAIMED' };
  const recordResult: AttemptRecordResult = {
    attempt: currentAttempt,
    operation: currentOperation,
    outcome: 'RECORDED',
  };
  const terminateResult: AttemptTerminateResult = { attempt: currentAttempt, outcome: 'TERMINATED' };
  return {
    authorizeAccountCreation: () => Effect.succeed({ evidenceRef: operationId, revision: currentAttempt.revision }),
    claim: () => Effect.succeed(claimResult),
    create: (_input: StartEnrollmentAttemptInput) => Effect.succeed(createResult),
    read: () => Effect.succeed(currentAttempt),
    readOperation: () => Effect.succeed(currentOperation),
    readOperations: () => Effect.succeed([currentOperation]),
    reconcile: (_input) => Effect.succeed(recordResult),
    record: (_input: RecordEnrollmentOutcomeInput) => Effect.succeed(recordResult),
    terminate: (_input: TerminateEnrollmentAttemptInput) => Effect.succeed(terminateResult),
    ...overrides,
  };
};

const reconciliationAuthority = {
  resolve: () => Effect.succeed(reconciliationResolution),
};

/**
 * The Attempt store never decides completion itself: it asks the installed authority.  These tests
 * therefore stand in for that authority and assert what the store does with the answer.
 */
const completionAuthority = (
  derivedState: DerivedEnrollmentAttemptState = 'IN_PROGRESS',
): CommerceEnrollmentAttemptCompletionAuthority => ({ derive: () => Effect.succeed(derivedState) });

const errorCode = (effect: Effect.Effect<unknown, CommerceEnrollmentAttemptError>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => 'unexpected' }));

it.effect('requires the owner reconciliation authority before persisting a resolution', () =>
  Effect.gen(function* requireAuthority() {
    let authorityCalls = 0;
    let persistedReconciliationRef: ReconcileEnrollmentResolution['reconciliationRef'] | undefined;
    let persistedSubject: CommercePortalAccountSubject | undefined;
    let persistedSubjectProperty = false;
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        read: () => Effect.succeed(attempt({ state: 'RECONCILIATION_REQUIRED' })),
        reconcile: (input) => {
          persistedReconciliationRef = input.reconciliationRef;
          persistedSubject = input.accountSubject;
          persistedSubjectProperty = Object.hasOwn(input, 'accountSubject');
          return Effect.succeed({ attempt: attempt(), operation, outcome: 'RECORDED' as const });
        },
      }),
      {
        resolve: (input) => {
          authorityCalls += 1;
          expect(input.ownerInvocationId).toBe(invocationId);
          return Effect.succeed(reconciliationResolution);
        },
      },
      completionAuthority(),
    );
    const result = yield* service.reconcileOutcome(reconciliationRequest);
    expect(result.outcome).toBe('RECORDED');
    expect(authorityCalls).toBe(1);
    expect(persistedReconciliationRef).toBe(reconciliationResolution.reconciliationRef);
    expect(persistedSubject).toBeUndefined();
    expect(persistedSubjectProperty).toBe(false);
  }),
);

it.effect('derives a previously unknown subject only from the trusted owner resolution', () =>
  Effect.gen(function* deriveTrustedSubject() {
    let persistedSubject: CommercePortalAccountSubject | undefined;
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        read: () => Effect.succeed(attempt()),
        reconcile: (input) => {
          persistedSubject = input.accountSubject;
          return Effect.succeed({
            attempt: attempt({ accountSubject: subject }),
            operation,
            outcome: 'RECORDED' as const,
          });
        },
      }),
      {
        resolve: () => Effect.succeed({ ...reconciliationResolution, accountSubject: subject }),
      },
      completionAuthority(),
    );
    const result = yield* service.reconcileOutcome(reconciliationRequest);
    expect(result.outcome).toBe('RECORDED');
    expect(persistedSubject).toEqual(subject);
  }),
);

it.effect('rejects a requested subject that is outside the trusted reconciliation boundary', () =>
  Effect.gen(function* rejectUntrustedSubject() {
    let authorityCalls = 0;
    let persistedCalls = 0;
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        reconcile: (_input) => {
          persistedCalls += 1;
          return Effect.succeed({ attempt: attempt(), operation, outcome: 'RECORDED' as const });
        },
      }),
      {
        resolve: () => {
          authorityCalls += 1;
          return Effect.succeed(reconciliationResolution);
        },
      },
      completionAuthority(),
    );
    const untrustedRequest = {
      ...reconciliationRequest,
      accountSubject: subject,
    };
    // Keep the extra field on a variable so the runtime decoder, rather than TypeScript's excess-property check, enforces the boundary.
    const code = yield* errorCode(service.reconcileOutcome(untrustedRequest));
    expect(code).toBe('attempt_invalid');
    expect(authorityCalls).toBe(0);
    expect(persistedCalls).toBe(0);
  }),
);

it.effect('rejects a trusted resolution that conflicts with the immutable Attempt subject', () =>
  Effect.gen(function* rejectAuthoritativeSubjectConflict() {
    let persistedCalls = 0;
    const conflictingSubject: CommercePortalAccountSubject = {
      ...subject,
      providerSubjectId: Schema.decodeSync(EnrollmentProviderSubjectIdSchema)('provider-user-2'),
    };
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        read: () => Effect.succeed(attempt({ accountSubject: subject })),
        reconcile: (_input) => {
          persistedCalls += 1;
          return Effect.succeed({ attempt: attempt(), operation, outcome: 'RECORDED' as const });
        },
      }),
      {
        resolve: () => Effect.succeed({ ...reconciliationResolution, accountSubject: conflictingSubject }),
      },
      completionAuthority(),
    );
    const code = yield* errorCode(service.reconcileOutcome(reconciliationRequest));
    expect(code).toBe('attempt_conflict');
    expect(persistedCalls).toBe(0);
  }),
);

it.effect('does not persist when the trusted owner reconciliation fails', () =>
  Effect.gen(function* rejectAuthorityFailure() {
    let persistedCalls = 0;
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        reconcile: (_input) => {
          persistedCalls += 1;
          return Effect.succeed({ attempt: attempt(), operation, outcome: 'RECORDED' as const });
        },
      }),
      {
        resolve: () =>
          Effect.fail(
            new CommerceEnrollmentAttemptConflict({
              code: 'attempt_conflict',
              reason: 'The owner authority could not resolve the original provider invocation',
              retryable: false,
            }),
          ),
      },
      completionAuthority(),
    );
    const code = yield* errorCode(service.reconcileOutcome(reconciliationRequest));
    expect(code).toBe('attempt_conflict');
    expect(persistedCalls).toBe(0);
  }),
);

it.effect('rejects transition claims after a terminal Attempt before invoking the owner routine', () =>
  Effect.gen(function* rejectTerminalClaim() {
    let claimCalls = 0;
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        claim: () => {
          claimCalls += 1;
          return Effect.succeed({ attempt: attempt(), operation, outcome: 'CLAIMED' });
        },
        read: () => Effect.succeed(attempt({ revision: 4, state: 'TERMINATED', terminatedAt: at })),
      }),
      reconciliationAuthority,
      completionAuthority(),
    );
    const code = yield* errorCode(service.claimTransition(claimInput));
    expect(code).toBe('attempt_terminal');
    expect(claimCalls).toBe(0);
  }),
);

it.effect('rejects a provider subject that differs from the immutable Attempt subject', () =>
  Effect.gen(function* rejectSubjectConflict() {
    let claimCalls = 0;
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        claim: () => {
          claimCalls += 1;
          return Effect.succeed({ attempt: attempt(), operation, outcome: 'CLAIMED' });
        },
        read: () => Effect.succeed(attempt({ accountSubject: subject })),
      }),
      reconciliationAuthority,
      completionAuthority(),
    );
    const code = yield* errorCode(
      service.claimTransition({
        ...claimInput,
        accountSubject: {
          ...subject,
          providerSubjectId: Schema.decodeSync(EnrollmentProviderSubjectIdSchema)('provider-user-2'),
        },
      }),
    );
    expect(code).toBe('attempt_conflict');
    expect(claimCalls).toBe(0);
  }),
);

it('does not allow an owner outcome to claim COMPLETE', () => {
  // COMPLETE is not in the owner outcome vocabulary at all: a request that names it is not a
  // request this boundary can even express, so no owner outcome can be journalled from one.
  expect(Schema.is(RecordEnrollmentOutcomeInputSchema)({ ...recordInput, nextState: 'COMPLETE' })).toBe(false);
  expect(Schema.is(RecordEnrollmentOutcomeInputSchema)({ ...recordInput, nextState: 'RECONCILIATION_REQUIRED' })).toBe(
    true,
  );
});

it.effect('journals the derived Attempt state rather than anything the owner supplied', () =>
  Effect.gen(function* persistDerivedState() {
    let persistedState: DerivedEnrollmentAttemptState | undefined;
    let observedSignal: string | undefined;
    let observedStatus: string | undefined;
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        record: (_input, derivedState) => {
          persistedState = derivedState;
          return Effect.succeed({ attempt: attempt(), operation, outcome: 'RECORDED' as const });
        },
      }),
      reconciliationAuthority,
      {
        derive: (_attempt, outcome) => {
          observedSignal = outcome.signal;
          observedStatus = outcome.status;
          return Effect.succeed('COMPLETE' as const);
        },
      },
    );
    const result = yield* service.recordOutcome({
      ...recordInput,
      nextState: 'VERIFICATION_REQUIRED',
      status: 'SUCCEEDED',
    });
    expect(result.outcome).toBe('RECORDED');
    // The owner's own signal reaches the derivation as evidence, never the durable routine as a state.
    expect(observedSignal).toBe('VERIFICATION_REQUIRED');
    expect(observedStatus).toBe('SUCCEEDED');
    expect(persistedState).toBe('COMPLETE');
  }),
);

it.effect('journals the derived Attempt state for a governed reconciliation too', () =>
  Effect.gen(function* persistDerivedReconciliationState() {
    let persistedState: DerivedEnrollmentAttemptState | undefined;
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        reconcile: (_input, derivedState) => {
          persistedState = derivedState;
          return Effect.succeed({ attempt: attempt(), operation, outcome: 'RECORDED' as const });
        },
      }),
      reconciliationAuthority,
      completionAuthority('RECONCILIATION_REQUIRED'),
    );
    const result = yield* service.reconcileOutcome(reconciliationRequest);
    expect(result.outcome).toBe('RECORDED');
    expect(persistedState).toBe('RECONCILIATION_REQUIRED');
  }),
);

it.effect('does not journal an outcome when completion cannot be derived', () =>
  Effect.gen(function* rejectUndecidableCompletion() {
    let recordCalls = 0;
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        record: () => {
          recordCalls += 1;
          return Effect.succeed({ attempt: attempt(), operation, outcome: 'RECORDED' as const });
        },
      }),
      reconciliationAuthority,
      {
        derive: () =>
          Effect.fail(
            new CommerceEnrollmentAttemptConflict({
              attemptId,
              code: 'attempt_conflict',
              reason: 'The Attempt journey does not declare the transition this outcome belongs to',
              retryable: false,
            }),
          ),
      },
    );
    const code = yield* errorCode(service.recordOutcome(recordInput));
    expect(code).toBe('attempt_conflict');
    expect(recordCalls).toBe(0);
  }),
);

it.effect('surfaces indeterminate owner outcomes so callers cannot retry blindly', () =>
  Effect.gen(function* preserveIndeterminateOutcome() {
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        claim: () =>
          Effect.fail(
            new CommerceEnrollmentAttemptIndeterminate({
              attemptId,
              code: 'attempt_indeterminate',
              ownerInvocationId: invocationId,
              reason: 'Provider effect may have committed; reconcile the exact invocation first',
              retryable: true,
            }),
          ),
      }),
      reconciliationAuthority,
      completionAuthority(),
    );
    const code = yield* errorCode(service.claimTransition(claimInput));
    expect(code).toBe('attempt_indeterminate');
  }),
);

it.effect('propagates a durable outcome conflict without fabricating a successful journal result', () =>
  Effect.gen(function* preserveOutcomeConflict() {
    const service = commerceEnrollmentAttemptServiceForPersistence(
      makePersistence({
        record: () =>
          Effect.fail(
            new CommerceEnrollmentAttemptConflict({
              attemptId,
              code: 'attempt_conflict',
              reason: 'The outcome metadata conflicts with its durable journal entry',
              retryable: false,
            }),
          ),
      }),
      reconciliationAuthority,
      completionAuthority(),
    );
    const code = yield* errorCode(service.recordOutcome(recordInput));
    expect(code).toBe('attempt_conflict');
  }),
);

it('checks in the durable Attempt fences and secret-free owner routines', () => {
  const migration = readFileSync(
    new URL('../../drizzle/20260916133538_third_midnight/migration.sql', import.meta.url),
    'utf-8',
  );
  for (const table of ['portal_enrollment_attempts', 'portal_enrollment_owner_operations']) {
    expect(migration).toContain(`ALTER TABLE "commerce_customer_context"."${table}" FORCE ROW LEVEL SECURITY;`);
    expect(migration).toContain(
      `REVOKE ALL ON TABLE "commerce_customer_context"."${table}" FROM PUBLIC, "ontos_runtime";`,
    );
  }
  expect(migration).toContain('UNIQUE("tenant_id", "intent_key")');
  expect(migration).toContain('ccc_portal_enrollment_attempts_identity_guard');
  expect(migration).toContain('ccc_portal_enrollment_owner_operations_identity_guard');
  expect(migration).toContain('owner lease duration is outside the supported range');
  expect(migration).toContain('unsupported Commerce authentication namespace');
  expect(migration).toContain("'SUBJECT_CONFLICT'");
  expect(migration).toContain('current_attempt.revision <> p_expected_revision');
  expect(migration).toContain('current_operation.lease_token IS DISTINCT FROM p_lease_token');
  expect(migration).toContain("current_attempt.state IN ('COMPLETE', 'TERMINATED')");
  expect(migration).toContain("current_attempt.state = 'RECONCILIATION_REQUIRED'");
  expect(migration).toContain("ELSIF p_next_state = 'COMPLETE'");
  expect(migration).toContain("failure_code = 'attempt_lease_expired'");
  expect(migration).toContain("ELSIF current_operation.status = 'SUCCEEDED'");
  expect(migration).toContain('invalid owner outcome next state');
  expect(migration).toContain('completed_at = NULL');
  expect(migration).toContain("'INDETERMINATE'");
  expect(migration).toContain('CREATE FUNCTION "commerce_customer_context"."reconcile_portal_enrollment_outcome"');
  expect(migration).toContain('p_reconciliation_ref');
  expect(migration).toContain('The owner lease expired before a final outcome was recorded');
  expect(migration).toContain('current_operation.owner_invocation_id IS DISTINCT FROM p_owner_invocation_id');
  expect(migration).toContain('attempt.lease_expires_at > statement_timestamp()');
  expect(migration).not.toContain('"password"');
  expect(migration).not.toContain('"session_token"');
  expect(migration).not.toContain('"credential"');
  for (const routine of [
    'create_portal_enrollment_attempt',
    'claim_portal_enrollment_transition',
    'record_portal_enrollment_outcome',
    'terminate_portal_enrollment',
  ]) {
    expect(migration).toContain(`CREATE FUNCTION "commerce_customer_context"."${routine}"`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION "commerce_customer_context"."${routine}"`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION "commerce_customer_context"."${routine}"`);
  }
});
