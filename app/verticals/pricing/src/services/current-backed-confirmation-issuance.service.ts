import {
  PricingCommitmentConfirmationBindingSchema,
  PricingCommitmentConfirmationIssuedSchema,
  PricingCurrentBackedConfirmationIssuanceRequestSchema,
  PricingCurrentBackedConfirmationSourceSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import type {
  PricingCommitmentConfirmationAuthenticityProof,
  PricingCommitmentConfirmationBinding,
  PricingCommitmentConfirmationIssuanceOutcome,
  PricingCommitmentConfirmationIssued,
  PricingCurrentBackedConfirmationIssuanceRequest,
  PricingCurrentBackedConfirmationSource,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import {
  PricingCommercialTotalReadySchema,
  PricingCommercialTotalSafeProjectionSchema,
} from '@app/pricing-contracts/domain/commercial-total';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import { PricingMaterialCalculationVersionsSchema } from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingFreshAttemptOutcomeSchema,
  PricingKnownInvalidOrConflictOutcomeSchema,
} from '@app/pricing-contracts/domain/material-change';
import {
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import type { PricingSourceEvidenceResult } from '@app/pricing-contracts/domain/source-revision-evidence';
import { Context, DateTime, Effect, Match, Option, Schema } from 'effect';

import { projectPricingCommercialTotal } from './commercial-total-projection.service.ts';
import type {
  PricingCurrentBackedConfirmationBindingRejected,
  PricingCurrentBackedConfirmationUnavailable,
} from './current-backed-confirmation-issuance-errors.ts';
import type {
  PricingOrdinaryCurrentEvaluationService,
  PricingOrdinaryCurrentPublished,
  PricingOrdinaryCurrentTerminalFailure,
} from './ordinary-current-pricing-evaluation.service.ts';

const MAX_CONFIRMATION_DURATION_MILLISECONDS = 30_000;

export {
  PricingCurrentBackedConfirmationBindingRejected,
  PricingCurrentBackedConfirmationUnavailable,
} from './current-backed-confirmation-issuance-errors.ts';

export interface PricingCurrentBackedConfirmationSourceAuthority {
  /**
   * Returns the owner-retained full result and #786 evidence for the exact accepted #787 attempt.
   * It must not reconstruct internal evidence from the customer-safe publication projection.
   */
  readonly resolveCurrentSource: (input: {
    readonly binding: PricingCommitmentConfirmationBinding;
    readonly evaluation: PricingOrdinaryCurrentPublished;
  }) => Effect.Effect<PricingCurrentBackedConfirmationSource, PricingCurrentBackedConfirmationUnavailable>;
}

export interface PricingCurrentBackedConfirmationBindingAuthority {
  /** Final owner check that the permanent Attempt still names this exact unchanged Bundle. */
  readonly verifyUnchangedBinding: (input: {
    readonly binding: PricingCommitmentConfirmationBinding;
    readonly issuedAt: typeof PricingInstantSchema.Type;
    readonly source: PricingCurrentBackedConfirmationSource;
  }) => Effect.Effect<
    void,
    PricingCurrentBackedConfirmationBindingRejected | PricingCurrentBackedConfirmationUnavailable
  >;
}

export interface PricingCurrentBackedConfirmationTrustedTime {
  readonly readIssuedAt: Effect.Effect<string, PricingCurrentBackedConfirmationUnavailable>;
}

export interface PricingCurrentBackedConfirmationValidityPolicy {
  readonly selectDurationMilliseconds: (input: {
    readonly binding: PricingCommitmentConfirmationBinding;
    readonly issuedAt: typeof PricingInstantSchema.Type;
    readonly source: PricingCurrentBackedConfirmationSource;
  }) => Effect.Effect<number, PricingCurrentBackedConfirmationUnavailable>;
}

export interface PricingCurrentBackedConfirmationProofIssuer {
  /** Owner-private identity and signing capability over the complete immutable payload. */
  readonly issueProof: (
    input: Omit<PricingCommitmentConfirmationIssued, 'authenticity' | 'confirmationRef' | 'kind'>,
  ) => Effect.Effect<
    {
      readonly authenticity: PricingCommitmentConfirmationAuthenticityProof;
      readonly confirmationRef: string;
    },
    PricingCurrentBackedConfirmationUnavailable
  >;
}

export interface PricingCurrentBackedConfirmationIssuanceService {
  readonly issue: (
    request: PricingCurrentBackedConfirmationBindingRequest | PricingCurrentBackedConfirmationIssuanceRequest,
  ) => Effect.Effect<PricingCommitmentConfirmationIssuanceOutcome>;
}

/** Owner-internal entry used by Current-backed renewal; source is always resolved fresh. */
export interface PricingCurrentBackedConfirmationBindingRequest {
  readonly binding: PricingCommitmentConfirmationBinding;
}

const PricingCurrentBackedConfirmationBindingRequestSchema = Schema.Struct({
  binding: PricingCommitmentConfirmationBindingSchema,
});

export interface PricingCurrentBackedConfirmationIssuanceDependencies {
  readonly bindingAuthority: PricingCurrentBackedConfirmationBindingAuthority;
  readonly currentEvaluation: PricingOrdinaryCurrentEvaluationService;
  readonly proofIssuer: PricingCurrentBackedConfirmationProofIssuer;
  readonly sourceAuthority: PricingCurrentBackedConfirmationSourceAuthority;
  readonly trustedTime: PricingCurrentBackedConfirmationTrustedTime;
  readonly validityPolicy: PricingCurrentBackedConfirmationValidityPolicy;
}

export class PricingCurrentBackedConfirmationIssuance extends Context.Service<
  PricingCurrentBackedConfirmationIssuance,
  PricingCurrentBackedConfirmationIssuanceService
>()('@app/pricing/services/current-backed-confirmation-issuance.service/PricingCurrentBackedConfirmationIssuance') {}

const boundedReason = (reason: string): string => {
  const normalized = reason.trim();
  return (normalized.length === 0 ? 'Pricing Confirmation prerequisite could not be verified' : normalized).slice(
    0,
    1000,
  );
};

const sourceInvalid = (reason: string): PricingCommitmentConfirmationIssuanceOutcome => ({
  _tag: 'SOURCE_INVALID',
  reason: boundedReason(reason),
  retryable: false,
});

const sourceUnverifiable = (reason: string, retryable = true): PricingCommitmentConfirmationIssuanceOutcome => ({
  _tag: 'SOURCE_UNVERIFIABLE',
  reason: boundedReason(reason),
  retryable,
});

const currentFailureOutcome = (
  failure: PricingOrdinaryCurrentTerminalFailure,
): PricingCommitmentConfirmationIssuanceOutcome =>
  Schema.is(PricingKnownInvalidOrConflictOutcomeSchema)(failure)
    ? sourceInvalid(failure.reason)
    : sourceUnverifiable('A fresh complete ordinary Current Pricing evaluation is unavailable');

const sameSource = Schema.toEquivalence(PricingCurrentBackedConfirmationSourceSchema);
const sameCurrentness = Schema.toEquivalence(PricingFreshAttemptOutcomeSchema);
const sameCommercialTotal = Schema.toEquivalence(PricingCommercialTotalReadySchema);
const sameSafeProjection = Schema.toEquivalence(PricingCommercialTotalSafeProjectionSchema);
const sameCalculationVersions = Schema.toEquivalence(PricingMaterialCalculationVersionsSchema);

const materialSources = (source: PricingCurrentBackedConfirmationSource): readonly PricingSourceEvidenceResult[] => {
  const evidence = source.materialEvidence.sourceEvidence;
  return [
    ...evidence.externalOwnerEvidence.catalogSelections.map(({ sourceEvidence }) => sourceEvidence),
    evidence.externalOwnerEvidence.market,
    ...(evidence.externalOwnerEvidence.priceGroupAssignment === undefined
      ? []
      : [evidence.externalOwnerEvidence.priceGroupAssignment]),
    ...(evidence.externalOwnerEvidence.promotion.kind === 'PROMOTION_SELECTED'
      ? [evidence.externalOwnerEvidence.promotion.sourceEvidence]
      : []),
    evidence.currencySupport,
    ...evidence.lines.flatMap(({ commercialFees, lineDiscounts, pricePath, quantityTiers, zeroFloor }) => [
      pricePath.usedPrice,
      ...(pricePath.assignedGroupAbsence === undefined ? [] : [pricePath.assignedGroupAbsence]),
      quantityTiers,
      ...(lineDiscounts.kind === 'DISCOUNT_SELECTED' ? [lineDiscounts.sourceEvidence] : []),
      commercialFees,
      ...(zeroFloor === undefined ? [] : [zeroFloor]),
    ]),
    ...(evidence.wholePurchase.contractualDiscounts.kind === 'DISCOUNT_SELECTED'
      ? [evidence.wholePurchase.contractualDiscounts.sourceEvidence]
      : []),
  ];
};

const sourceIsCurrentAt = (
  source: PricingCurrentBackedConfirmationSource,
  issuedAt: typeof PricingInstantSchema.Type,
): boolean =>
  materialSources(source).every((evidence) => {
    if (
      !Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(evidence) &&
      !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(evidence)
    ) {
      return false;
    }
    const boundary = evidence.completeness.temporal.nextMaterialBoundary;
    return boundary === undefined || issuedAt < boundary;
  });

const validateResolvedSource = Effect.fn('PricingCurrentBackedConfirmationIssuance.validateResolvedSource')(
  function* validateResolvedSourceProgram(
    expectedSource: PricingCurrentBackedConfirmationSource | undefined,
    evaluation: PricingOrdinaryCurrentPublished,
    resolvedSource: PricingCurrentBackedConfirmationSource,
  ) {
    const decodedSource = Schema.decodeOption(PricingCurrentBackedConfirmationSourceSchema, {
      onExcessProperty: 'error',
    })(resolvedSource);
    if (
      Option.isNone(decodedSource) ||
      (expectedSource !== undefined && !sameSource(expectedSource, decodedSource.value))
    ) {
      return yield* Effect.fail(
        sourceInvalid('The requested Current source is not the exact owner-retained source for this evaluation'),
      );
    }
    const source = decodedSource.value;
    if (!sameCurrentness(source.currentness, evaluation.currentness)) {
      return yield* Effect.fail(
        sourceInvalid('The Current source does not preserve the exact accepted fresh #787 evaluation attempt'),
      );
    }
    if (
      !sameCommercialTotal(
        source.currentResult.commercialTotal,
        source.materialEvidence.sourceEvidence.commercialTotal,
      ) ||
      !sameCalculationVersions(
        source.materialEvidence.calculationVersions,
        source.currentness.attempt.snapshot.calculationVersions,
      )
    ) {
      return yield* Effect.fail(
        sourceInvalid('The Current result, material evidence, and accepted attempt are not one coherent aggregate'),
      );
    }
    const projection = yield* projectPricingCommercialTotal(source.currentResult.commercialTotal).pipe(
      Effect.mapError((cause) => {
        void cause;
        return sourceInvalid('The full Current result cannot reproduce the accepted safe publication');
      }),
    );
    if (!sameSafeProjection(projection, evaluation.publication)) {
      return yield* Effect.fail(
        sourceInvalid('The full Current result does not equal the exact accepted #787 publication'),
      );
    }
    return source;
  },
);

const expiresAtFor = (
  issuedAt: typeof PricingInstantSchema.Type,
  durationMilliseconds: number,
): Effect.Effect<typeof PricingInstantSchema.Type, PricingCommitmentConfirmationIssuanceOutcome> =>
  Effect.try({
    catch: (cause) => {
      void cause;
      return sourceInvalid('The owner validity policy produced an invalid Confirmation interval');
    },
    try: () =>
      DateTime.makeUnsafe(issuedAt).pipe(DateTime.add({ milliseconds: durationMilliseconds }), DateTime.formatIso),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PricingInstantSchema)),
    Effect.mapError((cause) => {
      void cause;
      return sourceInvalid('The owner validity policy produced an invalid Confirmation interval');
    }),
  );

/**
 * Current-backed issuance only. Quotation-backed issuance, renewal, persistence, and Order commit
 * verification are separate paths. Once issued, ordinary source changes do not revoke this proof.
 */
export const makePricingCurrentBackedConfirmationIssuanceService = (
  dependencies: PricingCurrentBackedConfirmationIssuanceDependencies,
): PricingCurrentBackedConfirmationIssuanceService => ({
  issue: Effect.fn('PricingCurrentBackedConfirmationIssuance.issue')(function* issueCurrentBackedConfirmation(input) {
    const requestOption = Schema.decodeUnknownOption(PricingCurrentBackedConfirmationIssuanceRequestSchema, {
      onExcessProperty: 'error',
    })(input);
    const bindingRequestOption = Schema.decodeOption(PricingCurrentBackedConfirmationBindingRequestSchema, {
      onExcessProperty: 'error',
    })(input);
    const candidateOption = Option.isSome(requestOption)
      ? Option.some({ binding: requestOption.value.binding, expectedSource: Option.some(requestOption.value.source) })
      : bindingRequestOption.pipe(Option.map(({ binding }) => ({ binding, expectedSource: Option.none() })));
    if (Option.isNone(candidateOption)) {
      return sourceInvalid('The Current-backed Confirmation issuance request is invalid');
    }
    const { binding, expectedSource } = candidateOption.value;

    const evaluationResult = yield* dependencies.currentEvaluation.evaluate.pipe(
      Effect.match({
        onFailure: (failure) => ({ failure }) as const,
        onSuccess: (evaluation) => ({ evaluation }) as const,
      }),
    );
    if ('failure' in evaluationResult) {
      return currentFailureOutcome(evaluationResult.failure);
    }
    const { evaluation } = evaluationResult;

    const sourceResult = yield* dependencies.sourceAuthority.resolveCurrentSource({ binding, evaluation }).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure }) as const,
        onSuccess: (source) => ({ source }) as const,
      }),
    );
    if ('failure' in sourceResult) {
      return sourceUnverifiable(sourceResult.failure.reason, sourceResult.failure.retryable);
    }
    const resolvedSourceResult = yield* validateResolvedSource(
      Option.getOrUndefined(expectedSource),
      evaluation,
      sourceResult.source,
    ).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure }) as const,
        onSuccess: (source) => ({ source }) as const,
      }),
    );
    if ('failure' in resolvedSourceResult) {
      return resolvedSourceResult.failure;
    }
    const { source } = resolvedSourceResult;

    const issuedAtResult = yield* dependencies.trustedTime.readIssuedAt.pipe(
      Effect.match({
        onFailure: (failure) => ({ failure }) as const,
        onSuccess: (issuedAt) => ({ issuedAt }) as const,
      }),
    );
    if ('failure' in issuedAtResult) {
      return sourceUnverifiable(issuedAtResult.failure.reason, issuedAtResult.failure.retryable);
    }
    const issuedAtOption = Schema.decodeOption(PricingInstantSchema)(issuedAtResult.issuedAt);
    if (Option.isNone(issuedAtOption)) {
      return sourceUnverifiable('Trusted Pricing Confirmation time is unavailable');
    }
    const issuedAt = issuedAtOption.value;
    if (issuedAt < evaluation.acceptedAttempt.completedAt) {
      return sourceUnverifiable('Trusted issuance time predates the accepted Current evaluation');
    }
    if (!sourceIsCurrentAt(source, issuedAt)) {
      return sourceUnverifiable('Current material evidence crossed a known boundary before issuance');
    }

    const bindingResult = yield* dependencies.bindingAuthority
      .verifyUnchangedBinding({ binding, issuedAt, source })
      .pipe(
        Effect.match({
          onFailure: (failure) => ({ failure }) as const,
          onSuccess: () => ({ verified: true }) as const,
        }),
      );
    if ('failure' in bindingResult) {
      return Match.value(bindingResult.failure).pipe(
        Match.tag('PricingCurrentBackedConfirmationBindingRejected', (failure) => ({
          _tag: 'BINDING_MISMATCH' as const,
          reason: failure.reason,
          retryable: false as const,
        })),
        Match.tag('PricingCurrentBackedConfirmationUnavailable', (failure) =>
          sourceUnverifiable(failure.reason, failure.retryable),
        ),
        Match.exhaustive,
      );
    }

    const durationResult = yield* dependencies.validityPolicy
      .selectDurationMilliseconds({ binding, issuedAt, source })
      .pipe(
        Effect.match({
          onFailure: (failure) => ({ failure }) as const,
          onSuccess: (durationMilliseconds) => ({ durationMilliseconds }) as const,
        }),
      );
    if ('failure' in durationResult) {
      return sourceUnverifiable(durationResult.failure.reason, durationResult.failure.retryable);
    }
    const { durationMilliseconds } = durationResult;
    if (
      !Number.isSafeInteger(durationMilliseconds) ||
      durationMilliseconds <= 0 ||
      durationMilliseconds > MAX_CONFIRMATION_DURATION_MILLISECONDS
    ) {
      return sourceInvalid('The owner validity policy must select a positive interval of at most 30 seconds');
    }
    const expiresAtResult = yield* expiresAtFor(issuedAt, durationMilliseconds).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure }) as const,
        onSuccess: (expiresAt) => ({ expiresAt }) as const,
      }),
    );
    if ('failure' in expiresAtResult) {
      return expiresAtResult.failure;
    }
    const { expiresAt } = expiresAtResult;
    const terms = source.currentResult.commercialTotal;

    const proofResult = yield* dependencies.proofIssuer
      .issueProof({ binding, expiresAt, issuedAt, source, terms })
      .pipe(
        Effect.match({
          onFailure: (failure) => ({ failure }) as const,
          onSuccess: (proof) => ({ proof }) as const,
        }),
      );
    if ('failure' in proofResult) {
      return sourceUnverifiable(proofResult.failure.reason, proofResult.failure.retryable);
    }
    const confirmationOption = Schema.decodeOption(PricingCommitmentConfirmationIssuedSchema, {
      onExcessProperty: 'error',
    })({
      authenticity: proofResult.proof.authenticity,
      binding,
      confirmationRef: proofResult.proof.confirmationRef,
      expiresAt,
      issuedAt,
      kind: 'PRICING_COMMITMENT_CONFIRMATION',
      source,
      terms,
    });
    return Option.isSome(confirmationOption)
      ? { _tag: 'ISSUED', confirmation: confirmationOption.value }
      : sourceUnverifiable('The owner could not mint a valid immutable Pricing Confirmation');
  }),
});
