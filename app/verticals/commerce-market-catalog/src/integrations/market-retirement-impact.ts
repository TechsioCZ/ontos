import type {
  MarketAffectedUseAssessmentRequest,
  MarketAffectedUseAssessmentResponse,
} from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import { executeMarketAffectedUseAssessmentWithAuthorization } from '@app/customer-market-retirement-contracts/market-affected-use-assessment/client';
import type {
  ReserveMarketRetirementPayload,
  ReserveMarketRetirementResult,
} from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import { executeReserveMarketRetirementWithAuthorization } from '@app/customer-market-retirement-contracts/reserve-market-retirement/client';
import { issueGatewayContext } from '@app/shared-contracts';
import { Config, DateTime, Effect, Layer, Match, Option, Schema } from 'effect';

import type {
  MarketRetirementImpactAssessment,
  ReservedMarketRetirementImpactAssessment,
} from '../../shared/domain/market-retirement-impact.ts';
import { MarketRetirementImpactAssessmentRejected } from '../actions/market-retirement-impact-assessment-rejected.ts';
import { MarketRetirementImpactAssessmentStale } from '../actions/market-retirement-impact-assessment-stale.ts';
import { MarketRetirementImpactAssessmentUnavailable } from '../actions/market-retirement-impact-assessment-unavailable.ts';
import type { MarketRetirementImpactAuthority } from '../services/market-retirement-impact-authority.ts';
import { MarketRetirementImpactAuthorityService } from '../services/market-retirement-impact-authority.ts';

type ExecuteMarketAffectedUseAssessment<Failure> = (
  payload: MarketAffectedUseAssessmentRequest,
  requestCorrelation: string,
) => Effect.Effect<MarketAffectedUseAssessmentResponse, Failure>;

type ExecuteMarketRetirementReservation<Failure> = (
  payload: ReserveMarketRetirementPayload,
  requestCorrelation: string,
  idempotencyKey: string,
) => Effect.Effect<ReserveMarketRetirementResult, Failure>;

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
const productionClientConfiguration = Config.all({
  customerContextBaseUrl: Config.schema(httpUrl, 'ONTOS_COMMERCE_CUSTOMER_CONTEXT_BASE_URL'),
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

const mapReservationFailure = (
  cause: unknown,
): MarketRetirementImpactAssessmentRejected | MarketRetirementImpactAssessmentUnavailable => {
  const code = Schema.is(GatewayFailureSchema)(cause) ? cause.code : undefined;
  return code === 'RETIREMENT_RESERVATION_CONFLICT' ||
    code === 'RESERVATION_STATE_CONFLICT' ||
    code === 'action_request_hash_conflict'
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
  readonly effectiveAt: string;
  readonly expectedMarketRevision: number;
  readonly marketRef: MarketAffectedUseAssessmentRequest['marketRef'];
}): MarketAffectedUseAssessmentRequest => ({
  evaluatedAt: input.effectiveAt,
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

export const makeMarketRetirementImpactAuthority = <AssessmentFailure, ReservationFailure = never>(
  executeAssessment: ExecuteMarketAffectedUseAssessment<AssessmentFailure>,
  executeReservation?: ExecuteMarketRetirementReservation<ReservationFailure>,
): MarketRetirementImpactAuthority => {
  const load = (input: {
    readonly actionInvocationId: string;
    readonly effectiveAt: string;
    readonly expectedMarketRevision: number;
    readonly marketRef: MarketAffectedUseAssessmentRequest['marketRef'];
  }) => {
    const request = requestFor(input);
    return executeAssessment(request, input.actionInvocationId).pipe(
      Effect.mapError((cause) =>
        unavailable('The Customer Context Market retirement-impact authority is unavailable', cause),
      ),
      Effect.flatMap((response) => toVerifiedAssessment(request, response)),
    );
  };
  const unavailableReservation = () =>
    Effect.fail(unavailable('The Customer Context Market retirement reservation authority is unavailable'));
  const finishReservation = (
    operation: 'COMMIT' | 'RELEASE',
    input: {
      readonly actionInvocationId: string;
      readonly assessment: ReservedMarketRetirementImpactAssessment;
      readonly reason: string;
    },
  ) => {
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
    return executeReservation(
      payload,
      input.actionInvocationId,
      `${input.actionInvocationId}:${operation.toLowerCase()}`,
    ).pipe(
      Effect.mapError(mapReservationFailure),
      Effect.flatMap((result) =>
        finishedReservationMatches(result, input.assessment, operation === 'COMMIT' ? 'COMMITTED' : 'RELEASED')
          ? Effect.void
          : Effect.fail(stale(`Customer Context returned mismatched ${operation} reservation evidence`)),
      ),
    );
  };
  return {
    assessRetirementImpact: (input) =>
      load(input).pipe(
        Effect.map(({ assessment }) => assessment),
        Effect.withSpan('MarketRetirementImpactAuthority.assessRetirementImpact'),
      ),
    commitRetirementImpact: (input) => finishReservation('COMMIT', input),
    releaseRetirementImpact: (input) => finishReservation('RELEASE', input),
    reserveRetirementImpact: (input) => {
      if (executeReservation === undefined) {
        return unavailableReservation();
      }
      return load(input).pipe(
        Effect.flatMap(({ assessment, response }) => {
          const payload: ReserveMarketRetirementPayload = {
            assessmentDigest: response.assessmentDigest,
            evaluatedAt: response.evaluatedAt,
            marketRef: response.marketRef,
            marketRevision: response.marketRevision,
            operation: 'RESERVE',
            reason: input.reason,
            sourceEvidence: response.sourceEvidence,
            tenantId: response.tenantId,
          };
          return executeReservation(payload, input.actionInvocationId, `${input.actionInvocationId}:reserve`).pipe(
            Effect.mapError(mapReservationFailure),
            Effect.flatMap((result) =>
              result.lifecycle === 'RESERVED' && reservationResultMatches(result, assessment)
                ? Effect.succeed({
                    ...assessment,
                    reservation: { token: result.reservationToken, version: result.reservationVersion },
                  })
                : Effect.fail(stale('Customer Context returned mismatched RESERVED reservation evidence')),
            ),
          );
        }),
        Effect.withSpan('MarketRetirementImpactAuthority.reserveRetirementImpact'),
      );
    },
  };
};

export const makeMarketRetirementImpactAuthorityFromPublishedClient = () =>
  makeMarketRetirementImpactAuthority(
    (payload, requestCorrelation) =>
      productionClientConfiguration.pipe(
        Effect.flatMap(({ customerContextBaseUrl, shellGatewayBaseUrl }) =>
          issueGatewayContext({ audience: 'commerce-customer-context' }, { baseUrl: shellGatewayBaseUrl }).pipe(
            Effect.flatMap(({ token }) =>
              executeMarketAffectedUseAssessmentWithAuthorization(payload, `Bearer ${token}`, requestCorrelation, {
                baseUrl: customerContextBaseUrl,
              }),
            ),
          ),
        ),
      ),
    (payload, requestCorrelation, idempotencyKey) =>
      productionClientConfiguration.pipe(
        Effect.flatMap(({ customerContextBaseUrl, shellGatewayBaseUrl }) =>
          issueGatewayContext({ audience: 'commerce-customer-context' }, { baseUrl: shellGatewayBaseUrl }).pipe(
            Effect.flatMap(({ token }) =>
              executeReserveMarketRetirementWithAuthorization(payload, `Bearer ${token}`, requestCorrelation, {
                baseUrl: customerContextBaseUrl,
                idempotencyKey,
              }),
            ),
          ),
        ),
      ),
  );

export const MarketRetirementImpactAuthorityLive = Layer.succeed(
  MarketRetirementImpactAuthorityService,
  makeMarketRetirementImpactAuthorityFromPublishedClient(),
);
