import { PartyCommandNotFoundProblemSchema } from '@app/party-registry/api';
import {
  createPartyWithAuthorization,
  executePartyMatchWithAuthorization,
  recoverPartyCreateWithAuthorization,
} from '@app/party-registry/api/client';
import type { createParty, executePartyMatch, recoverPartyCreate } from '@app/party-registry/api/client';
import { SupportedGatewayContextClaimsSchema } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Effect, Encoding, Match, Option, Redacted, Schema } from 'effect';

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
  ) => Effect.Effect<PartyCreateResponse, PartyCreateError | CommerceEnrollmentOwnerEffectError>;
  readonly matchParty: (
    payload: PartyMatchInvocation[0],
    requestCorrelation: string,
  ) => Effect.Effect<PartyMatchResponse, PartyMatchError | CommerceEnrollmentOwnerEffectError>;
  readonly recoverPartyCreate: (
    payload: Parameters<typeof recoverPartyCreate>[0],
    options: Parameters<typeof recoverPartyCreate>[1],
  ) => Effect.Effect<PartyRecoveryResponse, PartyRecoveryError | CommerceEnrollmentOwnerEffectError>;
}

export interface RetailPartyCandidateOwnerInput {
  /** The exact Party candidate submitted for this Attempt.  It never enters a Commerce digest. */
  readonly candidate: PartyCandidate;
  readonly compositionRevision: string;
  readonly legalEntityId: string;
  readonly requestCorrelation: string;
  readonly tenantId: string;
}

const PARTY_REGISTRY_UNAVAILABLE_CODE = 'party_registry_unavailable';

const unavailable = (reason: string, cause?: unknown) =>
  ownerUnavailable(PARTY_REGISTRY_UNAVAILABLE_CODE, reason, cause);

const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Shell gateway URL must be HTTP(S) without credentials, query, or fragment',
  ),
);
const partyGatewayConfiguration = Config.all({
  apiKey: Config.Redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  baseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

const makeRetailPartyCandidateOwnerExecutors = (
  input: RetailPartyCandidateOwnerInput,
): RetailPartyCandidateOwnerExecutors => {
  const { compositionRevision, legalEntityId, requestCorrelation, tenantId } = input;
  const acquire = Effect.fn('RetailPartyCandidateOwnerEffect.acquireGateway')(function* acquireGateway() {
    const configured = yield* partyGatewayConfiguration.pipe(
      Effect.mapError((cause) => unavailable('The Party Registry server gateway configuration is unavailable', cause)),
    );
    const response = yield* issueApiKeyGatewayContext(
      {
        audience: 'party-registry',
        compositionRevision,
        legalEntityId,
      },
      { apiKey: configured.apiKey, baseUrl: configured.baseUrl, requestCorrelation },
    ).pipe(
      Effect.mapError((cause) => unavailable('The Party Registry server gateway credential is unavailable', cause)),
    );
    if (response.compositionRevision !== compositionRevision) {
      return yield* unavailable('The Party Registry gateway credential does not match the original Attempt release');
    }
    // This cross-checks the authenticated issuer response against the durable Attempt scope.
    // The receiving Party runtime independently verifies the signature and redeems the assertion.
    const tokenParts = response.token.split('.');
    const tokenPayload = tokenParts.length === 3 ? tokenParts[1] : undefined;
    if (tokenPayload === undefined) {
      return yield* unavailable('The Party Registry issuer returned an unusable credential');
    }
    const claims = yield* Effect.fromResult(Encoding.decodeBase64UrlString(tokenPayload)).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))),
      Effect.mapError((cause) => unavailable('The Party Registry issuer returned an unusable credential scope', cause)),
    );
    if (
      claims.aud !== 'party-registry' ||
      claims.compositionRevision !== compositionRevision ||
      claims.principal.tenantId !== tenantId ||
      claims.principal.legalEntityId !== legalEntityId ||
      claims.principal.authMethod !== 'api_key'
    ) {
      return yield* unavailable('The Party Registry issuer credential does not match the original Attempt scope');
    }
    return {
      credential: Redacted.make(`Bearer ${response.token}`),
      options: {
        baseUrl: new URL(response.apiBaseUrl, configured.baseUrl),
        compositionRevision,
      },
    };
  });
  return Object.freeze<RetailPartyCandidateOwnerExecutors>({
    createParty: (payload, options) =>
      acquire().pipe(
        Effect.flatMap(({ credential, options: transport }) =>
          createPartyWithAuthorization(payload, Redacted.value(credential), {
            ...options,
            ...transport,
            correlationId: requestCorrelation,
          }),
        ),
      ),
    matchParty: (payload) =>
      acquire().pipe(
        Effect.flatMap(({ credential, options }) =>
          executePartyMatchWithAuthorization(payload, Redacted.value(credential), requestCorrelation, options),
        ),
      ),
    recoverPartyCreate: (payload, options) =>
      recoverPartyCreateWithAuthorization(payload, acquire, {
        ...options,
        compositionRevision,
        correlationId: requestCorrelation,
      }),
  });
};

/** The journey's reading of one Party Registry result, before it becomes an Attempt outcome. */
type PartyVerdict =
  | { readonly kind: 'RESOLVED'; readonly outcomeCode: string; readonly partyResourceId: string }
  | { readonly kind: 'AMBIGUOUS'; readonly reason: string };

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

const requireSameTenantCreateResult = (
  result: PartyCreateResponse,
  tenantId: string,
): Effect.Effect<void, CommerceEnrollmentOwnerEffectError> =>
  result.decisionRef.tenantId === tenantId &&
  (result.outcome === 'AMBIGUOUS' ? result.caseRef.tenantId === tenantId : result.partyRef.tenantId === tenantId)
    ? Effect.void
    : Effect.fail(unavailable('The Party Registry returned a decision outside the original Attempt Tenant'));

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
  executors: RetailPartyCandidateOwnerExecutors = makeRetailPartyCandidateOwnerExecutors(input),
): CommerceEnrollmentOwnerEffect => {
  const { candidate, requestCorrelation, tenantId } = input;
  const submit = Effect.fn('RetailPartyCandidateOwnerEffect.submit')(function* submitCandidate(
    ownerInvocationId: string,
  ): Effect.fn.Return<PartySubmission, CommerceEnrollmentOwnerEffectError> {
    const match = yield* executors
      .matchParty({ candidate }, requestCorrelation)
      .pipe(Effect.mapError((cause) => unavailable('The Party Registry match operation is unavailable', cause)));

    if (match.outcome === 'AMBIGUOUS') {
      return submissionOf({
        kind: 'AMBIGUOUS',
        reason: 'The Party candidate matched more than one Party and must be reconciled',
      });
    }
    if (match.outcome === 'MATCHED') {
      const partyResourceId = soleSameTenantParty(match.candidateParties, tenantId);
      return submissionOf(
        partyResourceId === undefined
          ? { kind: 'AMBIGUOUS', reason: 'The Party Registry match did not name exactly one Party in this Tenant' }
          : { kind: 'RESOLVED', outcomeCode: PARTY_CANDIDATE_MATCHED_OUTCOME_CODE, partyResourceId },
      );
    }

    // NO_MATCH is the only outcome that may create a Party, and it does so under the immutable
    // owner invocation as its idempotency key, so an equivalent retry cannot create a second one.
    const created = yield* executors
      .createParty({ candidate }, { correlationId: requestCorrelation, idempotencyKey: ownerInvocationId })
      .pipe(Effect.mapError((cause) => unavailable('The Party Registry create operation is unavailable', cause)));
    yield* requireSameTenantCreateResult(created, tenantId);
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
      .recoverPartyCreate({ invocationId: reconciliation.ownerInvocationId }, { correlationId: requestCorrelation })
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
    yield* requireSameTenantCreateResult(recovered, tenantId);
    return yield* resolutionFor(reconciliation, {
      decisionResourceId: recovered.decisionRef.resourceId,
      verdict: createVerdict(recovered),
    });
  });

  return Object.freeze({ dispatch, reconcile });
};
