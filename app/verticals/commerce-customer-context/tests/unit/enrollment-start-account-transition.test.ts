import { DateTime, Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommercePortalAuthEnrollmentStartInputSchema } from '../../api/portal-auth/enrollment/contracts.ts';
import {
  commercePortalAuthEnrollmentAccountCreationOutcome,
  commercePortalAuthEnrollmentDispatchesAccountCreation,
  commercePortalAuthEnrollmentReadableBy,
} from '../../api/portal-auth/enrollment/http.ts';
import { commercePortalAuthEnrollmentAccountCreationClaim } from '../../api/portal-auth/enrollment/intent.ts';
import type { CommercePortalAuthEnrollmentAccountCreationClaim } from '../../api/portal-auth/enrollment/intent.ts';
import type { CommercePortalAccountCreateResult } from '../../api/portal-auth/provider/account-create.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentKeySchema,
  EnrollmentLeaseTokenSchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, EnrollmentOwnerOperationSnapshot } from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';

/**
 * What the enrollment start route owes the Attempt journal once its one provider effect has run,
 * and who may read an Attempt back.
 *
 * The provider call is the only step of an enrollment that cannot be replayed, so the outcome that
 * records it must be bound to the exact claim PostgreSQL committed — its lease, its worker and its
 * Actor — and must carry the created subject, which is the only handle a later reconciliation has
 * on the account. These scenarios pin that binding, the guard that keeps a replayed start from
 * dispatching a second account, and the Principal scoping of the read.
 */

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('11000000-0000-4000-8000-000000000001');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('22000000-0000-4000-8000-000000000001');
const operationId = Schema.decodeSync(EnrollmentOwnerOperationIdSchema)('33000000-0000-4000-8000-000000000001');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('44000000-0000-4000-8000-000000000001');
const otherPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('44000000-0000-4000-8000-000000000002');
const leaseToken = Schema.decodeSync(EnrollmentLeaseTokenSchema)('55000000-0000-4000-8000-000000000001');
const evidenceRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('66000000-0000-4000-8000-000000000001');
const otherInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('77000000-0000-4000-8000-000000000001');
const workerId = Schema.decodeSync(EnrollmentKeySchema)('commerce.portal-auth.enrollment-start');
const at = DateTime.makeUnsafe('2026-09-17T10:00:00.000Z');
const leaseExpiresAt = DateTime.makeUnsafe('2099-09-17T10:00:00.000Z');
const PROVIDER_SUBJECT_ID = 'portal-user-start-route';

const startInput = Schema.decodeUnknownSync(CommercePortalAuthEnrollmentStartInputSchema)({
  displayName: 'Enrollment start account transition',
  email: 'first.person@example.test',
  journey: 'RETAIL_SELF_ENROLLMENT',
  // The credential is `Redacted` from the transport boundary inward; nothing below ever sees it.
  password: Redacted.make('P'.repeat(24)),
  sellingLegalEntityId: '88000000-0000-4000-8000-000000000001',
});

/** The very claim the route mints for the one owner transition a start dispatches. */
const claimFor = () => commercePortalAuthEnrollmentAccountCreationClaim(startInput, attemptId);

const attempt = (overrides: Partial<EnrollmentAttemptSnapshot> = {}): EnrollmentAttemptSnapshot => ({
  createdAt: at,
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'b'.repeat(64),
  intentKey: Schema.decodeSync(EnrollmentKeySchema)('portal-enrollment-start-intent'),
  journey: 'RETAIL_SELF_ENROLLMENT',
  lease: { leaseExpiresAt, leaseToken, workerId },
  portalEnrollmentAttemptId: attemptId,
  revision: 2,
  state: 'IN_PROGRESS',
  tenantId,
  updatedAt: at,
  ...overrides,
});

/** The durable owner operation the claim routine commits, without its lease. */
const unleasedOperation = (
  claim: CommercePortalAuthEnrollmentAccountCreationClaim,
  overrides: Partial<EnrollmentOwnerOperationSnapshot> = {},
): EnrollmentOwnerOperationSnapshot => ({
  actorPrincipalId,
  createdAt: at,
  ownerInvocationId: claim.ownerInvocationId,
  ownerModuleKey: claim.ownerModuleKey,
  portalEnrollmentAttemptId: attemptId,
  portalEnrollmentOwnerOperationId: operationId,
  requestDigest: claim.requestDigest,
  required: true,
  revision: 1,
  status: 'IN_PROGRESS',
  tenantId,
  transitionKey: claim.transitionKey,
  updatedAt: at,
  ...overrides,
});

const operation = (
  claim: CommercePortalAuthEnrollmentAccountCreationClaim,
  overrides: Partial<EnrollmentOwnerOperationSnapshot> = {},
): EnrollmentOwnerOperationSnapshot => ({
  ...unleasedOperation(claim),
  lease: { leaseExpiresAt, leaseToken, workerId },
  ...overrides,
});

/** What the private two-party capability answers the route with after one Better Auth sign-up. */
const created = (overrides: Partial<CommercePortalAccountCreateResult> = {}): CommercePortalAccountCreateResult => ({
  enrollmentAttemptId: attemptId,
  evidenceRef,
  outcome: 'CREATED',
  providerSubjectId: PROVIDER_SUBJECT_ID,
  revision: 2,
  ...overrides,
});

it.effect('the recorded outcome binds the created account to the claim PostgreSQL committed', () =>
  Effect.gen(function* recordedOutcomeBindsTheClaim() {
    const claim = yield* claimFor();

    const outcome = yield* commercePortalAuthEnrollmentAccountCreationOutcome(
      claim,
      attempt(),
      operation(claim),
      created(),
    );

    // The subject is what makes the account nameable: without it completion cannot derive and a
    // reconciliation has nothing to correlate the provider effect by. Everything else is the
    // durable claim's own identity, so no request-derived value can record an outcome.
    expect(outcome.accountSubject).toStrictEqual({
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      providerSubjectId: PROVIDER_SUBJECT_ID,
      subjectType: 'user',
    });
    expect(outcome.status).toBe('SUCCEEDED');
    expect(outcome.actorPrincipalId).toBe(actorPrincipalId);
    expect(outcome.leaseToken).toBe(leaseToken);
    expect(outcome.workerId).toBe(workerId);
    expect(outcome.expectedRevision).toBe(2);
    expect(outcome.ownerInvocationId).toBe(claim.ownerInvocationId);
    expect(outcome.ownerModuleKey).toBe(claim.ownerModuleKey);
    expect(outcome.transitionKey).toBe(claim.transitionKey);
    expect(outcome.outcomeCode).toBe('provider_account_created');
    expect(outcome.resultReference).toBe(evidenceRef);
  }),
);

it.effect('a provider answer about another Attempt or another revision is never recorded', () =>
  Effect.gen(function* foreignProviderAnswerIsRefused() {
    const claim = yield* claimFor();
    const otherAttemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('22000000-0000-4000-8000-000000000002');

    const named = yield* Effect.flip(
      commercePortalAuthEnrollmentAccountCreationOutcome(
        claim,
        attempt(),
        operation(claim),
        created({ enrollmentAttemptId: otherAttemptId }),
      ),
    );
    // The capability answers about the exact revision its own durable authorization read, so a
    // result observed at a different one cannot be attributed to the claim held here.
    const stale = yield* Effect.flip(
      commercePortalAuthEnrollmentAccountCreationOutcome(claim, attempt(), operation(claim), created({ revision: 3 })),
    );
    // A claim without its lease token cannot be recorded under the fence that authorized the call.
    const unleased = yield* Effect.flip(
      commercePortalAuthEnrollmentAccountCreationOutcome(claim, attempt(), unleasedOperation(claim), created()),
    );

    // All three are the retryable 503: the Attempt keeps its claim and is resolved by the owner's
    // own reconciliation rather than by a second provider call.
    expect([named.code, stale.code, unleased.code]).toStrictEqual([
      'enrollment_unavailable',
      'enrollment_unavailable',
      'enrollment_unavailable',
    ]);
    expect([named.status, stale.status, unleased.status]).toStrictEqual([503, 503, 503]);
  }),
);

it.effect('a start whose transition is already recorded dispatches no second account', () =>
  Effect.gen(function* replayedStartDispatchesNothing() {
    const claim = yield* claimFor();

    // A governed Action replays a recorded result verbatim, so a retry presenting the same
    // Idempotency-Key is handed the same `CLAIMED` answer as the request that already created the
    // account. Only the durable journal separates them.
    expect(commercePortalAuthEnrollmentDispatchesAccountCreation(operation(claim), claim)).toBe(true);
    expect(
      commercePortalAuthEnrollmentDispatchesAccountCreation(operation(claim, { status: 'SUCCEEDED' }), claim),
    ).toBe(false);
    expect(commercePortalAuthEnrollmentDispatchesAccountCreation(operation(claim, { status: 'FAILED' }), claim)).toBe(
      false,
    );
    // A transition another invocation holds is that invocation's to complete, never this one's.
    expect(
      commercePortalAuthEnrollmentDispatchesAccountCreation(
        operation(claim, { ownerInvocationId: otherInvocationId }),
        claim,
      ),
    ).toBe(false);
  }),
);

it('only the Principal that started an Attempt may read it back', () => {
  const started = attempt();

  // Both Principals are in the Tenant the durable read is already scoped to, so the Tenant scope
  // cannot separate them: the Attempt belongs to the person who started it, and a caller holding
  // its id learns nothing else. Dropping this check publishes one customer's journey, invitation
  // and target Legal Entity to every other customer of the same Tenant.
  expect(commercePortalAuthEnrollmentReadableBy(started, actorPrincipalId)).toBe(true);
  expect(commercePortalAuthEnrollmentReadableBy(started, otherPrincipalId)).toBe(false);
});
