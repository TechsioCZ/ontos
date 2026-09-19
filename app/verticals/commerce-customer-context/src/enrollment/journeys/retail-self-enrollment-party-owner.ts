import { createParty, executePartyMatch, recoverPartyCreate } from '@app/party-registry/api/client';
import { Effect, Match } from 'effect';

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
 * Party Registry candidate submission as one Retail self-enrollment owner transition.
 *
 * The adapter speaks only the published Party Registry client.  It submits the exact candidate,
 * reads the typed match outcome, and creates a Party only on `NO_MATCH`.  An `AMBIGUOUS` outcome
 * is a typed non-terminal halt: the adapter never picks a Party, never widens a match, and never
 * infers ownership from a login email or a Guest order.
 *
 * Reconciliation is an exact owner read.  `recoverPartyCreate` resolves the immutable original
 * invocation's commit state through Core and then reads that invocation's durable decision; a
 * still-open commit is rejected for a later retry rather than resubmitting a Create.
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

/**
 * Build the Party Registry owner effect for one Attempt.  `input` carries the business candidate;
 * `executors` defaults to the published client and is replaced by doubles in unit tests.
 */
export const retailPartyCandidateOwnerEffect = (
  input: RetailPartyCandidateOwnerInput,
  executors: RetailPartyCandidateOwnerExecutors = retailPartyCandidateOwnerExecutors,
): CommerceEnrollmentOwnerEffect => {
  const dispatch = Effect.fn('RetailPartyCandidateOwnerEffect.dispatch')(function* dispatchCandidate(
    transition: CommerceEnrollmentOwnerTransition,
  ): Effect.fn.Return<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> {
    const match = yield* executors
      .matchParty({ candidate: input.candidate }, input.requestCorrelation)
      .pipe(Effect.mapError((cause) => unavailable('The Party Registry match operation is unavailable', cause)));

    if (match.outcome === 'AMBIGUOUS') {
      return yield* outcomeOf({
        kind: 'AMBIGUOUS',
        reason: 'The Party candidate matched more than one Party and must be reconciled',
      });
    }
    if (match.outcome === 'MATCHED') {
      const partyResourceId = soleSameTenantParty(match.candidateParties, input.tenantId);
      return yield* outcomeOf(
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
        { correlationId: input.requestCorrelation, idempotencyKey: transition.ownerInvocationId },
      )
      .pipe(Effect.mapError((cause) => unavailable('The Party Registry create operation is unavailable', cause)));
    return yield* outcomeOf(createVerdict(created));
  });

  const reconcile = Effect.fn('RetailPartyCandidateOwnerEffect.reconcile')(function* reconcileCandidate(
    reconciliation: CommerceEnrollmentOwnerReconciliationInput,
  ): Effect.fn.Return<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> {
    const recovery = yield* executors
      .recoverPartyCreate(
        { invocationId: reconciliation.ownerInvocationId },
        { correlationId: input.requestCorrelation },
      )
      .pipe(Effect.mapError((cause) => unavailable('The Party Registry commit resolution is unavailable', cause)));

    const recovered = Match.value(recovery).pipe(
      Match.tag('PartyCreateRecovered', ({ result }) => result),
      Match.orElse(() => null),
    );
    if (recovered === null) {
      return yield* ownerRejected(
        'party_registry_commit_open',
        'The Party Registry invocation has not committed yet and must be retried',
      );
    }
    const verdict = createVerdict(recovered);
    const reconciliationRef = evidenceFor(reconciliation.ownerInvocationId, recovered.decisionRef.resourceId);
    return yield* verdict.kind === 'RESOLVED'
      ? decodeResolution({
          actorPrincipalId: reconciliation.actorPrincipalId,
          outcomeCode: verdict.outcomeCode,
          reconciliationRef,
          resultReference: verdict.partyResourceId,
          status: 'SUCCEEDED',
        })
      : decodeResolution({
          actorPrincipalId: reconciliation.actorPrincipalId,
          failureCode: OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
          failureReason: verdict.reason.slice(0, 500),
          nextState: 'RECONCILIATION_REQUIRED',
          outcomeCode: PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE,
          reconciliationRef,
          status: 'FAILED',
        });
  });

  return Object.freeze({ dispatch, reconcile });
};
