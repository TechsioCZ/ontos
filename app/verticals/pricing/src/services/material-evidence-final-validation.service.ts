import type {
  PricingMaterialEvidenceAssemblyRequest,
  PricingMaterialEvidenceFenceSource,
  PricingMaterialEvidenceFailure,
  PricingMaterialEvidenceReady,
  PricingOwnerMaterialEvidenceFenceGatewayRequest,
} from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingSetBackedMaterialEvidenceFenceSourceSchema,
  PricingMaterialEvidenceUnverifiableFailure,
  PricingOwnerMaterialEvidenceFenceGatewayRequestSchema,
} from '@app/pricing-contracts/domain/material-evidence';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import type {
  PricingSourceEvidenceFamily,
  PricingSourceEvidenceResult,
  PricingSourceEvidenceVerifiedAbsent,
  PricingSourceEvidenceVerifiedPresent,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import {
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceFamilySchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from '@app/pricing-contracts/domain/source-revision-evidence';
import { Context, Effect, Schema } from 'effect';

import { assemblePricingMaterialEvidence } from './material-evidence-assembly.service.ts';

type PricingInstant = typeof PricingInstantSchema.Type;
type VerifiedSourceEvidence = PricingSourceEvidenceVerifiedAbsent | PricingSourceEvidenceVerifiedPresent;

export interface PricingMaterialEvidenceFenceFact {
  readonly factRef: string;
  readonly factRevisionRef: string;
  readonly verificationRef: string;
}

/**
 * One owner-resolved proof at the final publication fence. The owner obtains both invalidation
 * generations from private state: the generation recorded by the original opaque proof and the
 * generation that is Current in the same atomic owner snapshot.
 */
export interface PricingMaterialEvidenceFenceSourceObservation {
  readonly currencyCode?: string | undefined;
  readonly currentFacts: readonly PricingMaterialEvidenceFenceFact[];
  readonly currentInvalidationGenerationRef: string;
  readonly currentOwnerSetRevisionRef: string;
  readonly evidenceInvalidationGenerationRef: string;
  readonly evidenceVerificationRef: string;
  readonly family: PricingSourceEvidenceFamily;
  readonly observedAt: PricingInstant;
  readonly ownerModuleId: string;
  readonly ownerRootRef: string;
  readonly predicateRef: string;
  readonly tenantId: string;
}

export interface PricingMaterialEvidenceFenceExpectation {
  readonly currencyCode?: string;
  readonly currentFacts: readonly PricingMaterialEvidenceFenceFact[];
  readonly evidenceObservedAt: PricingInstant;
  readonly evidenceVerificationRef: string;
  readonly family: PricingSourceEvidenceFamily;
  readonly nextMaterialBoundary?: PricingInstant;
  readonly ownerModuleId: string;
  readonly ownerRootRef: string;
  readonly ownerSetRevisionRef: string;
  readonly predicateRef: string;
  readonly tenantId: string;
}

export interface PricingMaterialEvidenceOwnerFenceRequest {
  readonly candidateRef: string;
  readonly sources: readonly PricingMaterialEvidenceFenceExpectation[];
  /** Carries exact owner-native predicates when the caller retained a lossless owner fence request. */
  readonly verificationRequest?: PricingOwnerMaterialEvidenceFenceGatewayRequest;
}

export interface PricingMaterialEvidenceOwnerFenceEvidence {
  readonly fenceRef: string;
  /** Trusted completion of the aggregate fence; never a replacement for an owner's observation. */
  readonly observedAt: PricingInstant;
  readonly sources: readonly PricingMaterialEvidenceFenceSourceObservation[];
}

/** The owner proved that material Current state no longer matches the attempted coherent snapshot. */
export class PricingMaterialEvidenceChangedAtFinalFence extends Schema.TaggedError<PricingMaterialEvidenceChangedAtFinalFence>()(
  'PricingMaterialEvidenceChangedAtFinalFence',
  {
    candidateRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed()),
    family: PricingSourceEvidenceFamilySchema,
    predicateRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed()),
    reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed()),
    retryable: Schema.Literal(true),
  },
) {}

export type PricingMaterialEvidenceOwnerFenceFailure =
  | PricingMaterialEvidenceChangedAtFinalFence
  | PricingMaterialEvidenceUnverifiableFailure;

export interface PricingMaterialEvidenceOwnerFencePort {
  /**
   * Resolve every opaque proof through its owning boundary. Each source observation must be one
   * coherent owner snapshot; the aggregate completion time may follow those distinct observations.
   * Implementations must never rewrite owner timestamps to the aggregate completion time.
   */
  readonly verifyImmediatelyBeforePublication: (
    request: PricingMaterialEvidenceOwnerFenceRequest,
  ) => Effect.Effect<PricingMaterialEvidenceOwnerFenceEvidence, PricingMaterialEvidenceOwnerFenceFailure>;
}

export class PricingMaterialEvidenceOwnerFinalFence extends Context.Service<
  PricingMaterialEvidenceOwnerFinalFence,
  PricingMaterialEvidenceOwnerFencePort
>()('@app/pricing/services/material-evidence-final-validation.service/PricingMaterialEvidenceOwnerFinalFence') {}

export interface PricingMaterialEvidencePublicationAuthorization {
  readonly finalFenceEvidence: PricingMaterialEvidenceOwnerFenceEvidence;
  readonly materialEvidence: PricingMaterialEvidenceReady;
  readonly outcome: 'PRICING_MATERIAL_EVIDENCE_PUBLICATION_AUTHORIZED';
}

export interface PricingMaterialEvidenceFinalizationRequest {
  readonly request: PricingMaterialEvidenceAssemblyRequest;
}

const stableFacts = (facts: readonly PricingMaterialEvidenceFenceFact[]): readonly PricingMaterialEvidenceFenceFact[] =>
  [...facts].toSorted((left, right) =>
    `${left.factRef}\u0000${left.factRevisionRef}\u0000${left.verificationRef}`.localeCompare(
      `${right.factRef}\u0000${right.factRevisionRef}\u0000${right.verificationRef}`,
    ),
  );

const sameFacts = (
  expected: readonly PricingMaterialEvidenceFenceFact[],
  actual: readonly PricingMaterialEvidenceFenceFact[],
): boolean => {
  const stableExpected = stableFacts(expected);
  const stableActual = stableFacts(actual);
  return (
    stableExpected.length === stableActual.length &&
    stableExpected.every((fact, index) => {
      const observed = stableActual[index];
      return (
        observed !== undefined &&
        observed.factRef === fact.factRef &&
        observed.factRevisionRef === fact.factRevisionRef &&
        observed.verificationRef === fact.verificationRef
      );
    })
  );
};

const expectationFrom = (source: VerifiedSourceEvidence): PricingMaterialEvidenceFenceExpectation => {
  const { completeness } = source;
  const base = {
    currentFacts: Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source)
      ? source.currentFacts.map(({ factRef, factRevisionRef, verification }) => ({
          factRef,
          factRevisionRef,
          verificationRef: verification.verificationRef,
        }))
      : [],
    evidenceObservedAt: completeness.temporal.observedAt,
    evidenceVerificationRef: completeness.verification.verificationRef,
    family: completeness.family,
    ownerModuleId: completeness.ownerScope.ownerModuleId,
    ownerRootRef: completeness.ownerScope.ownerRootRef,
    ownerSetRevisionRef: completeness.ownerSetRevisionRef,
    predicateRef: completeness.ownerScope.predicateRef,
    tenantId: completeness.ownerScope.tenantId,
  };
  const withCurrency =
    completeness.currencyCode === undefined ? base : { ...base, currencyCode: completeness.currencyCode };
  return completeness.temporal.nextMaterialBoundary === undefined
    ? withCurrency
    : { ...withCurrency, nextMaterialBoundary: completeness.temporal.nextMaterialBoundary };
};

const collectSourceEvidence = (
  request: PricingMaterialEvidenceAssemblyRequest,
): readonly PricingSourceEvidenceResult[] => [
  ...request.externalOwnerEvidence.catalogSelections.map(({ sourceEvidence }) => sourceEvidence),
  request.externalOwnerEvidence.market,
  ...(request.externalOwnerEvidence.priceGroupAssignment === undefined
    ? []
    : [request.externalOwnerEvidence.priceGroupAssignment]),
  ...(request.externalOwnerEvidence.promotion.kind === 'PROMOTION_SELECTED'
    ? [request.externalOwnerEvidence.promotion.sourceEvidence]
    : []),
  request.currencySupport,
  ...request.lines.flatMap(({ commercialFees, lineDiscounts, pricePath, quantityTiers, zeroFloor }) => [
    pricePath.usedPrice,
    ...(pricePath.assignedGroupAbsence === undefined ? [] : [pricePath.assignedGroupAbsence]),
    quantityTiers,
    ...(lineDiscounts.kind === 'DISCOUNT_SELECTED' ? [lineDiscounts.sourceEvidence] : []),
    commercialFees,
    ...(zeroFloor === undefined ? [] : [zeroFloor]),
  ]),
  ...(request.wholePurchase.contractualDiscounts.kind === 'DISCOUNT_SELECTED'
    ? [request.wholePurchase.contractualDiscounts.sourceEvidence]
    : []),
];

const unverifiable = (
  candidateRef: string,
  reason: string,
  retryable: boolean,
  expectation?: PricingMaterialEvidenceFenceExpectation,
): PricingMaterialEvidenceUnverifiableFailure => {
  const fields = { candidateRef, reason, retryable };
  return expectation === undefined
    ? new PricingMaterialEvidenceUnverifiableFailure(fields)
    : new PricingMaterialEvidenceUnverifiableFailure({
        ...fields,
        family: expectation.family,
        predicateRef: expectation.predicateRef,
      });
};

const changedAtFinalFence = (
  candidateRef: string,
  expectation: PricingMaterialEvidenceFenceExpectation,
): PricingMaterialEvidenceChangedAtFinalFence =>
  new PricingMaterialEvidenceChangedAtFinalFence({
    candidateRef,
    family: expectation.family,
    predicateRef: expectation.predicateRef,
    reason: 'Material owner state changed after the coherent Pricing attempt was evaluated',
    retryable: true,
  });

const sameSourceEvidence = Schema.toEquivalence(PricingSourceEvidenceResultSchema);

const deduplicateVerifiedSourceEvidence = (
  candidateRef: string,
  sources: readonly PricingSourceEvidenceResult[],
): Effect.Effect<readonly VerifiedSourceEvidence[], PricingMaterialEvidenceUnverifiableFailure> => {
  const byVerificationRef = new Map<string, VerifiedSourceEvidence>();
  for (const source of sources) {
    if (
      !Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source) &&
      !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(source)
    ) {
      return Effect.fail(
        unverifiable(candidateRef, 'Final owner fence requires a verified source proof for every material input', true),
      );
    }
    const { completeness } = source;
    const { verification } = completeness;
    const { verificationRef } = verification;
    const retained = byVerificationRef.get(verificationRef);
    if (retained !== undefined && !sameSourceEvidence(retained, source)) {
      return Effect.fail(
        unverifiable(
          candidateRef,
          'Final owner fence cannot accept conflicting material proofs that reuse one opaque source-proof reference',
          true,
        ),
      );
    }
    byVerificationRef.set(verificationRef, source);
  }
  return Effect.succeed([...byVerificationRef.values()]);
};

const verifiedExpectations = (
  candidateRef: string,
  sources: readonly PricingSourceEvidenceResult[],
): Effect.Effect<readonly PricingMaterialEvidenceFenceExpectation[], PricingMaterialEvidenceUnverifiableFailure> =>
  deduplicateVerifiedSourceEvidence(candidateRef, sources).pipe(
    Effect.map((verifiedSources) => verifiedSources.map(expectationFrom)),
  );

type PricingSetBackedFenceSource = Extract<PricingMaterialEvidenceFenceSource, { readonly sourceEvidence: unknown }>;
const isSetBackedFenceSource = Schema.is(PricingSetBackedMaterialEvidenceFenceSourceSchema);
const sameSetBackedFenceSource = Schema.toEquivalence(PricingSetBackedMaterialEvidenceFenceSourceSchema);

const verifiedTypedRequest = (
  candidateRef: string,
  assembly: PricingMaterialEvidenceAssemblyRequest,
  sources: readonly VerifiedSourceEvidence[],
): Effect.Effect<PricingOwnerMaterialEvidenceFenceGatewayRequest, PricingMaterialEvidenceUnverifiableFailure> => {
  const typed = assembly.ownerFenceRequest;
  if (
    typed === undefined ||
    !Schema.is(PricingOwnerMaterialEvidenceFenceGatewayRequestSchema)(typed) ||
    typed.candidateRef !== candidateRef ||
    typed.requestedAt !== assembly.requestedAt ||
    typed.evaluatedAt !== assembly.revalidatedAt ||
    typed.sources.filter(
      ({ verificationMaterial }) => verificationMaterial.kind === 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY',
    ).length !== 1
  ) {
    return Effect.fail(unverifiable(candidateRef, 'Exact owner final-fence authority is missing or invalid', true));
  }
  const setBackedSources = typed.sources.filter(isSetBackedFenceSource);
  const byProof = new Map<string, PricingSetBackedFenceSource>();
  for (const source of setBackedSources) {
    const { sourceEvidence } = source;
    const { completeness } = sourceEvidence;
    const { verification } = completeness;
    const { verificationRef } = verification;
    const retained = byProof.get(verificationRef);
    if (retained !== undefined && !sameSetBackedFenceSource(retained, source)) {
      return Effect.fail(
        unverifiable(
          candidateRef,
          'Owner final-fence authority reuses one opaque proof reference for conflicting typed material',
          true,
        ),
      );
    }
    byProof.set(verificationRef, source);
  }
  if (
    byProof.size !== sources.length ||
    sources.some((source) => {
      if (
        !Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source) &&
        !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(source)
      ) {
        return true;
      }
      const matched = byProof.get(source.completeness.verification.verificationRef);
      return matched === undefined || !sameSourceEvidence(matched.sourceEvidence, source);
    })
  ) {
    return Effect.fail(
      unverifiable(candidateRef, 'Owner final-fence authority does not cover every exact material proof', true),
    );
  }
  return Effect.succeed(typed);
};

const observationMatchesExpectation = (
  expectation: PricingMaterialEvidenceFenceExpectation,
  observation: PricingMaterialEvidenceFenceSourceObservation,
  fenceObservedAt: PricingInstant,
): boolean =>
  observation.evidenceVerificationRef === expectation.evidenceVerificationRef &&
  observation.ownerModuleId === expectation.ownerModuleId &&
  observation.tenantId === expectation.tenantId &&
  observation.ownerRootRef === expectation.ownerRootRef &&
  observation.predicateRef === expectation.predicateRef &&
  observation.family === expectation.family &&
  observation.currencyCode === expectation.currencyCode &&
  observation.currentOwnerSetRevisionRef === expectation.ownerSetRevisionRef &&
  observation.evidenceInvalidationGenerationRef === observation.currentInvalidationGenerationRef &&
  Schema.is(PricingInstantSchema)(observation.observedAt) &&
  observation.observedAt >= expectation.evidenceObservedAt &&
  observation.observedAt <= fenceObservedAt &&
  (expectation.nextMaterialBoundary === undefined || fenceObservedAt < expectation.nextMaterialBoundary) &&
  sameFacts(expectation.currentFacts, observation.currentFacts);

/**
 * Owner-backed compare fence. It intentionally accepts no caller revalidation timestamp: only the
 * owner's coherent final observation and generations can authorize publication.
 */
export const verifyPricingMaterialEvidenceOwnerFence = Effect.fn('PricingMaterialEvidence.verifyOwnerFinalFence')(
  function* verifyPricingMaterialEvidenceOwnerFenceProgram(
    candidateRef: string,
    sources: readonly PricingSourceEvidenceResult[],
    verificationRequest?: PricingOwnerMaterialEvidenceFenceGatewayRequest,
  ): Effect.fn.Return<
    PricingMaterialEvidenceOwnerFenceEvidence,
    PricingMaterialEvidenceOwnerFenceFailure,
    PricingMaterialEvidenceOwnerFinalFence
  > {
    const expectations = yield* verifiedExpectations(candidateRef, sources);
    const ownerFence = yield* PricingMaterialEvidenceOwnerFinalFence;
    const request: PricingMaterialEvidenceOwnerFenceRequest =
      verificationRequest === undefined
        ? { candidateRef, sources: expectations }
        : { candidateRef, sources: expectations, verificationRequest };
    const evidence = yield* ownerFence.verifyImmediatelyBeforePublication(request);
    if (!Schema.is(PricingInstantSchema)(evidence.observedAt) || evidence.fenceRef.length === 0) {
      return yield* unverifiable(candidateRef, 'Owner final-fence evidence is malformed or untrusted', true);
    }
    if (evidence.sources.length !== expectations.length) {
      return yield* unverifiable(candidateRef, 'Owner final fence did not cover every material source proof', true);
    }
    const observations = new Map(evidence.sources.map((source) => [source.evidenceVerificationRef, source]));
    if (observations.size !== evidence.sources.length) {
      return yield* unverifiable(candidateRef, 'Owner final fence returned duplicate source observations', true);
    }
    for (const expectation of expectations) {
      const observation = observations.get(expectation.evidenceVerificationRef);
      if (observation === undefined || !observationMatchesExpectation(expectation, observation, evidence.observedAt)) {
        return yield* changedAtFinalFence(candidateRef, expectation);
      }
    }
    return evidence;
  },
);

/**
 * The ordinary-Current publication gate. Structural assembly runs first; the owner fence is the
 * final operation before authorization is returned, and never replaces old evidence with a newer
 * snapshot.
 */
export const finalizePricingMaterialEvidenceForPublication = Effect.fn(
  'PricingMaterialEvidence.finalizeForPublication',
)(function* finalizePricingMaterialEvidenceForPublicationProgram(
  input: PricingMaterialEvidenceFinalizationRequest,
): Effect.fn.Return<
  PricingMaterialEvidencePublicationAuthorization,
  PricingMaterialEvidenceChangedAtFinalFence | PricingMaterialEvidenceFailure,
  PricingMaterialEvidenceOwnerFinalFence
> {
  const { request } = input;
  const materialEvidence = yield* assemblePricingMaterialEvidence(request);
  const sources = yield* deduplicateVerifiedSourceEvidence(
    materialEvidence.candidateRef,
    collectSourceEvidence(materialEvidence.sourceEvidence),
  );
  const verificationRequest = yield* verifiedTypedRequest(materialEvidence.candidateRef, request, sources);
  const finalFenceEvidence = yield* verifyPricingMaterialEvidenceOwnerFence(
    materialEvidence.candidateRef,
    sources,
    verificationRequest,
  );
  return {
    finalFenceEvidence,
    materialEvidence,
    outcome: 'PRICING_MATERIAL_EVIDENCE_PUBLICATION_AUTHORIZED' as const,
  };
});
