import { Effect, Schema } from 'effect';

import { CounterpartyAccessUnavailable } from '../../../shared/domain/access-error.ts';
import type { CounterpartyAccessDomainError } from '../../../shared/domain/access-error.ts';
import type { CounterpartyAccessInvitation } from '../../../shared/domain/invitation-contract.ts';
import {
  EnrollmentDigestSchema,
  EnrollmentKeySchema,
  EnrollmentResourceIdSchema,
  enrollmentDigest,
} from '../../../shared/enrollment-contracts.ts';
import type {
  EnrollmentEvidenceReferenceSchema,
  ReconcileEnrollmentResolution,
} from '../../../shared/enrollment-contracts.ts';
import {
  decodeOwnerField,
  ownerIndeterminate,
  ownerRejected,
  ownerUnavailable,
} from '../orchestration/owner-effect-codec.ts';
import type {
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerEffectOutcome,
  CommerceEnrollmentOwnerReconciliationInput,
  CommerceEnrollmentOwnerTransition,
} from '../orchestration/owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerEffectError,
  CommerceEnrollmentOwnerEffectUnavailable,
} from '../orchestration/owner-transition-errors.ts';
import type { CounterpartyInvitationClaimDispatchResult } from './counterparty-invitation-claim-gateway.ts';
import { CounterpartyInvitationClaimGateway } from './counterparty-invitation-claim-gateway.ts';

/**
 * Owner effect for the Counterparty invitation claim transition.
 *
 * The claim Action is the grant owner: it stages the invitation's intended Permission mutations
 * inside its own transaction and publishes the authorization-mutation message.  This effect
 * therefore performs exactly one claim and then *reports* what that claim did.  It never issues a
 * second grant loop, never re-stages a Permission, and never compensates: a claim that staged some
 * grants keeps them and projects `RECONCILIATION_REQUIRED`, because undoing a committed grant here
 * would be a fake rollback of somebody else's durable decision.
 *
 * A lost claim response is resolved by `reconcile`, which reads what the exact original owner
 * invocation did.  Two concurrent claims therefore produce one winner and one observer of the
 * winner's result, never two accounts, two bindings or two grant sets.
 */

type EnrollmentKey = typeof EnrollmentKeySchema.Type;
type EnrollmentResourceId = typeof EnrollmentResourceIdSchema.Type;

const unavailable = ownerUnavailable;
const indeterminate = ownerIndeterminate;
const rejected = ownerRejected;

/**
 * A rate-limited claim is deliberately not a durable failure.  The driver never records an
 * unavailable owner effect, so the Attempt keeps its claim open for a governed retry instead of
 * telling a recipient their invitation failed.
 */
const mapClaimFailure = (cause: CounterpartyAccessDomainError): CommerceEnrollmentOwnerEffectError =>
  Schema.is(CounterpartyAccessUnavailable)(cause)
    ? unavailable('invitation_claim_unavailable', cause.reason, cause)
    : rejected(`invitation_claim_${cause.code}`, cause.reason, cause);

const INVALID_RESULT_CODE = 'invitation_claim_invalid_result';

const decodeKey = (
  value: string,
): Effect.Effect<EnrollmentKey, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  decodeOwnerField(EnrollmentKeySchema, value, INVALID_RESULT_CODE, 'The claim owner returned an invalid outcome key');

const decodeResourceId = (
  value: string,
): Effect.Effect<EnrollmentResourceId, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  decodeOwnerField(
    EnrollmentResourceIdSchema,
    value,
    INVALID_RESULT_CODE,
    'The claim owner returned an invalid result reference',
  );

/**
 * Secret-free fingerprint of the exact staged grant progress: one sorted `permission=state` pair
 * per intended Permission.  Two observations of the same partially granted claim produce the same
 * digest, so retained partial progress is provable without republishing grant references.
 */
const grantProgressDigest = (
  invitation: CounterpartyAccessInvitation,
): Effect.Effect<typeof EnrollmentDigestSchema.Type, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> => {
  const canonical = invitation.grantProgress
    .map((progress) => `${progress.permission}=${progress.state}`)
    .toSorted((left, right) => (left < right ? -1 : 1))
    .join('\u0000');
  return Schema.decodeEffect(EnrollmentDigestSchema)(enrollmentDigest(canonical)).pipe(
    Effect.mapError((cause) =>
      unavailable('invitation_claim_invalid_result', 'The claim owner returned invalid grant progress', cause),
    ),
  );
};

/**
 * The Attempt's trusted Actor is the only Principal a claim may be recorded for: the claim Action
 * itself refuses a claimant other than the authenticated Principal, so an invitation held by
 * anybody else must never become this Attempt's success.
 */
const claimIdentityIssue = (
  input: CommerceEnrollmentOwnerTransition,
  invitation: CounterpartyAccessInvitation,
): string | undefined => {
  if (invitation.invitationRef.tenantId !== input.tenantId) {
    return 'The claim owner returned an invitation from a different Tenant';
  }
  const { claimant } = invitation;
  if (claimant === undefined) {
    return 'The claim owner returned an invitation without a claimant';
  }
  return claimant.principalId === input.actorPrincipalId && claimant.tenantId === input.tenantId
    ? undefined
    : 'The invitation is held by a Principal other than the Enrollment Attempt Actor';
};

/**
 * Lifecycle states that mean "the claim committed".  `CLAIMING` and `RECONCILIATION_REQUIRED`
 * carry partial grant progress; they are successes of this transition with a non-terminal
 * projection, never failures, and never `COMPLETE`.
 */
const claimedProjection = (
  invitation: CounterpartyAccessInvitation,
): { readonly nextState?: 'RECONCILIATION_REQUIRED'; readonly outcomeCode: string } | undefined => {
  if (invitation.state === 'CLAIMED') {
    return { outcomeCode: 'invitation_claimed' };
  }
  return invitation.state === 'CLAIMING' || invitation.state === 'RECONCILIATION_REQUIRED'
    ? { nextState: 'RECONCILIATION_REQUIRED', outcomeCode: 'invitation_claim_grants_pending' }
    : undefined;
};

const committedOutcome = Effect.fn('CounterpartyInvitationClaimOwnerEffect.committedOutcome')(
  function* committedOutcomeEffect(
    input: CommerceEnrollmentOwnerTransition,
    invitation: CounterpartyAccessInvitation,
    convergedOutcomeCode?: string,
  ): Effect.fn.Return<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> {
    const identityIssue = claimIdentityIssue(input, invitation);
    if (identityIssue !== undefined) {
      return yield* rejected('invitation_claimant_mismatch', identityIssue);
    }
    const projection = claimedProjection(invitation);
    if (projection === undefined) {
      return yield* indeterminate(
        'invitation_claim_indeterminate',
        'The claim owner reported a committed claim on an invitation that records no claim',
      );
    }
    const { outcomeCode, resultDigest, resultReference } = yield* Effect.all(
      {
        outcomeCode: decodeKey(convergedOutcomeCode ?? projection.outcomeCode),
        resultDigest: grantProgressDigest(invitation),
        resultReference: decodeResourceId(invitation.invitationRef.resourceId),
      },
      { concurrency: 3 },
    );
    return projection.nextState === undefined
      ? { outcomeCode, resultDigest, resultReference, status: 'SUCCEEDED' }
      : { nextState: projection.nextState, outcomeCode, resultDigest, resultReference, status: 'SUCCEEDED' };
  },
);

const dispatchOutcome = Effect.fn('CounterpartyInvitationClaimOwnerEffect.dispatchOutcome')(
  function* dispatchOutcomeEffect(
    input: CommerceEnrollmentOwnerTransition,
    result: CounterpartyInvitationClaimDispatchResult,
  ): Effect.fn.Return<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> {
    if (result.outcome === 'REJECTED') {
      return yield* result.rejection === 'RATE_LIMITED'
        ? unavailable('invitation_rate_limited', 'Invitation claim attempts are temporarily rate limited')
        : rejected(
            `invitation_claim_${result.rejection.toLowerCase()}`,
            'The invitation claim proof was refused by its owner',
          );
    }
    // ALREADY_CLAIMED is the losing side of a concurrent claim: converge on the winner's exact
    // invitation instead of dispatching a second claim or inventing a duplicate grant.
    return yield* committedOutcome(
      input,
      result.invitation,
      result.outcome === 'ALREADY_CLAIMED' ? 'invitation_already_claimed' : undefined,
    );
  },
);

const reconcileResolution = Effect.fn('CounterpartyInvitationClaimOwnerEffect.reconcileResolution')(
  function* reconcileResolutionEffect(
    input: CommerceEnrollmentOwnerReconciliationInput,
    invitation: CounterpartyAccessInvitation,
    evidenceRef: typeof EnrollmentEvidenceReferenceSchema.Type,
  ): Effect.fn.Return<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> {
    const identityIssue = claimIdentityIssue(input, invitation);
    if (identityIssue !== undefined) {
      return yield* rejected('invitation_claimant_mismatch', identityIssue);
    }
    const projection = claimedProjection(invitation);
    if (projection === undefined) {
      return yield* indeterminate(
        'invitation_claim_indeterminate',
        'The exact owner lookup reported a claim the invitation lifecycle does not record',
      );
    }
    const { outcomeCode, resultDigest, resultReference } = yield* Effect.all(
      {
        outcomeCode: decodeKey(
          projection.nextState === undefined ? 'invitation_claim_reconciled' : projection.outcomeCode,
        ),
        resultDigest: grantProgressDigest(invitation),
        resultReference: decodeResourceId(invitation.invitationRef.resourceId),
      },
      { concurrency: 3 },
    );
    const base = {
      actorPrincipalId: input.actorPrincipalId,
      outcomeCode,
      reconciliationRef: evidenceRef,
      resultDigest,
      resultReference,
      status: 'SUCCEEDED',
    } as const;
    return projection.nextState === undefined ? base : { ...base, nextState: projection.nextState };
  },
);

/**
 * Build the claim owner effect from the composed gateway.  It is an `Effect` rather than a plain
 * factory so the owner-private claim transport stays a visible Context requirement that the
 * application root supplies exactly once.
 */
export const counterpartyInvitationClaimOwnerEffect: Effect.Effect<
  CommerceEnrollmentOwnerEffect,
  never,
  CounterpartyInvitationClaimGateway
> = Effect.gen(function* makeCounterpartyInvitationClaimOwnerEffect() {
  const gateway = yield* CounterpartyInvitationClaimGateway;

  const dispatch = Effect.fn('CounterpartyInvitationClaimOwnerEffect.dispatch')(function* dispatchClaim(
    input: CommerceEnrollmentOwnerTransition,
  ): Effect.fn.Return<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> {
    const result = yield* gateway.claim(input).pipe(Effect.mapError(mapClaimFailure));
    return yield* dispatchOutcome(input, result);
  });

  const reconcile = Effect.fn('CounterpartyInvitationClaimOwnerEffect.reconcile')(function* reconcileClaim(
    input: CommerceEnrollmentOwnerReconciliationInput,
  ): Effect.fn.Return<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> {
    const observation = yield* gateway.observe(input).pipe(Effect.mapError(mapClaimFailure));
    if (String(observation.evidenceRef) === String(input.ownerInvocationId)) {
      return yield* unavailable(
        'invitation_claim_reconciliation_unavailable',
        'The claim lookup returned the original owner invocation as its own evidence reference',
      );
    }
    if (observation.outcome === 'NOT_CLAIMED') {
      const { failureCode, outcomeCode } = yield* Effect.all(
        {
          failureCode: decodeKey('invitation_claim_not_found'),
          outcomeCode: decodeKey('invitation_claim_absent'),
        },
        { concurrency: 2 },
      );
      return {
        actorPrincipalId: input.actorPrincipalId,
        failureCode,
        failureReason: 'The exact owner lookup found no committed claim for this owner invocation',
        outcomeCode,
        reconciliationRef: observation.evidenceRef,
        status: 'FAILED',
      };
    }
    return yield* reconcileResolution(input, observation.invitation, observation.evidenceRef);
  });

  return Object.freeze({ dispatch, reconcile });
});
