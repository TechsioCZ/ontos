import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import { PricingMaterialEvidenceUnverifiableFailure } from '@app/pricing-contracts/domain/material-evidence';
import type {
  PricingMaterialEvidenceFenceSource,
  PricingOwnerMaterialEvidenceFenceGatewayRequest as PricingTypedOwnerFenceRequest,
} from '@app/pricing-contracts/domain/material-evidence';
import { Context, Effect, Layer, Schema } from 'effect';

import { pricingExternalOwnerEvidenceValidationService } from '../services/external-owner-evidence-validation.service.ts';
import type {
  PricingMaterialEvidenceFenceExpectation,
  PricingMaterialEvidenceFenceSourceObservation,
  PricingMaterialEvidenceOwnerFenceEvidence,
  PricingMaterialEvidenceOwnerFenceFailure,
  PricingMaterialEvidenceOwnerFencePort,
  PricingMaterialEvidenceOwnerFenceRequest,
} from '../services/material-evidence-final-validation.service.ts';
import {
  PricingMaterialEvidenceChangedAtFinalFence,
  PricingMaterialEvidenceOwnerFinalFence,
} from '../services/material-evidence-final-validation.service.ts';

const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const CUSTOMER_CONTEXT_OWNER_MODULE_ID = 'commerce.customer-context';
const PROMOTION_OWNER_MODULE_ID = 'commerce.promotion';

export const PricingMaterialEvidenceOwnerModuleSchema = Schema.Literals([
  'commerce.pricing',
  'commerce.catalog',
  'commerce.market-catalog',
  CUSTOMER_CONTEXT_OWNER_MODULE_ID,
  PROMOTION_OWNER_MODULE_ID,
]);
export type PricingMaterialEvidenceOwnerModule = typeof PricingMaterialEvidenceOwnerModuleSchema.Type;
type PricingOwnerVerificationContext = Omit<PricingTypedOwnerFenceRequest, 'sources' | 'subject'> & {
  readonly subject?: PricingTypedOwnerFenceRequest extends { readonly subject: infer Subject } ? Subject : never;
};

/** A published owner client could not verify its opaque proof and Current state atomically. */
export class PricingOwnerMaterialEvidenceFenceGatewayUnavailable extends Schema.TaggedError<PricingOwnerMaterialEvidenceFenceGatewayUnavailable>()(
  'PricingOwnerMaterialEvidenceFenceGatewayUnavailable',
  {
    ownerModuleId: PricingMaterialEvidenceOwnerModuleSchema,
    reason: boundedReason,
    retryable: Schema.Literal(true),
  },
) {}

export interface PricingOwnerMaterialEvidenceFenceGatewayRequest {
  readonly candidateRef: string;
  readonly compositionRevision: string;
  /**
   * The owner verifies every opaque reference and reads every corresponding Current predicate in
   * one owner-private coherent snapshot. Pricing never receives or imports owner persistence.
   */
  readonly sources: readonly PricingMaterialEvidenceFenceExpectation[];
  /** Exact owner-native source material, correlated one-to-one by the proof reference. */
  readonly typedSources?: readonly PricingMaterialEvidenceFenceSource[];
  readonly verificationContext?: PricingOwnerVerificationContext;
}

export interface PricingOwnerMaterialEvidenceFenceGatewayResult {
  /** Trusted completion of this owner's atomic proof verification and Current-state read. */
  readonly completedAt: typeof PricingInstantSchema.Type;
  /** Actual per-predicate owner observations. These timestamps must never be rewritten. */
  readonly observations: readonly PricingMaterialEvidenceFenceSourceObservation[];
}

export interface PricingOwnerMaterialEvidenceGenerationConfirmation {
  readonly currentFacts: readonly PricingMaterialEvidenceFenceSourceObservation['currentFacts'][number][];
  readonly currentInvalidationGenerationRef: string;
  readonly currentOwnerSetRevisionRef: string;
  readonly evidenceInvalidationGenerationRef: string;
  readonly evidenceVerificationRef: string;
}

export interface PricingOwnerMaterialEvidenceGenerationFenceRequest {
  readonly candidateRef: string;
  readonly compositionRevision: string;
  /** Phase-one observations, with their actual owner timestamps unchanged. */
  readonly observations: readonly PricingMaterialEvidenceFenceSourceObservation[];
  /**
   * The owner must prove from its private generation history that every observed generation stayed
   * unchanged through this already-known aggregate completion instant.
   */
  readonly through: typeof PricingInstantSchema.Type;
  /** Exact owner-native predicates retained for a stateless second owner read. */
  readonly typedSources?: readonly PricingMaterialEvidenceFenceSource[];
  readonly verificationContext?: PricingOwnerVerificationContext;
}

export interface PricingOwnerMaterialEvidenceGenerationFenceResult {
  readonly confirmations: readonly PricingOwnerMaterialEvidenceGenerationConfirmation[];
  readonly verifiedThrough: typeof PricingInstantSchema.Type;
}

export interface PricingOwnerMaterialEvidenceFenceGateway {
  readonly confirmObservedGenerationsThrough: (
    request: PricingOwnerMaterialEvidenceGenerationFenceRequest,
  ) => Effect.Effect<
    PricingOwnerMaterialEvidenceGenerationFenceResult,
    PricingOwnerMaterialEvidenceFenceGatewayUnavailable
  >;
  readonly verifyOpaqueProofsAgainstCurrentState: (
    request: PricingOwnerMaterialEvidenceFenceGatewayRequest,
  ) => Effect.Effect<
    PricingOwnerMaterialEvidenceFenceGatewayResult,
    PricingOwnerMaterialEvidenceFenceGatewayUnavailable
  >;
}

/** Owner-local Pricing facts: Price, Tier, Discount, Fee, floor, and Currency Support. */
export class PricingPricingMaterialEvidenceFenceGateway extends Context.Service<
  PricingPricingMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGateway
>()('@app/pricing/integrations/material-evidence-owner-final-fence/PricingPricingMaterialEvidenceFenceGateway') {}

/** Published Catalog owner client; its implementation authenticates to the Catalog deployment. */
export class PricingCatalogMaterialEvidenceFenceGateway extends Context.Service<
  PricingCatalogMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGateway
>()('@app/pricing/integrations/material-evidence-owner-final-fence/PricingCatalogMaterialEvidenceFenceGateway') {}

/** Published Commerce Market owner client. */
export class PricingMarketMaterialEvidenceFenceGateway extends Context.Service<
  PricingMarketMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGateway
>()('@app/pricing/integrations/material-evidence-owner-final-fence/PricingMarketMaterialEvidenceFenceGateway') {}

/** Published Customer Context client for the exact Group-assignment predicate. */
export class PricingCustomerContextMaterialEvidenceFenceGateway extends Context.Service<
  PricingCustomerContextMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGateway
>()(
  '@app/pricing/integrations/material-evidence-owner-final-fence/PricingCustomerContextMaterialEvidenceFenceGateway',
) {}

/** Published Promotion owner client for its contribution and eligible-set proofs. */
export class PricingPromotionMaterialEvidenceFenceGateway extends Context.Service<
  PricingPromotionMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGateway
>()('@app/pricing/integrations/material-evidence-owner-final-fence/PricingPromotionMaterialEvidenceFenceGateway') {}

const retryableFailure = (
  candidateRef: string,
  source: Pick<PricingMaterialEvidenceFenceExpectation, 'family' | 'predicateRef'>,
  reason: string,
  cause?: unknown,
): PricingMaterialEvidenceUnverifiableFailure => {
  const failure = new PricingMaterialEvidenceUnverifiableFailure({
    candidateRef,
    family: source.family,
    predicateRef: source.predicateRef,
    reason,
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const changedFailure = (
  candidateRef: string,
  source: Pick<PricingMaterialEvidenceFenceExpectation, 'family' | 'predicateRef'>,
): PricingMaterialEvidenceChangedAtFinalFence =>
  new PricingMaterialEvidenceChangedAtFinalFence({
    candidateRef,
    family: source.family,
    predicateRef: source.predicateRef,
    reason: 'Material owner generation or Current state changed before the aggregate publication fence completed',
    retryable: true,
  });

const stableFacts = (
  facts: readonly PricingMaterialEvidenceFenceSourceObservation['currentFacts'][number][],
): readonly PricingMaterialEvidenceFenceSourceObservation['currentFacts'][number][] =>
  [...facts].toSorted((left, right) =>
    `${left.factRef}\u0000${left.factRevisionRef}\u0000${left.verificationRef}`.localeCompare(
      `${right.factRef}\u0000${right.factRevisionRef}\u0000${right.verificationRef}`,
    ),
  );

const sameFacts = (
  left: readonly PricingMaterialEvidenceFenceSourceObservation['currentFacts'][number][],
  right: readonly PricingMaterialEvidenceFenceSourceObservation['currentFacts'][number][],
): boolean => {
  const stableLeft = stableFacts(left);
  const stableRight = stableFacts(right);
  return (
    stableLeft.length === stableRight.length &&
    stableLeft.every((fact, index) => {
      const observed = stableRight[index];
      return (
        observed !== undefined &&
        fact.factRef === observed.factRef &&
        fact.factRevisionRef === observed.factRevisionRef &&
        fact.verificationRef === observed.verificationRef
      );
    })
  );
};

const groupByOwner = (
  candidateRef: string,
  sources: readonly PricingMaterialEvidenceFenceExpectation[],
): Effect.Effect<
  Map<PricingMaterialEvidenceOwnerModule, PricingMaterialEvidenceFenceExpectation[]>,
  PricingMaterialEvidenceUnverifiableFailure
> => {
  const groups = new Map<PricingMaterialEvidenceOwnerModule, PricingMaterialEvidenceFenceExpectation[]>();
  for (const source of sources) {
    if (!Schema.is(PricingMaterialEvidenceOwnerModuleSchema)(source.ownerModuleId)) {
      return Effect.fail(
        retryableFailure(candidateRef, source, 'No approved owner gateway exists for a required material source proof'),
      );
    }
    const current = groups.get(source.ownerModuleId) ?? [];
    current.push(source);
    groups.set(source.ownerModuleId, current);
  }
  // Promotion absence is itself an owner fact. The authoritative Application Composition
  // gateway must prove that the module is not installed when no Promotion source was selected.
  if (!groups.has(PROMOTION_OWNER_MODULE_ID)) {
    groups.set(PROMOTION_OWNER_MODULE_ID, []);
  }
  return Effect.succeed(groups);
};

const ownerFailureWithoutSource = (
  candidateRef: string,
  ownerModuleId: PricingMaterialEvidenceOwnerModule,
  reason: string,
  cause?: unknown,
): PricingMaterialEvidenceUnverifiableFailure => {
  const failure = new PricingMaterialEvidenceUnverifiableFailure({
    candidateRef,
    reason: `${ownerModuleId}: ${reason}`,
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const validateOwnerResult = (
  candidateRef: string,
  expectations: readonly PricingMaterialEvidenceFenceExpectation[],
  result: PricingOwnerMaterialEvidenceFenceGatewayResult,
): Effect.Effect<PricingOwnerMaterialEvidenceFenceGatewayResult, PricingMaterialEvidenceUnverifiableFailure> => {
  const [first] = expectations;
  if (!Schema.is(PricingInstantSchema)(result.completedAt)) {
    return Effect.fail(
      first === undefined
        ? ownerFailureWithoutSource(
            candidateRef,
            PROMOTION_OWNER_MODULE_ID,
            'Owner final-fence completion time is malformed',
          )
        : retryableFailure(candidateRef, first, 'Owner final-fence completion time is malformed'),
    );
  }
  if (
    result.observations.some(
      ({ observedAt }) => !Schema.is(PricingInstantSchema)(observedAt) || observedAt > result.completedAt,
    )
  ) {
    return Effect.fail(
      first === undefined
        ? ownerFailureWithoutSource(
            candidateRef,
            PROMOTION_OWNER_MODULE_ID,
            'Owner final-fence completion precedes one of its actual Current-state observations',
          )
        : retryableFailure(
            candidateRef,
            first,
            'Owner final-fence completion precedes one of its actual Current-state observations',
          ),
    );
  }
  const expectedRefs = new Set(expectations.map(({ evidenceVerificationRef }) => evidenceVerificationRef));
  const observedRefs = new Set(result.observations.map(({ evidenceVerificationRef }) => evidenceVerificationRef));
  if (
    result.observations.length !== expectations.length ||
    observedRefs.size !== result.observations.length ||
    expectedRefs.size !== observedRefs.size ||
    [...expectedRefs].some((reference) => !observedRefs.has(reference))
  ) {
    return Effect.fail(
      first === undefined
        ? ownerFailureWithoutSource(
            candidateRef,
            PROMOTION_OWNER_MODULE_ID,
            'Owner final-fence response did not cover the source-free predicate exactly once',
          )
        : retryableFailure(
            candidateRef,
            first,
            'Owner final-fence response did not cover each requested opaque proof once',
          ),
    );
  }
  return Effect.succeed(result);
};

const validateGenerationConfirmation = (
  candidateRef: string,
  through: typeof PricingInstantSchema.Type,
  observations: readonly PricingMaterialEvidenceFenceSourceObservation[],
  result: PricingOwnerMaterialEvidenceGenerationFenceResult,
): Effect.Effect<void, PricingMaterialEvidenceOwnerFenceFailure> => {
  const [first] = observations;
  const confirmations = new Map(
    result.confirmations.map((confirmation) => [confirmation.evidenceVerificationRef, confirmation]),
  );
  if (
    !Schema.is(PricingInstantSchema)(result.verifiedThrough) ||
    result.verifiedThrough < through ||
    result.confirmations.length !== observations.length ||
    confirmations.size !== result.confirmations.length
  ) {
    return Effect.fail(
      first === undefined
        ? ownerFailureWithoutSource(
            candidateRef,
            PROMOTION_OWNER_MODULE_ID,
            'Owner generation confirmation did not span the aggregate fence or cover the source-free predicate',
          )
        : retryableFailure(
            candidateRef,
            first,
            'Owner generation confirmation did not span the aggregate fence or cover every observed proof',
          ),
    );
  }
  for (const observation of observations) {
    const confirmation = confirmations.get(observation.evidenceVerificationRef);
    if (
      confirmation === undefined ||
      confirmation.evidenceInvalidationGenerationRef !== observation.evidenceInvalidationGenerationRef ||
      confirmation.currentInvalidationGenerationRef !== observation.currentInvalidationGenerationRef ||
      confirmation.currentOwnerSetRevisionRef !== observation.currentOwnerSetRevisionRef ||
      !sameFacts(confirmation.currentFacts, observation.currentFacts)
    ) {
      return Effect.fail(changedFailure(candidateRef, observation));
    }
  }
  return Effect.void;
};

interface PricingOwnerFencePhaseOneResult {
  readonly ownerModuleId: PricingMaterialEvidenceOwnerModule;
  readonly ownerSources: readonly PricingMaterialEvidenceFenceExpectation[];
  readonly result: PricingOwnerMaterialEvidenceFenceGatewayResult;
  readonly typedSources: readonly PricingMaterialEvidenceFenceSource[];
}

export const makePricingMaterialEvidenceOwnerFinalFenceFromGateways = (
  gateways: Readonly<Record<PricingMaterialEvidenceOwnerModule, PricingOwnerMaterialEvidenceFenceGateway>>,
  compositionRevision: string,
): PricingMaterialEvidenceOwnerFencePort => ({
  verifyImmediatelyBeforePublication: Effect.fn('PricingMaterialEvidenceOwnerFinalFence.verify')(
    function* verifyImmediatelyBeforePublication({
      candidateRef,
      sources,
      verificationRequest,
    }: PricingMaterialEvidenceOwnerFenceRequest): Effect.fn.Return<
      PricingMaterialEvidenceOwnerFenceEvidence,
      PricingMaterialEvidenceOwnerFenceFailure
    > {
      const groups = yield* groupByOwner(candidateRef, sources);
      const purchaseAuthority = verificationRequest?.sources.find(
        ({ verificationMaterial }) => verificationMaterial.kind === 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY',
      );
      if (purchaseAuthority !== undefined && !groups.has(CUSTOMER_CONTEXT_OWNER_MODULE_ID)) {
        groups.set(CUSTOMER_CONTEXT_OWNER_MODULE_ID, []);
      }
      const typedEntries = verificationRequest?.sources.flatMap((source) =>
        'sourceEvidence' in source
          ? [[source.sourceEvidence.completeness.verification.verificationRef, source] as const]
          : [],
      );
      const typedByProof =
        typedEntries === undefined
          ? new Map<string, PricingMaterialEvidenceFenceSource>()
          : new Map<string, PricingMaterialEvidenceFenceSource>(typedEntries);
      const ownerResults = yield* Effect.forEach(
        groups,
        ([ownerModuleId, ownerSources]): Effect.Effect<
          PricingOwnerFencePhaseOneResult,
          PricingMaterialEvidenceUnverifiableFailure
        > => {
          const gateway = gateways[ownerModuleId];
          const [first] = ownerSources;
          const setBackedTypedSources = ownerSources.flatMap(({ evidenceVerificationRef }) => {
            const typed = typedByProof.get(evidenceVerificationRef);
            return typed === undefined ? [] : [typed];
          });
          const typedSources =
            ownerModuleId === CUSTOMER_CONTEXT_OWNER_MODULE_ID && purchaseAuthority !== undefined
              ? [...setBackedTypedSources, purchaseAuthority]
              : setBackedTypedSources;
          if (verificationRequest !== undefined && setBackedTypedSources.length !== ownerSources.length) {
            return Effect.fail(
              first === undefined
                ? ownerFailureWithoutSource(
                    candidateRef,
                    ownerModuleId,
                    `The ${ownerModuleId} owner did not receive exact typed authority for its source-free predicate`,
                  )
                : retryableFailure(
                    candidateRef,
                    first,
                    `The ${ownerModuleId} owner did not receive exact typed authority for every retained proof`,
                  ),
            );
          }
          const gatewayRequest: PricingOwnerMaterialEvidenceFenceGatewayRequest =
            verificationRequest === undefined
              ? { candidateRef, compositionRevision, sources: ownerSources }
              : {
                  candidateRef,
                  compositionRevision,
                  sources: ownerSources,
                  typedSources,
                  verificationContext: {
                    candidateRef: verificationRequest.candidateRef,
                    decision: verificationRequest.decision,
                    effectiveAt: verificationRequest.effectiveAt,
                    evaluatedAt: verificationRequest.evaluatedAt,
                    requestedAt: verificationRequest.requestedAt,
                  },
                };
          return gateway.verifyOpaqueProofsAgainstCurrentState(gatewayRequest).pipe(
            Effect.mapError((cause) =>
              first === undefined
                ? ownerFailureWithoutSource(
                    candidateRef,
                    ownerModuleId,
                    `The ${ownerModuleId} owner could not verify its source-free predicate against Current state`,
                    cause,
                  )
                : retryableFailure(
                    candidateRef,
                    first,
                    `The ${ownerModuleId} owner could not verify its opaque proof against Current state`,
                    cause,
                  ),
            ),
            Effect.flatMap((result) => validateOwnerResult(candidateRef, ownerSources, result)),
            Effect.map((result) => ({ ownerModuleId, ownerSources, result, typedSources })),
          );
        },
        { concurrency: 5 },
      );
      const completedAt = ownerResults
        .map(({ result }) => result.completedAt)
        .toSorted()
        .at(-1);
      const [first] = sources;
      if (completedAt === undefined || first === undefined) {
        return yield* new PricingMaterialEvidenceUnverifiableFailure({
          candidateRef,
          reason: 'The owner final fence requires at least one material source proof',
          retryable: true,
        });
      }
      yield* Effect.forEach(
        ownerResults,
        ({ ownerModuleId, ownerSources, result, typedSources }) => {
          const [ownerExpectation] = ownerSources;
          const generationRequest: PricingOwnerMaterialEvidenceGenerationFenceRequest =
            verificationRequest === undefined
              ? { candidateRef, compositionRevision, observations: result.observations, through: completedAt }
              : {
                  candidateRef,
                  compositionRevision,
                  observations: result.observations,
                  through: completedAt,
                  typedSources,
                  verificationContext: {
                    candidateRef: verificationRequest.candidateRef,
                    decision: verificationRequest.decision,
                    effectiveAt: verificationRequest.effectiveAt,
                    evaluatedAt: verificationRequest.evaluatedAt,
                    requestedAt: verificationRequest.requestedAt,
                  },
                };
          return gateways[ownerModuleId].confirmObservedGenerationsThrough(generationRequest).pipe(
            Effect.mapError((cause) =>
              ownerExpectation === undefined
                ? ownerFailureWithoutSource(
                    candidateRef,
                    ownerModuleId,
                    `The ${ownerModuleId} owner could not confirm its source-free predicate through aggregate fence completion`,
                    cause,
                  )
                : retryableFailure(
                    candidateRef,
                    ownerExpectation,
                    `The ${ownerModuleId} owner could not confirm its generation through aggregate fence completion`,
                    cause,
                  ),
            ),
            Effect.flatMap((confirmation) =>
              validateGenerationConfirmation(candidateRef, completedAt, result.observations, confirmation),
            ),
          );
        },
        { concurrency: 5, discard: true },
      );
      const byVerificationRef = new Map<string, PricingMaterialEvidenceFenceSourceObservation>();
      for (const ownerResult of ownerResults) {
        for (const observation of ownerResult.result.observations) {
          byVerificationRef.set(observation.evidenceVerificationRef, observation);
        }
      }
      const observations = sources.flatMap(({ evidenceVerificationRef }) => {
        const observation = byVerificationRef.get(evidenceVerificationRef);
        return observation === undefined ? [] : [observation];
      });
      return {
        fenceRef: `pricing-material-owner-fence:${candidateRef}:${completedAt}:${observations.length}`,
        observedAt: completedAt,
        sources: observations,
      };
    },
  ),
});

export const makePricingMaterialEvidenceOwnerFinalFence = Effect.fn('PricingMaterialEvidenceOwnerFinalFence.make')(
  function* makeProductionOwnerFinalFence(compositionRevision: string) {
    const gateways = {
      'commerce.catalog': yield* PricingCatalogMaterialEvidenceFenceGateway,
      'commerce.market-catalog': yield* PricingMarketMaterialEvidenceFenceGateway,
      'commerce.pricing': yield* PricingPricingMaterialEvidenceFenceGateway,
      [CUSTOMER_CONTEXT_OWNER_MODULE_ID]: yield* PricingCustomerContextMaterialEvidenceFenceGateway,
      [PROMOTION_OWNER_MODULE_ID]: yield* PricingPromotionMaterialEvidenceFenceGateway,
    } satisfies Readonly<Record<PricingMaterialEvidenceOwnerModule, PricingOwnerMaterialEvidenceFenceGateway>>;
    return makePricingMaterialEvidenceOwnerFinalFenceFromGateways(gateways, compositionRevision);
  },
);

export const pricingMaterialEvidenceOwnerFinalFenceLive = Layer.succeed(PricingMaterialEvidenceOwnerFinalFence, {
  verifyImmediatelyBeforePublication: ({ candidateRef }) =>
    Effect.fail(
      new PricingMaterialEvidenceUnverifiableFailure({
        candidateRef,
        reason: 'Material owner final fence requires a captured operation composition revision',
        retryable: true,
      }),
    ),
});

/** Canonical Live composition for the ordinary Current publication functions. */
export const pricingOrdinaryCurrentPublicationLive = Layer.merge(
  pricingExternalOwnerEvidenceValidationService,
  pricingMaterialEvidenceOwnerFinalFenceLive,
);
