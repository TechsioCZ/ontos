import { PartyCommandNotFoundProblemSchema } from '@app/party-registry/api';
import { createParty, executePartyMatch, recoverPartyCreate } from '@app/party-registry/api/client';
import { Effect, Match, Option, Schema } from 'effect';

import type { ReconcileEnrollmentResolution } from '../../../shared/enrollment-contracts.ts';
import {
  decodeOwnerOutcome,
  decodeOwnerResolution,
  ownerRejected,
  ownerUnavailable,
} from '../orchestration/owner-effect-codec.ts';
import type { OwnerOutcomeDraft, OwnerResolutionDraft } from '../orchestration/owner-effect-codec.ts';
import type {
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerEffectOutcome,
  CommerceEnrollmentOwnerReconciliationInput,
  CommerceEnrollmentOwnerTransition,
} from '../orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerEffectError } from '../orchestration/owner-transition-errors.ts';
import {
  OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
  PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE,
  PARTY_CANDIDATE_CREATED_OUTCOME_CODE,
  PARTY_CANDIDATE_MATCHED_OUTCOME_CODE,
  retailSelfEnrollmentEvidenceReference,
} from './retail-self-enrollment-contracts.ts';

/**
 * Party Registry candidate submission as one Retail self-enrollment owner transition. A Party is
 * created only on `NO_MATCH`; an `AMBIGUOUS` outcome is a typed non-terminal halt, so the adapter
 * never picks a Party, widens a match, or infers ownership from an email or a Guest order.
 *
 * Reconciliation reads what the immutable original invocation committed; a still-open commit is
 * rejected for a later retry rather than resubmitting a Create. A submission that never reached the
 * Create at all — the match is the first call and it can be unavailable on its own — leaves the
 * Party Registry with no invocation of that identity, and that absence is what lets reconciliation
 * run the read-only match again instead of waiting forever for a Create that was never dispatched.
 */

type PartyMatchInvocation = Parameters<typeof executePartyMatch>;
type PartyCandidate = PartyMatchInvocation[0]['candidate'];
type PartyMatchResponse = Effect.Success<ReturnType<typeof executePartyMatch>>;
type PartyMatchError = Effect.Error<ReturnType<typeof executePartyMatch>>;
type PartyCreateResponse = Effect.Success<ReturnType<typeof createParty>>;
type PartyCreateError = Effect.Error<ReturnType<typeof createParty>>;
type PartyRecoveryResponse = Effect.Success<ReturnType<typeof recoverPartyCreate>>;
type PartyRecoveryError = Effect.Error<ReturnType<typeof recoverPartyCreate>>;

export interface RetailPartyCandidateOwnerExecutors {
  readonly createParty: (
    payload: Parameters<typeof createParty>[0],
    options: Parameters<typeof createParty>[1],
  ) => Effect.Effect<PartyCreateResponse, PartyCreateError>;
  readonly matchParty: (
    payload: PartyMatchInvocation[0],
    requestCorrelation: string,
  ) => Effect.Effect<PartyMatchResponse, PartyMatchError>;
  readonly recoverPartyCreate: (
    payload: Parameters<typeof recoverPartyCreate>[0],
    options: Parameters<typeof recoverPartyCreate>[1],
  ) => Effect.Effect<PartyRecoveryResponse, PartyRecoveryError>;
}

export interface RetailPartyCandidateOwnerInput {
  /** The exact Party candidate submitted for this Attempt.  It never enters a Commerce digest. */
  readonly candidate: PartyCandidate;
  readonly requestCorrelation: string;
  readonly tenantId: string;
}

const matchPartyExecutor: RetailPartyCandidateOwnerExecutors['matchParty'] = (payload, requestCorrelation) =>
  executePartyMatch(payload, requestCorrelation);

/** Production executors over the published Party Registry client, for application composition. */
export const retailPartyCandidateOwnerExecutors: RetailPartyCandidateOwnerExecutors = Object.freeze({
  createParty,
  matchParty: matchPartyExecutor,
  recoverPartyCreate,
});

/** The journey's reading of one Party Registry result, before it becomes an Attempt outcome. */
type PartyVerdict =
  | { readonly kind: 'RESOLVED'; readonly outcomeCode: string; readonly partyResourceId: string }
  | { readonly kind: 'AMBIGUOUS'; readonly reason: string };

const PARTY_REGISTRY_UNAVAILABLE_CODE = 'party_registry_unavailable';

const unavailable = (reason: string, cause?: unknown) =>
  ownerUnavailable(PARTY_REGISTRY_UNAVAILABLE_CODE, reason, cause);

const decodeOutcome = (
  candidate: OwnerOutcomeDraft,
): Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> =>
  decodeOwnerOutcome(candidate, PARTY_REGISTRY_UNAVAILABLE_CODE, 'The Party Registry outcome is not representable');

const decodeResolution = (
  candidate: OwnerResolutionDraft,
): Effect.Effect<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> =>
  decodeOwnerResolution(
    candidate,
    PARTY_REGISTRY_UNAVAILABLE_CODE,
    'The Party reconciliation result is not representable',
  );

const outcomeOf = (
  verdict: PartyVerdict,
): Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> =>
  verdict.kind === 'RESOLVED'
    ? decodeOutcome({
        outcomeCode: verdict.outcomeCode,
        resultReference: verdict.partyResourceId,
        status: 'SUCCEEDED',
      })
    : decodeOutcome({
        failureCode: OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
        failureReason: verdict.reason.slice(0, 500),
        nextState: 'RECONCILIATION_REQUIRED',
        outcomeCode: PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE,
        status: 'FAILED',
      });

const soleSameTenantParty = (
  candidateParties: PartyMatchResponse['candidateParties'],
  tenantId: string,
): string | undefined => {
  const scoped = candidateParties.filter((partyRef) => partyRef.tenantId === tenantId);
  return scoped.length === 1 ? scoped[0]?.resourceId : undefined;
};

const createVerdict = (created: PartyCreateResponse): PartyVerdict =>
  created.outcome === 'AMBIGUOUS'
    ? { kind: 'AMBIGUOUS', reason: 'The Party create decision is ambiguous and must be reconciled' }
    : {
        kind: 'RESOLVED',
        outcomeCode:
          created.outcome === 'CREATED' ? PARTY_CANDIDATE_CREATED_OUTCOME_CODE : PARTY_CANDIDATE_MATCHED_OUTCOME_CODE,
        partyResourceId: created.partyRef.resourceId,
      };

/** Evidence naming the exact committed decision, so a repeated recovery names the same reference. */
const evidenceFor = (ownerInvocationId: string, decisionResourceId: string): string =>
  retailSelfEnrollmentEvidenceReference(['party.registry', ownerInvocationId, decisionResourceId]);

/** One Party Registry submission: the read-only match, and the Create only `NO_MATCH` allows. */
interface PartySubmission {
  /**
   * What this submission was decided by, and therefore what its reconciliation evidence names. A
   * committed Create names the Party Registry's own decision; a read-only match names what the
   * match resolved, because the preview match commits no decision to name.
   */
  readonly decisionResourceId: string;
  readonly verdict: PartyVerdict;
}

/** A submission the read-only match alone decided: its own verdict is the reference it names. */
const submissionOf = (verdict: PartyVerdict): PartySubmission => ({
  decisionResourceId: verdict.kind === 'RESOLVED' ? verdict.partyResourceId : PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE,
  verdict,
});

const isCommitResolutionNotFound = Schema.is(PartyCommandNotFoundProblemSchema);

/**
 * Build the Party Registry owner effect for one Attempt.  `input` carries the business candidate;
 * `executors` defaults to the published client and is replaced by doubles in unit tests.
 */
export const retailPartyCandidateOwnerEffect = (
  input: RetailPartyCandidateOwnerInput,
  executors: RetailPartyCandidateOwnerExecutors = retailPartyCandidateOwnerExecutors,
): CommerceEnrollmentOwnerEffect => {
  const submit = Effect.fn('RetailPartyCandidateOwnerEffect.submit')(function* submitCandidate(
    ownerInvocationId: string,
  ): Effect.fn.Return<PartySubmission, CommerceEnrollmentOwnerEffectError> {
    const match = yield* executors
      .matchParty({ candidate: input.candidate }, input.requestCorrelation)
      .pipe(Effect.mapError((cause) => unavailable('The Party Registry match operation is unavailable', cause)));

    if (match.outcome === 'AMBIGUOUS') {
      return submissionOf({
        kind: 'AMBIGUOUS',
        reason: 'The Party candidate matched more than one Party and must be reconciled',
      });
    }
    if (match.outcome === 'MATCHED') {
      const partyResourceId = soleSameTenantParty(match.candidateParties, input.tenantId);
      return submissionOf(
        partyResourceId === undefined
          ? { kind: 'AMBIGUOUS', reason: 'The Party Registry match did not name exactly one Party in this Tenant' }
          : { kind: 'RESOLVED', outcomeCode: PARTY_CANDIDATE_MATCHED_OUTCOME_CODE, partyResourceId },
      );
    }

    // NO_MATCH is the only outcome that may create a Party, and it does so under the immutable
    // owner invocation as its idempotency key, so an equivalent retry cannot create a second one.
    const created = yield* executors
      .createParty(
        { candidate: input.candidate },
        { correlationId: input.requestCorrelation, idempotencyKey: ownerInvocationId },
      )
      .pipe(Effect.mapError((cause) => unavailable('The Party Registry create operation is unavailable', cause)));
    return { decisionResourceId: created.decisionRef.resourceId, verdict: createVerdict(created) };
  });

  const dispatch = Effect.fn('RetailPartyCandidateOwnerEffect.dispatch')(function* dispatchCandidate(
    transition: CommerceEnrollmentOwnerTransition,
  ): Effect.fn.Return<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> {
    const submission = yield* submit(transition.ownerInvocationId);
    return yield* outcomeOf(submission.verdict);
  });

  const resolutionFor = (
    reconciliation: CommerceEnrollmentOwnerReconciliationInput,
    submission: PartySubmission,
  ): Effect.Effect<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> => {
    const reconciliationRef = evidenceFor(reconciliation.ownerInvocationId, submission.decisionResourceId);
    return submission.verdict.kind === 'RESOLVED'
      ? decodeResolution({
          actorPrincipalId: reconciliation.actorPrincipalId,
          outcomeCode: submission.verdict.outcomeCode,
          reconciliationRef,
          resultReference: submission.verdict.partyResourceId,
          status: 'SUCCEEDED',
        })
      : decodeResolution({
          actorPrincipalId: reconciliation.actorPrincipalId,
          failureCode: OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
          failureReason: submission.verdict.reason.slice(0, 500),
          nextState: 'RECONCILIATION_REQUIRED',
          outcomeCode: PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE,
          reconciliationRef,
          status: 'FAILED',
        });
  };

  const reconcile = Effect.fn('RetailPartyCandidateOwnerEffect.reconcile')(function* reconcileCandidate(
    reconciliation: CommerceEnrollmentOwnerReconciliationInput,
  ): Effect.fn.Return<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> {
    // The Party Registry knows every invocation it was ever asked to commit. An identity it has
    // never seen is proof that this transition failed upstream of its own Create — in the read-only
    // match — so nothing is committed, nothing can be lost, and the submission is simply run again.
    const recovery = yield* executors
      .recoverPartyCreate(
        { invocationId: reconciliation.ownerInvocationId },
        { correlationId: input.requestCorrelation },
      )
      .pipe(
        Effect.asSome,
        Effect.catchIf(isCommitResolutionNotFound, () => Effect.succeedNone),
        Effect.mapError((cause) => unavailable('The Party Registry commit resolution is unavailable', cause)),
      );
    if (Option.isNone(recovery)) {
      return yield* resolutionFor(reconciliation, yield* submit(reconciliation.ownerInvocationId));
    }

    const recovered = Match.value(recovery.value).pipe(
      Match.tag('PartyCreateRecovered', ({ result }) => result),
      Match.orElse(() => null),
    );
    if (recovered === null) {
      return yield* ownerRejected(
        'party_registry_commit_open',
        'The Party Registry invocation has not committed yet and must be retried',
      );
    }
    return yield* resolutionFor(reconciliation, {
      decisionResourceId: recovered.decisionRef.resourceId,
      verdict: createVerdict(recovered),
    });
  });

  return Object.freeze({ dispatch, reconcile });
};
