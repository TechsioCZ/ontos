import { PartyCommandAlreadyCommittedProblemSchema } from '@app/party-registry/api';
import {
  acceptRetailEnrollmentEvidenceWithAuthorization,
  createPartyWithAuthorization,
  recoverPartyCreateWithAuthorization,
  resolvePartyCommandCommitWithAuthorization,
} from '@app/party-registry/api/client';
import type { acceptRetailEnrollmentEvidence, createParty, recoverPartyCreate } from '@app/party-registry/api/client';
import { SupportedGatewayContextClaimsSchema } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Effect, Match, Redacted, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';

import type { ReconcileEnrollmentResolution } from '../../../shared/enrollment-contracts.ts';
import { decodeOwnerOutcome, decodeOwnerResolution, ownerUnavailable } from '../orchestration/owner-effect-codec.ts';
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

/** Party owns every canonical decision. New enrollments and recovery use the same verified
 * evidence acceptance Action; linked candidates stay in their original governed review case. */
type PartyCandidate = Parameters<typeof createParty>[0]['candidate'];
type PartyCreateResponse = Effect.Success<ReturnType<typeof createParty>>;
type PartyCreateError = Effect.Error<ReturnType<typeof createParty>>;
type RetailEvidence = Parameters<typeof acceptRetailEnrollmentEvidence>[0]['evidence'];
type PartyRecoveryResponse = Effect.Success<ReturnType<typeof recoverPartyCreate>>;
type PartyRecoveryError = Effect.Error<ReturnType<typeof recoverPartyCreate>>;

export interface RetailPartyCandidateOwnerExecutors {
  readonly acceptEvidence: (
    payload: Parameters<typeof acceptRetailEnrollmentEvidence>[0],
    options: Parameters<typeof acceptRetailEnrollmentEvidence>[1],
  ) => Effect.Effect<
    PartyCreateResponse,
    Effect.Error<ReturnType<typeof acceptRetailEnrollmentEvidence>> | CommerceEnrollmentOwnerEffectError
  >;

  readonly createParty: (
    payload: Parameters<typeof createParty>[0],
    options: Parameters<typeof createParty>[1],
  ) => Effect.Effect<PartyCreateResponse, PartyCreateError | CommerceEnrollmentOwnerEffectError>;

  readonly recoverPartyCreate: (
    payload: Parameters<typeof recoverPartyCreate>[0],
    options: Parameters<typeof recoverPartyCreate>[1],
  ) => Effect.Effect<PartyRecoveryResponse, PartyRecoveryError | CommerceEnrollmentOwnerEffectError>;
  readonly resolveOriginalInvocation: (
    ownerInvocationId: string,
  ) => Effect.Effect<
    Parameters<typeof acceptRetailEnrollmentEvidence>[0]['originalInvocationId'],
    CommerceEnrollmentOwnerEffectError
  >;
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

/** Fresh, scoped owner credential for each Party command or authoritative recovery read. */
export const acquireRetailPartyGateway = Effect.fn('RetailSelfEnrollmentPartyOwner.acquireRetailPartyGateway')(
  function* acquireGateway(input: Omit<RetailPartyCandidateOwnerInput, 'candidate'>) {
    const { compositionRevision, legalEntityId, requestCorrelation, tenantId } = input;
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
    const claims = yield* Effect.fromResult(Base64Url.decodeString(tokenPayload)).pipe(
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
  },
);

const makeRetailPartyCandidateOwnerExecutors = (
  input: RetailPartyCandidateOwnerInput,
): RetailPartyCandidateOwnerExecutors => {
  const { compositionRevision, legalEntityId, requestCorrelation, tenantId } = input;
  const gatewayScope = Object.freeze({ compositionRevision, legalEntityId, requestCorrelation, tenantId });
  const acquire = () => acquireRetailPartyGateway(gatewayScope);
  return Object.freeze<RetailPartyCandidateOwnerExecutors>({
    acceptEvidence: (payload, options) =>
      acquire().pipe(
        Effect.flatMap(({ credential, options: transport }) =>
          acceptRetailEnrollmentEvidenceWithAuthorization(payload, Redacted.value(credential), {
            ...options,
            ...transport,
            correlationId: requestCorrelation,
          }),
        ),
      ),
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
    recoverPartyCreate: (payload, options) =>
      recoverPartyCreateWithAuthorization(payload, acquire, {
        ...options,
        compositionRevision,
        correlationId: requestCorrelation,
      }),
    resolveOriginalInvocation: (ownerInvocationId) =>
      acquire().pipe(
        Effect.flatMap(({ credential, options }) =>
          resolvePartyCommandCommitWithAuthorization(
            { actionKey: 'party.registry.create-party', idempotencyKey: ownerInvocationId },
            Redacted.value(credential),
            { ...options, correlationId: requestCorrelation },
          ),
        ),
        Effect.mapError((cause) => unavailable('The original Party Create invocation is unavailable', cause)),
        Effect.flatMap((result) =>
          result.state === 'COMMITTED'
            ? Effect.succeed(result.invocationId)
            : Effect.fail(unavailable('The original Party Create has not committed')),
        ),
      ),
  });
};

/** The journey's reading of one Party Registry result, before it becomes an Attempt outcome. */
type PartyVerdict =
  | { readonly kind: 'RESOLVED'; readonly outcomeCode: string; readonly partyResourceId: string }
  | { readonly caseResourceId: string; readonly kind: 'AMBIGUOUS'; readonly reason: string };

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
        resultReference: verdict.caseResourceId,
        status: 'FAILED',
      });

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
    ? {
        caseResourceId: created.caseRef.resourceId,
        kind: 'AMBIGUOUS',
        reason: 'The Party create decision is ambiguous and must be reconciled',
      }
    : {
        kind: 'RESOLVED',
        outcomeCode:
          created.outcome === 'CREATED' ? PARTY_CANDIDATE_CREATED_OUTCOME_CODE : PARTY_CANDIDATE_MATCHED_OUTCOME_CODE,
        partyResourceId: created.partyRef.resourceId,
      };

/** Evidence naming the exact committed decision, so a repeated recovery names the same reference. */
const evidenceFor = (ownerInvocationId: string, decisionResourceId: string): string =>
  retailSelfEnrollmentEvidenceReference(['party.registry', ownerInvocationId, decisionResourceId]);

/** A canonical Create or its governed continuation, never a preview identity match. */
interface PartySubmission {
  readonly decisionResourceId: string;
  readonly verdict: PartyVerdict;
}

/**
 * Build the Party Registry owner effect for one Attempt.  `input` carries the business candidate;
 * `executors` defaults to the published client and is replaced by doubles in unit tests.
 */
export const retailPartyCandidateOwnerEffect = (
  input: RetailPartyCandidateOwnerInput & {
    readonly verifiedEvidence: Effect.Effect<RetailEvidence, CommerceEnrollmentOwnerEffectError>;
  },
  executors: RetailPartyCandidateOwnerExecutors = makeRetailPartyCandidateOwnerExecutors(input),
): CommerceEnrollmentOwnerEffect => {
  const { candidate, requestCorrelation, tenantId, verifiedEvidence } = input;
  const acceptIfEligible = Effect.fn('RetailPartyCandidateOwnerEffect.acceptIfEligible')(function* accept(
    original: PartyCreateResponse,
    ownerInvocationId: string,
  ): Effect.fn.Return<PartyCreateResponse, CommerceEnrollmentOwnerEffectError> {
    if (original.outcome !== 'AMBIGUOUS') {
      return original;
    }
    const evidence = yield* verifiedEvidence;
    return yield* executors
      .acceptEvidence(
        { evidence, originalInvocationId: yield* executors.resolveOriginalInvocation(ownerInvocationId) },
        { correlationId: requestCorrelation, idempotencyKey: `${ownerInvocationId}:retail-evidence` },
      )
      .pipe(
        // A prior acceptance may have kept this case open for genuine review. Recovery of the
        // original invocation already consumed any governed resolution; do not mint another key.
        Effect.catchIf(Schema.is(PartyCommandAlreadyCommittedProblemSchema), () => Effect.succeed(original)),
        Effect.mapError((cause) => unavailable('Party retail evidence acceptance is unavailable', cause)),
      );
  });
  const submit = Effect.fn('RetailPartyCandidateOwnerEffect.submit')(function* submitCandidate(
    ownerInvocationId: string,
  ): Effect.fn.Return<PartySubmission, CommerceEnrollmentOwnerEffectError> {
    // The continuation checks before claiming; dispatch checks again before any Party effect.
    yield* verifiedEvidence;
    // Canonical Create decides first and retains a durable case when review is needed.
    // The same Party-owned acceptance path handles new enrollments and restart recovery.
    const created = yield* executors
      .createParty({ candidate }, { correlationId: requestCorrelation, idempotencyKey: ownerInvocationId })
      .pipe(Effect.mapError((cause) => unavailable('The Party Registry create operation is unavailable', cause)));
    yield* requireSameTenantCreateResult(created, tenantId);
    const accepted = yield* acceptIfEligible(created, ownerInvocationId);
    yield* requireSameTenantCreateResult(accepted, tenantId);
    return { decisionResourceId: accepted.decisionRef.resourceId, verdict: createVerdict(accepted) };
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
          resultReference: submission.verdict.caseResourceId,
          status: 'FAILED',
        });
  };

  const reconcile = Effect.fn('RetailPartyCandidateOwnerEffect.reconcile')(function* reconcileCandidate(
    reconciliation: CommerceEnrollmentOwnerReconciliationInput,
  ): Effect.fn.Return<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> {
    // Only native NOT_STARTED or RETRYABLE permits submission with the original immutable key.
    const recovery = yield* executors
      .recoverPartyCreate(
        { actionKey: 'party.registry.create-party', idempotencyKey: reconciliation.ownerInvocationId },
        { correlationId: requestCorrelation },
      )
      .pipe(Effect.mapError((cause) => unavailable('The Party Registry commit resolution is unavailable', cause)));
    const pending = Match.value(recovery).pipe(
      Match.tag('PartyCreateRecoveryPending', ({ resolution }) => resolution),
      Match.orElse(() => null),
    );
    if (pending !== null) {
      const resolution = pending;
      if (resolution.retryCommand) {
        return yield* resolutionFor(reconciliation, yield* submit(reconciliation.ownerInvocationId));
      }
      if (resolution.state === 'REJECTED') {
        return yield* decodeResolution({
          actorPrincipalId: reconciliation.actorPrincipalId,
          failureCode: 'owner_rejected',
          failureReason: 'The original Party Create command was terminally rejected',
          outcomeCode: 'party_registry_command_rejected',
          reconciliationRef: evidenceFor(reconciliation.ownerInvocationId, resolution.invocationId),
          status: 'FAILED',
        });
      }
    }
    const recovered = Match.value(recovery).pipe(
      Match.tag('PartyCreateRecovered', ({ result }) => result),
      Match.orElse(() => null),
    );
    if (recovered === null) {
      return yield* ownerUnavailable(
        'party_registry_commit_open',
        'The Party Registry invocation has not committed yet and must be retried',
      );
    }
    yield* requireSameTenantCreateResult(recovered, tenantId);
    const accepted = yield* acceptIfEligible(recovered, reconciliation.ownerInvocationId);
    yield* requireSameTenantCreateResult(accepted, tenantId);
    return yield* resolutionFor(reconciliation, {
      decisionResourceId: accepted.decisionRef.resourceId,
      verdict: createVerdict(accepted),
    });
  });

  return Object.freeze({ dispatch, reconcile });
};
