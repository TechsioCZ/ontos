import { ReserveMarketRetirementConflictProblemSchema } from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import type { MarketRetirementStoredBasis } from '../../shared/market-retirement-admission.ts';
import { MarketRetirementReserveBasisSchema } from '../../shared/market-retirement-admission.ts';
import type { OperationalScope } from '@app/core-runtime';
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
import { Crypto, DateTime, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';

import type {
  MarketRetirementImpactAssessment,
  ReservedMarketRetirementImpactAssessment,
} from '../../shared/domain/market-retirement-impact.ts';
import { MarketRetirementImpactAssessmentRejected } from '../actions/market-retirement-impact-assessment-rejected.ts';
import { MarketRetirementImpactAssessmentStale } from '../actions/market-retirement-impact-assessment-stale.ts';
import { MarketRetirementImpactAssessmentUnavailable } from '../actions/market-retirement-impact-assessment-unavailable.ts';
import { MarketRetirementImpactAuthorityFactory } from '../services/market-retirement-impact-authority.ts';
import type { MarketRetirementImpactAuthority } from '../services/market-retirement-impact-authority.ts';
import { acquireOwnerGatewayContext } from './server-owner-gateway.ts';
import { executeMarketRetirementReservationRecoveryWithAuthorization } from '@app/customer-market-retirement-contracts/market-retirement-reservation-recovery/client';
import type { MarketRetirementReservationRecoveryResponse } from '@app/customer-market-retirement-contracts/market-retirement-reservation-recovery';
import type { RetireMarketPayload } from '../../shared/action-contracts.ts';

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
  context: {
    readonly compositionRevision: string;
    readonly idempotencyKey: string;
    readonly legalEntityId: string;
    readonly requestCorrelation: string;
  },
) => Effect.Effect<ReserveMarketRetirementResult, Failure>;

const CUSTOMER_CONTEXT_MODULE_KEY = 'commerce.customer-context' as const;
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

const definiteReservationFailure = (
  cause: unknown,
): Option.Option<MarketRetirementImpactAssessmentRejected | MarketRetirementImpactAssessmentStale> => {
  if (!Schema.is(ReserveMarketRetirementConflictProblemSchema)(cause)) {
    return Option.none();
  }
  return Match.value(cause.code).pipe(
    Match.when('ASSESSMENT_STALE', () =>
      Option.some(stale('The original Customer Context reservation basis is stale')),
    ),
    Match.when(
      Match.is('LIVE_REFERENCE_CONFLICT', 'RESERVATION_STATE_CONFLICT', 'RETIREMENT_RESERVATION_CONFLICT'),
      () => Option.some(rejected('Customer Context definitively rejected the original reservation')),
    ),
    Match.orElse(() => Option.none()),
  );
};
const mapReservationFailure = (
  cause: unknown,
):
  | MarketRetirementImpactAssessmentRejected
  | MarketRetirementImpactAssessmentStale
  | MarketRetirementImpactAssessmentUnavailable => {
  if (
    Schema.is(MarketRetirementImpactAssessmentRejected)(cause) ||
    Schema.is(MarketRetirementImpactAssessmentStale)(cause) ||
    Schema.is(MarketRetirementImpactAssessmentUnavailable)(cause)
  ) {
    return cause;
  }
  const known = definiteReservationFailure(cause);
  if (Option.isSome(known)) {
    return known.value;
  }
  const code = Schema.is(GatewayFailureSchema)(cause) ? cause.code : undefined;
  if (
    code === 'RETIREMENT_RESERVATION_CONFLICT' ||
    code === 'RESERVATION_STATE_CONFLICT' ||
    code === 'action_request_hash_conflict'
  ) {
    return rejected(errorText(cause));
  }
  return unavailable(errorText(cause), cause);
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
    readonly compositionRevision: string;
    readonly effectiveAt: string;
    readonly expectedMarketRevision: number;
    readonly legalEntityId: string;
    readonly marketRef: MarketAffectedUseAssessmentRequest['marketRef'];
  }) => {
    const request = requestFor(input);
    return executeAssessment(request, {
      compositionRevision: input.compositionRevision,
      legalEntityId: input.legalEntityId,
      requestCorrelation: input.actionInvocationId,
    }).pipe(
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
      readonly compositionRevision: string;
      readonly legalEntityId: string;
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
    return executeReservation(payload, {
      compositionRevision: input.compositionRevision,
      idempotencyKey: `${input.actionInvocationId}:${operation.toLowerCase()}`,
      legalEntityId: input.legalEntityId,
      requestCorrelation: input.actionInvocationId,
    }).pipe(
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
          return executeReservation(payload, {
            compositionRevision: input.compositionRevision,
            idempotencyKey: `${input.actionInvocationId}:reserve`,
            legalEntityId: input.legalEntityId,
            requestCorrelation: input.actionInvocationId,
          }).pipe(
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

const toResult = (
  response: Extract<MarketRetirementReservationRecoveryResponse, { readonly outcome: 'FOUND' }>,
): ReserveMarketRetirementResult => ({
  assessmentDigest: response.assessmentDigest,
  lifecycle: response.lifecycle,
  marketRef: response.marketRef,
  marketRevision: response.marketRevision,
  reservationToken: response.reservationToken,
  reservationVersion: response.reservationVersion,
  tenantId: response.tenantId,
});
const expectedLifecycle = (operation: ReserveMarketRetirementPayload['operation']) =>
  Match.value(operation).pipe(
    Match.when('RESERVE', () => 'RESERVED' as const),
    Match.when('COMMIT', () => 'COMMITTED' as const),
    Match.when('RELEASE', () => 'RELEASED' as const),
    Match.exhaustive,
  );

export const makeMarketRetirementImpactAuthorityFromPublishedClient = ({
  basis,
  compositionRevision,
  crypto,
  originalCompositionRevision,
  releaseGuardHash,
  retirement,
  scope,
  sourceActionInvocationId,
}: {
  readonly basis?: MarketRetirementStoredBasis;
  readonly compositionRevision: string;
  readonly crypto: Crypto.Crypto;
  readonly originalCompositionRevision: string;
  readonly releaseGuardHash: string;
  readonly retirement: RetireMarketPayload;
  readonly scope: OperationalScope;
  readonly sourceActionInvocationId: string;
}) => {
  const gateway = (operationKey: string) =>
    acquireOwnerGatewayContext(
      scope,
      crypto,
      { audience: 'commerce-customer-context', operationKey },
      compositionRevision,
    );
  const recover = () =>
    Effect.gen(function* recoverOriginalReservation() {
      const credential = yield* gateway('commerce.customer-context.api.market-retirement-reservation-recovery');
      const response = yield* executeMarketRetirementReservationRecoveryWithAuthorization(
        {
          marketRef: retirement.marketRef,
          sourceActionInvocationId,
          tenantId: scope.tenantId,
        },
        Redacted.value(credential.authorization),
        scope.correlationId,
        { baseUrl: credential.apiUrl, compositionRevision },
      );
      if (
        response.sourceActionInvocationId !== sourceActionInvocationId ||
        response.tenantId !== scope.tenantId ||
        response.marketRef.resourceId !== retirement.marketRef.resourceId ||
        response.marketRef.moduleId !== retirement.marketRef.moduleId ||
        response.marketRef.resourceType !== retirement.marketRef.resourceType ||
        response.marketRef.tenantId !== retirement.marketRef.tenantId
      ) {
        return yield* unavailable('Recovery does not identify the exact original source effect');
      }
      if (
        response.outcome === 'FOUND' &&
        (response.sourceActionInvocationId !== sourceActionInvocationId ||
          response.originalActorPrincipalId !== scope.principalId ||
          response.tenantId !== scope.tenantId ||
          response.marketRef.resourceId !== retirement.marketRef.resourceId ||
          response.marketRef.tenantId !== retirement.marketRef.tenantId ||
          response.compositionRevision !== originalCompositionRevision ||
          response.originalReason !== retirement.reason ||
          response.marketRevision !== retirement.expectedRevision ||
          response.releaseGuardHash !== releaseGuardHash ||
          response.evaluatedAt !== DateTime.formatIso(retirement.effectiveAt) ||
          response.originalReservationVersion !== 1)
      ) {
        return yield* unavailable('Recovered reservation does not match its immutable original source effect');
      }
      return response;
    }).pipe(
      Effect.mapError((cause) => unavailable('The original retirement reservation could not be recovered', cause)),
    );
  const execute = Effect.fn('MarketRetirement.executeBound')(function* executeBoundReservation(
    payload: ReserveMarketRetirementPayload,
    idempotencyKey: string,
  ) {
    const credential = yield* gateway('commerce.customer-context.reserve-market-retirement');
    return yield* executeReserveMarketRetirementWithAuthorization(
      payload,
      Redacted.value(credential.authorization),
      scope.correlationId,
      { baseUrl: credential.apiUrl, compositionRevision, idempotencyKey },
    );
  });
  const recoverAfterExecuteFailure = Effect.fn('MarketRetirement.recoverAfterExecuteFailure')(
    function* recoverAfterExecuteFailure(
      payload: ReserveMarketRetirementPayload,
      cause: Effect.Error<ReturnType<typeof execute>>,
    ) {
      const recovered = yield* recover();
      if (recovered.outcome === 'FOUND' && recovered.lifecycle === expectedLifecycle(payload.operation)) {
        return toResult(recovered);
      }
      const terminal = definiteReservationFailure(cause);
      if (recovered.outcome === 'NOT_FOUND' && Option.isSome(terminal)) {
        return yield* terminal.value;
      }
      return yield* unavailable('Original reservation settlement remains pending', cause);
    },
  );
  const executeRecoverably = Effect.fn('MarketRetirement.executeOrRecover')(function* executeOrRecover(
    payload: ReserveMarketRetirementPayload,
    idempotencyKey: string,
  ) {
    const prior = yield* recover();
    if (prior.outcome === 'FOUND') {
      if (prior.lifecycle === expectedLifecycle(payload.operation)) {
        if (payload.operation === 'RESERVE' && prior.assessmentDigest !== payload.assessmentDigest) {
          return yield* stale('The original reservation belongs to different assessment evidence');
        }
        return toResult(prior);
      }
      if (payload.operation === 'RESERVE' || prior.lifecycle !== 'RESERVED') {
        return yield* unavailable('The original reservation is in an incompatible terminal state');
      }
    } else if (payload.operation !== 'RESERVE') {
      return yield* unavailable('An absent reservation cannot prove a delayed original request has settled');
    }
    return yield* execute(payload, idempotencyKey).pipe(
      Effect.matchEffect({
        onFailure: (cause) => recoverAfterExecuteFailure(payload, cause),
        onSuccess: Effect.succeed,
      }),
    );
  });
  const authority = makeMarketRetirementImpactAuthority(
    Effect.fn('MarketRetirement.assessExactOwner')(function* assessExactOwner(
      payload: Parameters<ExecuteMarketAffectedUseAssessment<never>>[0],
      context: Parameters<ExecuteMarketAffectedUseAssessment<never>>[1],
    ) {
      if (
        payload.tenantId !== scope.tenantId ||
        context.compositionRevision !== compositionRevision ||
        context.legalEntityId !== scope.legalEntityId
      ) {
        return yield* unavailable('Retirement requires the original trusted scope');
      }
      const credential = yield* gateway('commerce.customer-context.api.market-affected-use-assessment');
      return yield* executeMarketAffectedUseAssessmentWithAuthorization(
        payload,
        Redacted.value(credential.authorization),
        scope.correlationId,
        { baseUrl: credential.apiUrl, compositionRevision },
      );
    }),
    (payload, context) => {
      if (
        context.compositionRevision !== compositionRevision ||
        context.legalEntityId !== scope.legalEntityId ||
        payload.tenantId !== scope.tenantId
      ) {
        return Effect.fail(unavailable('Reservation requires the original trusted scope'));
      }
      return executeRecoverably(
        payload.operation === 'RESERVE' ? { ...payload, releaseGuardHash, sourceActionInvocationId } : payload,
        context.idempotencyKey,
      );
    },
  );
  const reserveOriginal = Effect.fn('MarketRetirementImpactAuthority.reserveOriginal')(function* reserveOriginal(
    input: Parameters<MarketRetirementImpactAuthority['reserveRetirementImpact']>[0],
  ) {
    if (
      input.actionInvocationId !== sourceActionInvocationId ||
      input.compositionRevision !== originalCompositionRevision ||
      compositionRevision !== originalCompositionRevision ||
      input.legalEntityId !== scope.legalEntityId ||
      input.marketRef.resourceId !== retirement.marketRef.resourceId ||
      input.marketRef.tenantId !== scope.tenantId ||
      input.expectedMarketRevision !== retirement.expectedRevision ||
      input.effectiveAt !== DateTime.formatIso(retirement.effectiveAt) ||
      input.reason !== retirement.reason
    ) {
      return yield* unavailable('Reservation must remain bound to the exact original retirement admission');
    }
    if (basis === undefined) {
      return yield* unavailable('The original reserve basis has not been durably prepared');
    }
    const original = yield* recover();
    if (original.outcome === 'FOUND') {
      if (
        original.lifecycle !== 'RESERVED' ||
        original.reservationVersion !== original.originalReservationVersion ||
        original.assessmentDigest !== basis.reserve.assessmentDigest
      ) {
        return yield* unavailable('The original reservation is not the exact unsettled prepared effect');
      }
      return {
        ...basis.assessment,
        reservation: { token: original.reservationToken, version: original.originalReservationVersion },
      };
    }
    const reserve = yield* Schema.decodeUnknownEffect(MarketRetirementReserveBasisSchema)(basis.reserve).pipe(
      Effect.mapError((cause) => unavailable('The original reserve basis cannot be decoded', cause)),
    );
    const reserved = yield* executeRecoverably(
      {
        ...reserve,
        marketRef: retirement.marketRef,
        marketRevision: retirement.expectedRevision,
        operation: 'RESERVE',
        reason: retirement.reason,
        releaseGuardHash,
        sourceActionInvocationId,
        tenantId: scope.tenantId,
      },
      `${sourceActionInvocationId}:reserve`,
    );
    if (reserved.lifecycle !== 'RESERVED' || !reservationResultMatches(reserved, basis.assessment)) {
      return yield* stale('The original RESERVE result differs from its prepared basis');
    }
    return {
      ...basis.assessment,
      reservation: { token: reserved.reservationToken, version: reserved.reservationVersion },
    };
  });
  return {
    ...authority,
    cleanupOriginal: (releaseProof: string) =>
      recover().pipe(
        Effect.flatMap((original) => {
          if (original.outcome === 'NOT_FOUND') {
            return Effect.fail(
              unavailable('Cleanup remains pending until a delayed original reservation is excluded or recovered'),
            );
          }
          if (original.lifecycle === 'RELEASED') {
            return Effect.void;
          }
          if (original.lifecycle !== 'RESERVED') {
            return Effect.fail(
              unavailable('An owner-aborted retirement cannot release a committed foreign reservation'),
            );
          }
          return executeRecoverably(
            {
              marketRef: original.marketRef,
              marketRevision: original.marketRevision,
              operation: 'RELEASE',
              reason: original.originalReason,
              releaseProof,
              reservationToken: original.reservationToken,
              reservationVersion: original.originalReservationVersion,
              tenantId: original.tenantId,
            },
            `${sourceActionInvocationId}:release`,
          ).pipe(Effect.asVoid);
        }),
      ),
    reserveRetirementImpact: reserveOriginal,
  };
};

/** Crypto is captured at the native Layer root; configuration and HTTP stay lazy per attempt. */
export const MarketRetirementImpactAuthorityLive = Layer.effect(
  MarketRetirementImpactAuthorityFactory,
  Effect.gen(function* retirementAuthorityFactory() {
    const crypto = yield* Crypto.Crypto;
    return {
      forAdmission: (attempt) => makeMarketRetirementImpactAuthorityFromPublishedClient({ ...attempt, crypto }),
      prepareBasis: Effect.fn('MarketRetirementImpact.prepareBasis')(function* prepareBasis(attempt) {
        const { compositionRevision, retirement, scope } = attempt;
        if (scope.legalEntityId === undefined || retirement.marketRef.tenantId !== scope.tenantId) {
          return yield* unavailable(
            'The original retirement basis requires exact trusted Tenant and Legal Entity scope',
          );
        }
        const credential = yield* acquireOwnerGatewayContext(
          scope,
          crypto,
          {
            audience: 'commerce-customer-context',
            operationKey: 'commerce.customer-context.api.market-affected-use-assessment',
          },
          compositionRevision,
        ).pipe(Effect.mapError((cause) => unavailable('The original retirement gateway is unavailable', cause)));
        const request = requestFor({
          effectiveAt: DateTime.formatIso(retirement.effectiveAt),
          expectedMarketRevision: retirement.expectedRevision,
          marketRef: retirement.marketRef,
        });
        const response = yield* executeMarketAffectedUseAssessmentWithAuthorization(
          request,
          Redacted.value(credential.authorization),
          scope.correlationId,
          { baseUrl: credential.apiUrl, compositionRevision },
        ).pipe(Effect.mapError((cause) => unavailable('The original retirement basis is unavailable', cause)));
        const verified = yield* toVerifiedAssessment(request, response);
        const reserve = yield* Schema.encodeEffect(MarketRetirementReserveBasisSchema)(verified.response).pipe(
          Effect.mapError((cause) => unavailable('The original retirement basis cannot be retained', cause)),
        );
        return { assessment: verified.assessment, reserve };
      }),
    };
  }),
);
