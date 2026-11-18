import { DateTime, Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommercePortalAuthEnrollmentStartInputSchema } from '../../api/portal-auth/enrollment/contracts.ts';
import { commercePortalAuthEnrollmentCreateAccount } from '../../api/portal-auth/enrollment/http.ts';
import type {
  CommercePortalAuthEnrollmentAccountCreationInput,
  CommercePortalAuthEnrollmentJournal,
} from '../../api/portal-auth/enrollment/http.ts';
import { CommercePortalAuthAccountCreationService } from '../../api/portal-auth/provider/account-create.ts';
import {
  EnrollmentAttemptIdSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentKeySchema,
  EnrollmentLeaseTokenSchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, EnrollmentOwnerOperationSnapshot } from '../../shared/enrollment-contracts.ts';

/**
 * A Retail start retried with its Idempotency-Key never signs up a second account. Core answers the
 * retry's claim with the saved `CLAIMED` of the request that took it and reports the replay, so only
 * that request dispatches the provider call, whether the retry follows a whole lost reply, a lost
 * claim reply, or overlaps the first request while its sign-up is still running.
 */

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('11000000-0000-4000-8000-000000000021');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('22000000-0000-4000-8000-000000000021');
const operationId = Schema.decodeSync(EnrollmentOwnerOperationIdSchema)('33000000-0000-4000-8000-000000000021');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('44000000-0000-4000-8000-000000000021');
const leaseToken = Schema.decodeSync(EnrollmentLeaseTokenSchema)('55000000-0000-4000-8000-000000000021');
const evidenceRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('66000000-0000-4000-8000-000000000021');
const workerId = Schema.decodeSync(EnrollmentKeySchema)('commerce.portal-auth.enrollment-start');
const at = DateTime.makeUnsafe('2026-11-18T10:00:00.000Z');
const leaseExpiresAt = DateTime.makeUnsafe('2099-11-18T10:00:00.000Z');

const startInput = Schema.decodeUnknownSync(CommercePortalAuthEnrollmentStartInputSchema)({
  displayName: 'Enrollment start replay',
  email: 'replayed.person@example.test',
  journey: 'RETAIL_SELF_ENROLLMENT',
  password: Redacted.make('P'.repeat(24)),
  sellingLegalEntityId: '88000000-0000-4000-8000-000000000021',
});
if (startInput.journey === 'EXISTING_ACCOUNT') {
  throw new Error('The replay scenarios start an account-creating journey');
}
const accountCreatingStart = startInput;

/** The Attempt the governed start Action created, before anything is claimed. */
const startedAttempt: EnrollmentAttemptSnapshot = {
  compositionRevision: 'c'.repeat(64),
  createdAt: at,
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'b'.repeat(64),
  intentKey: Schema.decodeSync(EnrollmentKeySchema)('portal-enrollment-start-intent'),
  journey: 'RETAIL_SELF_ENROLLMENT',
  portalEnrollmentAttemptId: attemptId,
  revision: 1,
  state: 'IN_PROGRESS',
  tenantId,
  updatedAt: at,
};

class ClaimReplyLost extends Schema.TaggedError<ClaimReplyLost>()('ClaimReplyLost', {}) {}

/**
 * Core and the owner journal for one Attempt. The claim commits once: it takes the lease and
 * journals the transition `IN_PROGRESS`, and a same-payload retry is answered with that saved reply
 * through `onReplay`. With `loseClaimReply` the first claim commits and its answer is lost.
 */
const makeEnrollment = (options: { readonly loseClaimReply?: boolean } = {}) => {
  let attempt = startedAttempt;
  let operation: EnrollmentOwnerOperationSnapshot | undefined;
  let saved: { readonly hash: string; readonly reply: Effect.Success<ReturnType<Claim>> } | undefined;
  const signUps: string[] = [];
  const replays: string[] = [];
  type Claim = CommercePortalAuthEnrollmentAccountCreationInput<ClaimReplyLost, never>['claimTransition'];
  const claimTransition: Claim = (payload, onReplay) =>
    Effect.gen(function* claimOnce() {
      const hash = JSON.stringify(payload);
      if (saved !== undefined && saved.hash === hash) {
        replays.push(payload.ownerInvocationId);
        yield* onReplay({ invocationId: 'claim-invocation' });
        return saved.reply;
      }
      operation = {
        actorPrincipalId,
        createdAt: at,
        lease: { leaseExpiresAt, leaseToken, workerId },
        ownerInvocationId: payload.ownerInvocationId,
        ownerModuleKey: payload.ownerModuleKey,
        portalEnrollmentAttemptId: attemptId,
        portalEnrollmentOwnerOperationId: operationId,
        requestDigest: payload.requestDigest,
        required: true,
        revision: 1,
        status: 'IN_PROGRESS',
        tenantId,
        transitionKey: payload.transitionKey,
        updatedAt: at,
      };
      attempt = { ...attempt, lease: { leaseExpiresAt, leaseToken, workerId }, revision: attempt.revision + 1 };
      saved = { hash, reply: { attempt, operation, outcome: 'CLAIMED' } };
      if (options.loseClaimReply === true) {
        return yield* new ClaimReplyLost();
      }
      return saved.reply;
    });
  const journal: CommercePortalAuthEnrollmentJournal = {
    read: () => Effect.sync(() => attempt),
    readOwnerOperation: () =>
      operation === undefined ? Effect.die('No transition was claimed') : Effect.succeed(operation),
    recordOutcome: (outcome) =>
      Effect.gen(function* recordOnce() {
        if (operation === undefined || outcome.expectedRevision !== attempt.revision) {
          return yield* Effect.die('The outcome does not match the claimed transition');
        }
        operation = { ...operation, revision: operation.revision + 1, status: outcome.status };
        attempt = { ...attempt, revision: attempt.revision + 1 };
        return { attempt, operation, outcome: 'RECORDED' as const };
      }),
  };
  const run = (duringSignUp?: Effect.Effect<void>) =>
    commercePortalAuthEnrollmentCreateAccount({
      claimTransition,
      journal,
      start: accountCreatingStart,
      started: startedAttempt,
    }).pipe(
      Effect.provideService(CommercePortalAuthAccountCreationService, {
        createAccount: (account) =>
          Effect.gen(function* signUpOnce() {
            signUps.push(account.ownerInvocationId);
            yield* duringSignUp ?? Effect.void;
            return {
              enrollmentAttemptId: attemptId,
              evidenceRef,
              outcome: 'CREATED' as const,
              providerSubjectId: 'portal-user-replay',
              revision: attempt.revision,
            };
          }),
      }),
    );
  return {
    current: () => ({ attempt, operation }),
    replays,
    run,
    signUps,
  };
};

it.effect('a retry after the whole start reply was lost answers the journalled Attempt and signs up nobody', () =>
  Effect.gen(function* wholeReplyLost() {
    const enrollment = makeEnrollment();

    const original = yield* enrollment.run();
    const retry = yield* enrollment.run();

    expect(enrollment.signUps).toHaveLength(1);
    expect(enrollment.replays).toHaveLength(1);
    expect(enrollment.current().operation?.status).toBe('SUCCEEDED');
    expect(retry).toStrictEqual(original);
  }),
);

it.effect('a retry after the claim reply was lost leaves the claim to its owner and signs up nobody', () =>
  Effect.gen(function* claimReplyLost() {
    const enrollment = makeEnrollment({ loseClaimReply: true });

    const lost = yield* Effect.flip(enrollment.run());
    const retry = yield* enrollment.run();

    expect(Schema.is(ClaimReplyLost)(lost)).toBe(true);
    // The claim committed but its request never dispatched: the retry is answered from the journal,
    // and the continuation's owner reconciliation resolves the lapsed transition by its invocation.
    expect(enrollment.signUps).toEqual([]);
    expect(enrollment.replays).toHaveLength(1);
    expect(retry).toStrictEqual(enrollment.current().attempt);
    expect(enrollment.current().operation?.status).toBe('IN_PROGRESS');
  }),
);

it.effect('a retry that overlaps the running sign-up dispatches no second one', () =>
  Effect.gen(function* overlappingRetry() {
    const enrollment = makeEnrollment();
    const overlapping: EnrollmentAttemptSnapshot[] = [];

    const original = yield* enrollment.run(
      enrollment.run().pipe(
        Effect.flatMap((attempt) => Effect.sync(() => overlapping.push(attempt))),
        Effect.asVoid,
        Effect.orDie,
      ),
    );

    expect(enrollment.signUps).toHaveLength(1);
    expect(enrollment.replays).toHaveLength(1);
    // The overlapping retry saw the transition still IN_PROGRESS and left it to the first request.
    expect(overlapping.map((attempt) => attempt.revision)).toEqual([2]);
    expect(original.revision).toBe(3);
    expect(enrollment.current().operation?.status).toBe('SUCCEEDED');
  }),
);
