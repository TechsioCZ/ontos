import type {
  MarketAffectedUseAssessmentRequest,
  MarketAffectedUseAssessmentResponse,
} from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import { executeMarketAffectedUseAssessmentWithAuthorization } from '@app/customer-market-retirement-contracts/market-affected-use-assessment/client';
import type {
  MarketRetirementReservationRequest,
  MarketRetirementReservationResponse,
} from '@app/customer-market-retirement-contracts/market-retirement-reservation';
import { executeMarketRetirementReservationWithAuthorization } from '@app/customer-market-retirement-contracts/market-retirement-reservation/client';
import { ReserveMarketRetirementAlreadyCommittedProblemSchema } from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import type {
  ReserveMarketRetirementPayload,
  ReserveMarketRetirementResult,
} from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import { executeReserveMarketRetirementWithAuthorization } from '@app/customer-market-retirement-contracts/reserve-market-retirement/client';
import type { GatewayContextResponse } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, DateTime, Effect, Layer, Match, Option, Schema } from 'effect';

import { MarketCommandRejected } from '../../shared/action-contracts.ts';

import type {
  MarketRetirementImpactAssessment,
  ReservedMarketRetirementImpactAssessment,
} from '../../shared/domain/market-retirement-impact.ts';
import { MarketRetirementImpactAssessmentRejected } from '../actions/market-retirement-impact-assessment-rejected.ts';
import { MarketRetirementImpactAssessmentStale } from '../actions/market-retirement-impact-assessment-stale.ts';
import { MarketRetirementImpactAssessmentUnavailable } from '../actions/market-retirement-impact-assessment-unavailable.ts';
import type { MarketRetirementImpactFailure } from '../domain/market-retirement-workflow.ts';
import type {
  MarketRetirementImpactAuthority,
  MarketRetirementOwnerCallContext,
  MarketRetirementReserveRequest,
} from '../services/market-retirement-impact-authority.ts';
import { MarketRetirementImpactAuthorityService } from '../services/market-retirement-impact-authority.ts';
import { ownerGatewayApiKey } from './owner-gateway-api-key.ts';

type ExecuteMarketAffectedUseAssessment<Failure> = (
  payload: MarketAffectedUseAssessmentRequest,
  context: {
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  },
) => Effect.Effect<MarketAffectedUseAssessmentResponse, Failure>;

type ExecuteMarketRetirementReservation<Failure> = (
  payload: ReserveMarketRetirementPayload,
  context: MarketRetirementOwnerCallContext & { readonly idempotencyKey: string },
) => Effect.Effect<ReserveMarketRetirementResult, Failure>;

type ReadMarketRetirementReservation<Failure> = (
  payload: MarketRetirementReservationRequest,
  context: MarketRetirementOwnerCallContext,
) => Effect.Effect<MarketRetirementReservationResponse, Failure>;

const CUSTOMER_CONTEXT_MODULE_KEY = 'commerce.customer-context' as const;
const httpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
      ? undefined
      : 'Service URL must be an HTTP(S) URL without credentials, query, or fragment',
  ),
);
const productionClientConfiguration = (legalEntityId: string) =>
  Config.all({
    apiKey: ownerGatewayApiKey(legalEntityId),
    shellGatewayBaseUrl: Config.schema(httpUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
  });
const GatewayFailureSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});

const unavailable = (reason: string, cause?: unknown): MarketRetirementImpactAssessmentUnavailable => {
  const failure = new MarketRetirementImpactAssessmentUnavailable({
    code: 'market_retirement_impact_assessment_unavailable',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const stale = (reason: string): MarketRetirementImpactAssessmentStale =>
  new MarketRetirementImpactAssessmentStale({
    code: 'market_retirement_impact_assessment_stale',
    reason,
  });

const rejected = (reason: string): MarketRetirementImpactAssessmentRejected =>
  new MarketRetirementImpactAssessmentRejected({
    code: 'market_retirement_impact_assessment_rejected',
    reason,
  });

const errorText = (cause: unknown): string => {
  if (Schema.is(GatewayFailureSchema)(cause)) {
    if (cause.reason !== undefined && cause.reason.length > 0) {
      return cause.reason;
    }
    if (cause.message !== undefined && cause.message.length > 0) {
      return cause.message;
    }
  }
  return 'The Customer Context Market retirement reservation gateway is unavailable';
};

const definiteRejectionCodes: ReadonlySet<string> = new Set([
  'INVALID_REQUEST',
  'RESERVATION_STATE_CONFLICT',
  'RETIREMENT_RESERVATION_CONFLICT',
  'RETIREMENT_RESERVATION_NOT_FOUND',
  'action_request_hash_conflict',
]);

/**
 * Only owner-declared definite outcomes become typed rejections. Transport, permission, availability and
 * unknown failures stay `Unavailable`, so the caller retries with the same idempotency key.
 */
const mapReservationFailure = (cause: unknown): MarketRetirementImpactFailure => {
  const code = Schema.is(GatewayFailureSchema)(cause) ? cause.code : undefined;
  if (code === 'LIVE_REFERENCE_CONFLICT') {
    return new MarketCommandRejected({
      code: 'replacement_impact_unresolved',
      reason: 'Retirement is blocked while a material live owner reference still depends on this Market',
    });
  }
  if (code === 'ASSESSMENT_STALE') {
    return stale(errorText(cause));
  }
  return code !== undefined && definiteRejectionCodes.has(code)
    ? rejected(errorText(cause))
    : unavailable(errorText(cause), cause);
};

const identityMatches = (
  request: MarketAffectedUseAssessmentRequest,
  response: MarketAffectedUseAssessmentResponse,
): boolean =>
  response.tenantId === request.tenantId &&
  response.marketRevision === request.marketRevision &&
  response.evaluatedAt === request.evaluatedAt &&
  response.marketRef.moduleId === request.marketRef.moduleId &&
  response.marketRef.resourceId === request.marketRef.resourceId &&
  response.marketRef.resourceType === request.marketRef.resourceType &&
  response.marketRef.tenantId === request.marketRef.tenantId;

const normalizeInstant = (value: DateTime.DateTime | string): string =>
  DateTime.isDateTime(value) ? DateTime.formatIso(value) : value;

const isCurrentAt = (observedAt: string, nextBoundaryAt: string | undefined, effectiveAt: string): boolean => {
  const observed = DateTime.make(observedAt);
  const effective = DateTime.make(effectiveAt);
  const boundary = nextBoundaryAt === undefined ? Option.none() : DateTime.make(nextBoundaryAt);
  if (Option.isNone(observed) || Option.isNone(effective)) {
    return false;
  }
  const observedEpoch = DateTime.toEpochMillis(observed.value);
  const effectiveEpoch = DateTime.toEpochMillis(effective.value);
  return (
    observedEpoch <= effectiveEpoch &&
    (Option.isNone(boundary) || effectiveEpoch < DateTime.toEpochMillis(boundary.value))
  );
};

const hasCompleteCurrentSourceEvidence = (
  response: Extract<MarketAffectedUseAssessmentResponse, { readonly outcome: 'VERIFIED' }>,
): boolean => {
  if (response.sourceEvidence.length === 0) {
    return false;
  }
  const sourceIds = new Set<string>();
  for (const evidence of response.sourceEvidence) {
    const observedAt = normalizeInstant(evidence.completenessEvidence.observedAt);
    const boundary = evidence.completenessEvidence.nextApplicabilityBoundary;
    const nextBoundaryAt = boundary === undefined ? undefined : normalizeInstant(boundary);
    if (
      sourceIds.has(evidence.sourceId) ||
      evidence.currentness !== 'CURRENT' ||
      evidence.ownerRevision.length === 0 ||
      evidence.ownerRevision !== evidence.completenessEvidence.ownerRevision ||
      evidence.generation.length === 0 ||
      !/^[a-f0-9]{64}$/u.test(evidence.digest) ||
      evidence.completenessEvidence.scope.predicateRef.length === 0 ||
      !isCurrentAt(observedAt, nextBoundaryAt, response.evaluatedAt)
    ) {
      return false;
    }
    sourceIds.add(evidence.sourceId);
  }
  return true;
};

const verifiedAssessment = (
  response: Extract<MarketAffectedUseAssessmentResponse, { readonly outcome: 'VERIFIED' }>,
): Effect.Effect<
  MarketRetirementImpactAssessment,
  MarketRetirementImpactAssessmentStale | MarketRetirementImpactAssessmentUnavailable
> => {
  if (!isCurrentAt(response.observedAt, response.nextApplicabilityBoundary, response.evaluatedAt)) {
    return Effect.fail(stale('Customer Context retirement-impact evidence is no longer Current'));
  }
  if (!hasCompleteCurrentSourceEvidence(response)) {
    return Effect.fail(unavailable('Customer Context returned incomplete retirement-impact source evidence'));
  }
  const liveReferenceCount =
    response.liveBlockingReferences.bootstrapDefaults.length + response.liveBlockingReferences.currentProposals.length;
  const providerWithoutBoundary = {
    completenessEvidenceReference: `customer-context:market-affected-use:${response.assessmentDigest}`,
    currentnessEvidenceReference: `customer-context:market-affected-use:${response.observedAt}:${response.assessmentDigest}`,
    effectiveAt: response.evaluatedAt,
    liveBlockingReferences: {
      count: liveReferenceCount,
      evidenceReference: `customer-context:market-live-references:${response.assessmentDigest}`,
    },
    observedAt: response.observedAt,
    ownerModuleKey: CUSTOMER_CONTEXT_MODULE_KEY,
    ownerRevision: response.assessmentDigest,
    retainedHistoryEvidence: {
      count: response.retainedHistoryReferences.length,
      evidenceReference: `customer-context:market-retained-history:${response.assessmentDigest}`,
    },
    versionToken: response.assessmentDigest,
  };
  const provider =
    response.nextApplicabilityBoundary === undefined
      ? providerWithoutBoundary
      : { ...providerWithoutBoundary, nextBoundaryAt: response.nextApplicabilityBoundary };
  return Effect.succeed({
    assessedMarketRef: response.marketRef,
    assessedMarketRevision: response.marketRevision,
    assessmentDigest: response.assessmentDigest,
    effectiveAt: response.evaluatedAt,
    providers: [provider],
    requiredProviderModuleKeys: [CUSTOMER_CONTEXT_MODULE_KEY],
  });
};

const toVerifiedAssessment = (
  request: MarketAffectedUseAssessmentRequest,
  response: MarketAffectedUseAssessmentResponse,
) => {
  if (!identityMatches(request, response)) {
    return Effect.fail(
      stale('Customer Context retirement-impact evidence does not match the requested Market revision'),
    );
  }
  return Match.value(response).pipe(
    Match.discriminator('outcome')('REJECTED', ({ reason }) => Effect.fail(rejected(reason))),
    Match.discriminator('outcome')('STALE', ({ reason }) => Effect.fail(stale(reason))),
    Match.discriminator('outcome')('UNAVAILABLE', ({ reason }) => Effect.fail(unavailable(reason))),
    Match.discriminator('outcome')('VERIFIED', (verified) =>
      verifiedAssessment(verified).pipe(Effect.map((assessment) => ({ assessment, response: verified }))),
    ),
    Match.exhaustive,
  );
};

const requestFor = (input: {
  readonly effectiveAt: DateTime.Utc;
  readonly expectedMarketRevision: number;
  readonly marketRef: MarketAffectedUseAssessmentRequest['marketRef'];
}): MarketAffectedUseAssessmentRequest => ({
  evaluatedAt: DateTime.formatIso(input.effectiveAt),
  marketRef: input.marketRef,
  marketRevision: input.expectedMarketRevision,
  tenantId: input.marketRef.tenantId,
});

const reservationResultMatches = (
  result: ReserveMarketRetirementResult,
  assessment: MarketRetirementImpactAssessment,
): boolean =>
  result.assessmentDigest === assessment.assessmentDigest &&
  result.marketRevision === assessment.assessedMarketRevision &&
  result.tenantId === assessment.assessedMarketRef.tenantId &&
  result.marketRef.moduleId === assessment.assessedMarketRef.moduleId &&
  result.marketRef.resourceId === assessment.assessedMarketRef.resourceId &&
  result.marketRef.resourceType === assessment.assessedMarketRef.resourceType &&
  result.marketRef.tenantId === assessment.assessedMarketRef.tenantId;

const finishedReservationMatches = (
  result: ReserveMarketRetirementResult,
  assessment: ReservedMarketRetirementImpactAssessment,
  lifecycle: 'COMMITTED' | 'RELEASED',
): boolean =>
  reservationResultMatches(result, assessment) &&
  result.lifecycle === lifecycle &&
  result.reservationToken === assessment.reservation.token &&
  result.reservationVersion === assessment.reservation.version + 1;

const isAlreadyCommitted = Schema.is(ReserveMarketRetirementAlreadyCommittedProblemSchema);

const ownerCall = (input: MarketRetirementOwnerCallContext): MarketRetirementOwnerCallContext => ({
  compositionRevision: input.compositionRevision,
  legalEntityId: input.legalEntityId,
  requestCorrelation: input.requestCorrelation,
});

export const makeMarketRetirementImpactAuthority = <
  AssessmentFailure,
  ReservationFailure = never,
  ReservationReadFailure = never,
>(
  executeAssessment: ExecuteMarketAffectedUseAssessment<AssessmentFailure>,
  reservations: {
    readonly execute?: ExecuteMarketRetirementReservation<ReservationFailure>;
    readonly read?: ReadMarketRetirementReservation<ReservationReadFailure>;
  } = {},
): MarketRetirementImpactAuthority => {
  const { execute: executeReservation, read: readReservation } = reservations;
  const unavailableReservation = () =>
    Effect.fail(unavailable('The Customer Context Market retirement reservation authority is unavailable'));
  const finishReservation = (
    operation: 'COMMIT' | 'RELEASE',
    input: MarketRetirementOwnerCallContext & {
      readonly assessment: ReservedMarketRetirementImpactAssessment;
      readonly idempotencyKey: string;
      readonly reason: string;
    },
  ): Effect.Effect<void, MarketRetirementImpactFailure> => {
    if (executeReservation === undefined) {
      return unavailableReservation();
    }
    const payload: ReserveMarketRetirementPayload = {
      marketRef: input.assessment.assessedMarketRef,
      marketRevision: input.assessment.assessedMarketRevision,
      operation,
      reason: input.reason,
      reservationToken: input.assessment.reservation.token,
      reservationVersion: input.assessment.reservation.version,
      tenantId: input.assessment.assessedMarketRef.tenantId,
    };
    return executeReservation(payload, { ...ownerCall(input), idempotencyKey: input.idempotencyKey }).pipe(
      Effect.asSome,
      // The same key already committed this exact finish: the owner state is already final.
      Effect.catchIf(isAlreadyCommitted, () => Effect.succeedNone),
      Effect.mapError(mapReservationFailure),
      Effect.flatMap((finished) =>
        Option.isNone(finished) ||
        finishedReservationMatches(finished.value, input.assessment, operation === 'COMMIT' ? 'COMMITTED' : 'RELEASED')
          ? Effect.void
          : Effect.fail(stale(`Customer Context returned mismatched ${operation} reservation evidence`)),
      ),
    );
  };
  const recoverReservation = (
    reserve: MarketRetirementReserveRequest,
    invocationId: string,
    input: MarketRetirementOwnerCallContext,
  ): Effect.Effect<ReserveMarketRetirementResult, MarketRetirementImpactFailure> =>
    readReservation === undefined
      ? unavailableReservation()
      : readReservation(
          { marketRef: reserve.marketRef, reservationInvocationId: invocationId, tenantId: reserve.tenantId },
          ownerCall(input),
        ).pipe(
          Effect.mapError((cause) =>
            unavailable('The committed Market retirement reservation could not be recovered', cause),
          ),
        );
  return {
    commitRetirementImpact: (input) =>
      finishReservation('COMMIT', input).pipe(Effect.withSpan('MarketRetirementImpactAuthority.commit')),
    prepareRetirementReservation: (input) => {
      const request = requestFor(input);
      return executeAssessment(request, ownerCall(input)).pipe(
        Effect.mapError((cause) =>
          unavailable('The Customer Context Market retirement-impact authority is unavailable', cause),
        ),
        Effect.flatMap((response) => toVerifiedAssessment(request, response)),
        Effect.map(({ assessment, response }) => ({
          assessment,
          reservationRequest: {
            assessmentDigest: response.assessmentDigest,
            evaluatedAt: response.evaluatedAt,
            marketRef: response.marketRef,
            marketRevision: response.marketRevision,
            operation: 'RESERVE' as const,
            reason: input.reason,
            sourceEvidence: response.sourceEvidence,
            tenantId: response.tenantId,
          },
        })),
        Effect.withSpan('MarketRetirementImpactAuthority.prepareReservation'),
      );
    },
    releaseRetirementImpact: (input) =>
      finishReservation('RELEASE', input).pipe(Effect.withSpan('MarketRetirementImpactAuthority.release')),
    reserveRetirementImpact: (input) => {
      if (executeReservation === undefined) {
        return unavailableReservation();
      }
      const reserve = input.reservationRequest;
      return (
        reserve.assessmentDigest === input.assessment.assessmentDigest
          ? executeReservation(reserve, { ...ownerCall(input), idempotencyKey: input.idempotencyKey }).pipe(
              Effect.catchIf(isAlreadyCommitted, (committed) =>
                recoverReservation(reserve, committed.invocationId, input),
              ),
              Effect.mapError((failure) =>
                Schema.is(MarketRetirementImpactAssessmentUnavailable)(failure)
                  ? failure
                  : mapReservationFailure(failure),
              ),
            )
          : Effect.fail(stale('The persisted RESERVE request belongs to different affected-use evidence'))
      ).pipe(
        Effect.flatMap((result) =>
          result.lifecycle === 'RESERVED' && reservationResultMatches(result, input.assessment)
            ? Effect.succeed({
                ...input.assessment,
                reservation: { token: result.reservationToken, version: result.reservationVersion },
              })
            : Effect.fail(
                unavailable('Customer Context returned reservation evidence that does not match the RESERVE request'),
              ),
        ),
        Effect.withSpan('MarketRetirementImpactAuthority.reserve'),
      );
    },
  };
};

const withCustomerContextCredential = <A, E, R>(
  context: MarketRetirementOwnerCallContext,
  call: (issued: GatewayContextResponse, baseUrl: URL) => Effect.Effect<A, E, R>,
) =>
  productionClientConfiguration(context.legalEntityId).pipe(
    Effect.flatMap(({ apiKey, shellGatewayBaseUrl }) =>
      issueApiKeyGatewayContext(
        {
          audience: 'commerce-customer-context',
          compositionRevision: context.compositionRevision,
          legalEntityId: context.legalEntityId,
        },
        { apiKey, baseUrl: shellGatewayBaseUrl, requestCorrelation: context.requestCorrelation },
      ).pipe(
        Effect.filterOrFail(
          (response) => response.compositionRevision === context.compositionRevision,
          () => unavailable('Customer Context gateway returned a different composition revision'),
        ),
        Effect.flatMap((issued) => call(issued, new URL(issued.apiBaseUrl, shellGatewayBaseUrl))),
      ),
    ),
  );

export const makeMarketRetirementImpactAuthorityFromPublishedClient = () =>
  makeMarketRetirementImpactAuthority(
    (payload, context) =>
      withCustomerContextCredential(context, (issued, baseUrl) =>
        executeMarketAffectedUseAssessmentWithAuthorization(
          payload,
          `Bearer ${issued.token}`,
          context.requestCorrelation,
          {
            baseUrl,
            compositionRevision: context.compositionRevision,
          },
        ),
      ),
    {
      execute: (payload, context) =>
        withCustomerContextCredential(context, (issued, baseUrl) =>
          executeReserveMarketRetirementWithAuthorization(
            payload,
            `Bearer ${issued.token}`,
            context.requestCorrelation,
            {
              baseUrl,
              compositionRevision: context.compositionRevision,
              idempotencyKey: context.idempotencyKey,
            },
          ),
        ),
      read: (payload, context) =>
        withCustomerContextCredential(context, (issued, baseUrl) =>
          executeMarketRetirementReservationWithAuthorization(
            payload,
            `Bearer ${issued.token}`,
            context.requestCorrelation,
            {
              baseUrl,
              compositionRevision: context.compositionRevision,
            },
          ),
        ),
    },
  );

export const MarketRetirementImpactAuthorityLive = Layer.succeed(
  MarketRetirementImpactAuthorityService,
  makeMarketRetirementImpactAuthorityFromPublishedClient(),
);
