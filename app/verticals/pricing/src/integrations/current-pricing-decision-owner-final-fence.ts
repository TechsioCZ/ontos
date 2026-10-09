import { executePricingCurrentMarketEvidenceWithAuthorization } from '@app/commerce-market-catalog/api/pricing-current-market-evidence-client';
import {
  PricingCurrentMarketEvidenceRequestSchema,
  PricingCurrentMarketEvidenceResponseSchema,
} from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import type {
  PricingCurrentMarketEvidenceRequest,
  PricingMarketSourceReceipt,
} from '@app/commerce-market-catalog/api/pricing-current-market-evidence';
import { executeCustomerPriceGroupResolutionWithAuthorization } from '@app/commerce-customer-context/api/customer-price-group-resolution/client';
import {
  CustomerPriceGroupResolutionRequestSchema,
  CustomerPriceGroupResolutionResponseSchema,
} from '@app/commerce-customer-context/api/customer-price-group-resolution';
import type { CustomerPriceGroupResolutionRequest } from '@app/commerce-customer-context/api/customer-price-group-resolution';
import { DateTime, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';
import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { PricingCommercialFeeVariantTargetSchema } from '@app/pricing-contracts/domain/commercial-fee';
import { PricingZeroFloorAuthorizationQuerySchema } from '@app/pricing-contracts/domain/line-composition';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import {
  PricingDiscountAudienceSchema,
  PricingDiscountIdentityBasisSchema,
} from '@app/pricing-contracts/domain/discount';
import { PricingContractualDiscountSetPredicateSchema } from '@app/pricing-contracts/domain/contractual-discount-set';
import type { OperationContextUnavailable, OperationalScope, ReadServiceFactory } from '@app/core-runtime';

import {
  PricingCatalogMaterialEvidenceFenceGateway,
  PricingCustomerContextMaterialEvidenceFenceGateway,
  PricingMarketMaterialEvidenceFenceGateway,
  PricingOwnerMaterialEvidenceFenceGatewayUnavailable,
  PricingPricingMaterialEvidenceFenceGateway,
  PricingPromotionMaterialEvidenceFenceGateway,
} from './material-evidence-owner-final-fence.ts';
import type {
  PricingMaterialEvidenceOwnerModule,
  PricingOwnerMaterialEvidenceFenceGateway,
} from './material-evidence-owner-final-fence.ts';
import type { ExactPriceCandidateSetPersistence } from '../services/price-persistence.service.ts';
import type { CommercialFeePersistence } from '../services/commercial-fee-persistence.service.ts';
import type { ZeroFloorAuthorizationPersistence } from '../services/zero-floor-authorization-persistence.service.ts';
import type {
  CurrencySupportGenerationVerificationPersistence,
  CurrencySupportPersistence,
  CurrencySupportProofResolutionPersistence,
  StoredCurrencySupport,
} from '../persistence/currency-support-persistence.ts';
import { PricingSetBackedMaterialEvidenceFenceSourceSchema } from '@app/pricing-contracts/domain/material-evidence';
import type { PricingMaterialEvidenceFenceSource } from '@app/pricing-contracts/domain/material-evidence';
import type { PricingMaterialEvidenceFenceExpectation } from '../services/material-evidence-final-validation.service.ts';
import { pricePersistenceForScope } from '../services/price-persistence.service.ts';
import { commercialFeePersistenceForScope } from '../services/commercial-fee-persistence.service.ts';
import { zeroFloorAuthorizationPersistenceForScope } from '../services/zero-floor-authorization-persistence.service.ts';
import {
  currencySupportGenerationVerificationPersistenceForScope,
  currencySupportPersistenceForScope,
  currencySupportProofResolutionPersistenceForScope,
} from '../persistence/currency-support-persistence.ts';
import { materialEvidenceProofPersistenceForScope } from '../services/material-evidence-proof-persistence.service.ts';
import { contractualDiscountPersistenceForScope } from '../services/contractual-discount-persistence.service.ts';
import type { ContractualDiscountPersistence } from '../services/contractual-discount-persistence.service.ts';
import { quantityTierPersistenceForScope } from '../services/quantity-tier-persistence.service.ts';
import type {
  QuantityTierPersistence,
  QuantityTierSetProofPersistence,
} from '../services/quantity-tier-persistence.service.ts';
import { promotionModuleNotInstalledFinalFenceLive } from './promotion-module-not-installed-final-fence.ts';
import type { CommercialContextGatewayCredentialIssuer } from '../../shared/domain/commercial-context-gateway-credential.ts';
import {
  CommercialContextGatewayCredentialService,
  unavailableCommercialContextGatewayCredentialIssuer,
} from '../../shared/domain/commercial-context-gateway-credential.ts';
import type { CommercePriceGroupResolutionGatewayCredentialIssuer } from '../../shared/domain/commerce-price-group-resolution-gateway-credential.ts';
import {
  CommercePriceGroupResolutionGatewayCredentialService,
  unavailableCommercePriceGroupResolutionGatewayCredentialIssuer,
} from '../../shared/domain/commerce-price-group-resolution-gateway-credential.ts';
import {
  PriceGroupAssignmentProfileSchema,
  PriceGroupAssignmentResolutionSchema,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import { executeQuantityBasisCompatibilityWithAuthorization } from '@app/catalog/api/quantity-basis-compatibility-client';
import { QuantityBasisCompatibilityResponseSchema } from '@app/catalog/api/quantity-basis-compatibility';
import type { QuantityBasisCompatibilityRequest } from '@app/catalog/api/quantity-basis-compatibility';
import { executePricingPurposeEquivalenceWithAuthorization } from '@app/catalog/api/pricing-purpose-equivalence-client';
import { PricingPurposeEquivalenceResponseSchema } from '@app/catalog/api/pricing-purpose-equivalence';
import type { PricingPurposeEquivalenceRequest } from '@app/catalog/api/pricing-purpose-equivalence';
import type { CatalogSelectionGatewayCredentialIssuer } from '../../shared/domain/catalog-selection-gateway-credential.ts';
import {
  CatalogSelectionGatewayCredentialService,
  unavailableCatalogSelectionGatewayCredentialIssuer,
} from '../../shared/domain/catalog-selection-gateway-credential.ts';

type PricingSetBackedFenceSource = Extract<PricingMaterialEvidenceFenceSource, { readonly sourceEvidence: unknown }>;
const isSetBackedFenceSource = Schema.is(PricingSetBackedMaterialEvidenceFenceSourceSchema);
const setBackedSourcesByProof = (sources: readonly PricingMaterialEvidenceFenceSource[]) =>
  new Map(
    sources.flatMap((source) =>
      isSetBackedFenceSource(source)
        ? [[source.sourceEvidence.completeness.verification.verificationRef, source] as const]
        : [],
    ),
  );

export interface PricingCurrentDecisionResolvedOriginalProof {
  readonly currentFacts: PricingMaterialEvidenceFenceExpectation['currentFacts'];
  readonly evidenceInvalidationGeneration: number;
  readonly evidenceVerificationRef: string;
  readonly observedAt: PricingMaterialEvidenceFenceExpectation['evidenceObservedAt'];
  readonly ownerRootRef: string;
  readonly ownerSetRevisionRef: string;
  readonly predicateRef: string;
}

type PricingFenceObservation = Parameters<
  PricingOwnerMaterialEvidenceFenceGateway['confirmObservedGenerationsThrough']
>[0]['observations'][number];
type PricingFenceVerificationContext = NonNullable<
  Parameters<
    PricingOwnerMaterialEvidenceFenceGateway['verifyOpaqueProofsAgainstCurrentState']
  >[0]['verificationContext']
>;
type PricingVerificationMaterial = PricingSetBackedFenceSource['verificationMaterial'];
type PricingAuthorityMaterial<Kind extends PricingVerificationMaterial['kind']> = Extract<
  PricingVerificationMaterial,
  { readonly kind: Kind }
>;
type DiscountOriginalProof = Effect.Success<ReturnType<ContractualDiscountPersistence['resolveOriginalSetProof']>>;
type QuantityTierOriginalProof = Effect.Success<
  ReturnType<QuantityTierSetProofPersistence['resolveQuantityTierSetProof']>
>;

const pricingGenerationRef = String;
const PRICING_MODULE_ID = 'commerce.pricing';
const anyMismatch = (...checks: readonly boolean[]) => checks.some(Boolean);
const pricingOwnerUnavailable = (reason: string, cause?: unknown) => {
  const failure = new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
    ownerModuleId: PRICING_MODULE_ID,
    reason,
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};
const sameMultiset = <A>(left: readonly A[], right: readonly A[], key: (value: A) => string) => {
  const leftKeys = left.map(key).toSorted();
  const rightKeys = right.map(key).toSorted();
  return leftKeys.length === rightKeys.length && leftKeys.every((value, index) => value === rightKeys[index]);
};
const matchingFacts = (
  expected: readonly {
    readonly factRef: string;
    readonly factRevisionRef: string;
    readonly verificationRef: string;
  }[],
  actual: readonly { readonly factRef: string; readonly factRevisionRef: string; readonly verificationRef: string }[],
) =>
  sameMultiset(
    expected,
    actual,
    ({ factRef, factRevisionRef, verificationRef }) => `${factRef}\u0000${factRevisionRef}\u0000${verificationRef}`,
  );
const matchingFactIdentities = (
  proven: readonly { readonly factRef: string; readonly factRevisionRef: string }[],
  current: readonly { readonly factRef: string; readonly factRevisionRef: string }[],
) => sameMultiset(proven, current, ({ factRef, factRevisionRef }) => `${factRef}\u0000${factRevisionRef}`);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameDiscountAudience = Schema.toEquivalence(PricingDiscountAudienceSchema);
const sameDiscountBasis = Schema.toEquivalence(PricingDiscountIdentityBasisSchema);
const sameDiscountPredicate = Schema.toEquivalence(PricingContractualDiscountSetPredicateSchema);
const sameFeeTarget = Schema.toEquivalence(PricingCommercialFeeVariantTargetSchema);
const samePriceKey = Schema.toEquivalence(PriceIdentityKeySchema);
const samePriceRef = Schema.toEquivalence(PriceRefSchema);
const sameZeroFloorQuery = Schema.toEquivalence(PricingZeroFloorAuthorizationQuerySchema);
const retainedCurrentFacts = (
  facts: readonly {
    readonly factRef: string;
    readonly factRevisionRef: string;
    readonly verification: { readonly verificationRef: string };
  }[],
) =>
  facts.map((fact) => ({
    factRef: fact.factRef,
    factRevisionRef: fact.factRevisionRef,
    verificationRef: fact.verification.verificationRef,
  }));
interface DiscountIdentityKey {
  readonly audience: typeof PricingDiscountAudienceSchema.Type;
  readonly basis: typeof PricingDiscountIdentityBasisSchema.Type;
  readonly commercialScope: typeof PricingCommercialScopeSchema.Type;
  readonly currencyCode: string;
  readonly family: string;
}
const sameOrderedValues = <A>(left: readonly A[], right: readonly A[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const discountIdentityDoesNotBind = (
  key: DiscountIdentityKey,
  predicate: typeof PricingContractualDiscountSetPredicateSchema.Type,
) =>
  anyMismatch(
    key.family !== 'CONTRACTUAL_DISCOUNT',
    key.currencyCode !== predicate.currencyCode,
    !sameCommercialScope(key.commercialScope, predicate.commercialScope),
    !sameDiscountBasis(key.basis, predicate.basis),
    !predicate.audiences.some((audience) => sameDiscountAudience(audience, key.audience)),
  );

export interface PricingCurrentDecisionPricingOwnerFinalFenceDependencies {
  readonly currencySupport: Pick<CurrencySupportPersistence, 'loadCurrent'> &
    CurrencySupportGenerationVerificationPersistence &
    CurrencySupportProofResolutionPersistence;
  readonly discounts: Pick<
    ContractualDiscountPersistence,
    'readCurrentSet' | 'resolveOriginalSetProof' | 'verifySetGeneration'
  >;
  readonly fees: Pick<CommercialFeePersistence, 'readCurrentSet' | 'verifySetGeneration'>;
  readonly prices: Pick<
    ExactPriceCandidateSetPersistence,
    'readExactCandidateSet' | 'verifyExactCandidateSetGeneration'
  >;
  /** Required for families without a durable proof resolver in their existing persistence port. */
  readonly resolveOriginalProof?: (request: {
    readonly expected: PricingMaterialEvidenceFenceExpectation;
    readonly source: PricingSetBackedFenceSource;
  }) => Effect.Effect<PricingCurrentDecisionResolvedOriginalProof, PricingOwnerMaterialEvidenceFenceGatewayUnavailable>;
  readonly tiers: Pick<QuantityTierPersistence, 'readCurrentSet' | 'verifySetGeneration'> &
    QuantityTierSetProofPersistence;
  readonly zeroFloor: Pick<ZeroFloorAuthorizationPersistence, 'readCurrentSet' | 'verifyGeneration'>;
}

/** Constructed inside the governed Pricing read scope, where owner persistence is available. */
export const makePricingCurrentDecisionPricingOwnerFinalFenceGateway = <
  Ports extends PricingCurrentDecisionPricingOwnerFinalFenceDependencies,
>(
  ports: Ports,
): PricingOwnerMaterialEvidenceFenceGateway => {
  const dependencies = ports;
  const unavailable = pricingOwnerUnavailable;
  const generationRef = pricingGenerationRef;
  const resolveCurrencyProof = Effect.fn('CurrentPricingDecisionOwnerFinalFence.resolveCurrencyProof')(
    function* resolveStoredCurrencyRevision(
      source: PricingSetBackedFenceSource,
      expected: PricingMaterialEvidenceFenceExpectation,
    ) {
      const material = source.verificationMaterial;
      if (material.kind !== 'PRICING_CURRENCY_SUPPORT_AUTHORITY') {
        return yield* unavailable('Currency Support proof material is unavailable');
      }
      const { support } = material;
      const proof = yield* dependencies.currencySupport
        .resolveOriginalProof({ verificationRef: expected.evidenceVerificationRef })
        .pipe(Effect.mapError((cause) => unavailable('Original Currency Support receipt cannot be resolved', cause)));
      const sourceIsVerifiedPresent = Match.value(source.sourceEvidence).pipe(
        Match.tag('VERIFIED_PRESENT', () => true),
        Match.orElse(() => false),
      );
      const proofDoesNotBind = [
        !sourceIsVerifiedPresent,
        expected.family !== 'CURRENCY_SUPPORT',
        proof.verificationRef !== support.verificationRef,
        proof.verificationRef !== expected.evidenceVerificationRef,
        proof.tenantId !== support.tenantId,
        proof.effectiveAt !== support.effectiveAt,
        proof.supportRootId !== support.supportRootRef.resourceId,
        proof.supportRootId !== expected.ownerRootRef,
        proof.supportRevisionId !== support.supportRevisionRef.resourceId,
        proof.supportRevisionId !== expected.ownerSetRevisionRef,
        proof.generation !== support.generation,
        proof.scheduleRevision !== support.scheduleRevision,
        proof.pricingRevision !== support.pricingRevision,
        proof.observedAt !== support.observedAt,
        proof.observedAt !== expected.evidenceObservedAt,
        proof.predicateRef !== support.completenessEvidence.scope.predicateRef,
        proof.predicateRef !== expected.predicateRef,
        proof.effectivePeriod.effectiveFrom !== support.effectivePeriod.effectiveFrom,
        proof.effectivePeriod.effectiveTo !== support.effectivePeriod.effectiveTo,
        proof.nextApplicabilityBoundary !== support.nextApplicabilityBoundary,
        !sameOrderedValues(proof.supportedCurrencies, support.supportedCurrencies),
        !matchingFacts(expected.currentFacts, proof.factProofs),
        !matchingFacts(support.factProofs, proof.factProofs),
      ].some(Boolean);
      if (proofDoesNotBind) {
        return yield* unavailable('Currency Support source proof does not bind its retained revision');
      }
      return {
        currentFacts: proof.factProofs,
        evidenceInvalidationGeneration: proof.generation,
        evidenceVerificationRef: proof.verificationRef,
        observedAt: proof.observedAt,
        ownerRootRef: proof.supportRootId,
        ownerSetRevisionRef: proof.supportRevisionId,
        predicateRef: proof.predicateRef,
      };
    },
  );

  const confirmPriceGeneration = Effect.fn('CurrentPricingDecisionOwnerFinalFence.confirmPriceGeneration')(
    function* confirmPriceGeneration({
      material,
      observation,
      through,
    }: {
      readonly material: PricingAuthorityMaterial<'PRICING_PRICE_AUTHORITY'>;
      readonly observation: PricingFenceObservation;
      readonly through: string;
    }) {
      const read = yield* dependencies.prices
        .readExactCandidateSet({
          effectiveAt: material.lookupRequest.effectiveAt,
          exactKey: material.lookupRequest.exactKey,
        })
        .pipe(Effect.mapError((cause) => unavailable('Price generation read is unavailable', cause)));
      if (
        read.outcome !== 'EXACT_PRICE_CANDIDATE_SET_CURRENT' ||
        anyMismatch(
          read.authority.verificationRef !== observation.evidenceVerificationRef,
          generationRef(read.authority.generation) !== observation.currentInvalidationGenerationRef,
        )
      ) {
        return yield* unavailable('Price generation changed before aggregate completion');
      }
      const checked = yield* dependencies.prices
        .verifyExactCandidateSetGeneration({
          authority: read.authority,
          effectiveAt: material.lookupRequest.effectiveAt,
          exactKey: material.lookupRequest.exactKey,
          through,
        })
        .pipe(Effect.mapError((cause) => unavailable('Price generation history is unavailable', cause)));
      if (
        checked.outcome !== 'EXACT_PRICE_CANDIDATE_SET_GENERATION_CURRENT' ||
        anyMismatch(
          checked.verifiedThrough < through,
          checked.authority.generation !== read.authority.generation,
          checked.authority.ownerRevision !== observation.currentOwnerSetRevisionRef,
        )
      ) {
        return yield* unavailable('Price generation was not stable through aggregate completion');
      }
      return yield* Effect.void;
    },
  );

  const confirmTierGeneration = Effect.fn('CurrentPricingDecisionOwnerFinalFence.confirmTierGeneration')(
    function* confirmTierGeneration({
      effectiveAt,
      material,
      observation,
      through,
    }: {
      readonly effectiveAt: string;
      readonly material: PricingAuthorityMaterial<'PRICING_QUANTITY_TIER_AUTHORITY'>;
      readonly observation: PricingFenceObservation;
      readonly through: string;
    }) {
      const { priceRef } = material.selectionInput.tierSet;
      const proof = yield* dependencies.tiers
        .resolveQuantityTierSetProof({
          effectiveAt,
          priceRef,
          verificationRef: observation.evidenceVerificationRef,
        })
        .pipe(Effect.mapError((cause) => unavailable('Original Tier receipt cannot be re-resolved', cause)));
      if (
        proof.outcome !== 'QUANTITY_TIER_SET_PROOF_RESOLVED' ||
        anyMismatch(
          generationRef(proof.authority.generation) !== observation.currentInvalidationGenerationRef,
          proof.authority.ownerRootRef !== observation.ownerRootRef,
          proof.authority.ownerRevision !== observation.currentOwnerSetRevisionRef,
          !matchingFacts(proof.currentFacts, observation.currentFacts),
        )
      ) {
        return yield* unavailable('Tier receipt no longer binds the observed Current set');
      }
      const checked = yield* dependencies.tiers
        .verifySetGeneration({
          effectiveAt,
          generation: proof.authority.generation,
          observedAt: proof.authority.observedAt,
          ownerRevision: proof.authority.ownerRevision,
          ownerRootRef: proof.authority.ownerRootRef,
          priceRef,
          through,
          verificationRef: proof.authority.verificationRef,
        })
        .pipe(Effect.mapError((cause) => unavailable('Tier generation history is unavailable', cause)));
      if (
        checked.outcome !== 'QUANTITY_TIER_SET_GENERATION_CURRENT' ||
        anyMismatch(
          checked.verifiedThrough < through,
          checked.generation !== proof.authority.generation,
          checked.ownerRootRef !== observation.ownerRootRef,
          checked.ownerRevision !== observation.currentOwnerSetRevisionRef,
          checked.verificationRef !== observation.evidenceVerificationRef,
        )
      ) {
        return yield* unavailable('Tier generation was not stable through aggregate completion');
      }
      return yield* Effect.void;
    },
  );

  const confirmCommercialFeeGeneration = Effect.fn(
    'CurrentPricingDecisionOwnerFinalFence.confirmCommercialFeeGeneration',
  )(function* confirmCommercialFeeGeneration({
    effectiveAt,
    material,
    observation,
    through,
  }: {
    readonly effectiveAt: string;
    readonly material: PricingAuthorityMaterial<'PRICING_COMMERCIAL_FEE_AUTHORITY'>;
    readonly observation: PricingFenceObservation;
    readonly through: string;
  }) {
    const retained = material.currentSet;
    const query = {
      commercialScope: retained.commercialScope,
      currencyCode: retained.currencyCode,
      effectiveAt,
      target: retained.target,
    };
    const read = yield* dependencies.fees
      .readCurrentSet(query)
      .pipe(Effect.mapError((cause) => unavailable('Commercial Fee generation read is unavailable', cause)));
    if (
      read.outcome !== 'COMMERCIAL_FEE_SET_CURRENT' ||
      anyMismatch(
        read.authority.verificationRef !== observation.evidenceVerificationRef,
        generationRef(read.authority.generation) !== observation.currentInvalidationGenerationRef,
      )
    ) {
      return yield* unavailable('Commercial Fee generation changed before aggregate completion');
    }
    const checked = yield* dependencies.fees
      .verifySetGeneration({ ...query, authority: read.authority, through })
      .pipe(Effect.mapError((cause) => unavailable('Commercial Fee generation history is unavailable', cause)));
    if (
      checked.outcome !== 'COMMERCIAL_FEE_SET_GENERATION_CURRENT' ||
      anyMismatch(
        checked.verifiedThrough < through,
        checked.authority.generation !== read.authority.generation,
        checked.authority.ownerRevision !== observation.currentOwnerSetRevisionRef,
      )
    ) {
      return yield* unavailable('Commercial Fee generation was not stable through aggregate completion');
    }
    return yield* Effect.void;
  });

  const confirmDiscountGeneration = Effect.fn('CurrentPricingDecisionOwnerFinalFence.confirmDiscountGeneration')(
    function* confirmDiscountGeneration({
      material,
      observation,
      through,
    }: {
      readonly material: PricingAuthorityMaterial<'PRICING_DISCOUNT_AUTHORITY'>;
      readonly observation: PricingFenceObservation;
      readonly through: string;
    }) {
      const original = yield* dependencies.discounts
        .resolveOriginalSetProof({ verificationRef: observation.evidenceVerificationRef })
        .pipe(Effect.mapError((cause) => unavailable('Original Discount proof cannot be re-resolved', cause)));
      if (
        anyMismatch(
          original.authority.verificationRef !== observation.evidenceVerificationRef,
          generationRef(original.authority.generation) !== observation.currentInvalidationGenerationRef,
          original.authority.ownerRevision !== observation.currentOwnerSetRevisionRef,
          material.ownerReadReceipt.authority.verificationRef !== original.authority.verificationRef,
          material.ownerReadReceipt.authority.generation !== original.authority.generation,
          material.ownerReadReceipt.authority.ownerRevision !== original.authority.ownerRevision,
          material.ownerReadReceipt.authority.ownerRootRef !== original.authority.ownerRootRef,
          material.ownerReadReceipt.authority.predicateRef !== original.authority.predicateRef,
          !sameDiscountPredicate(material.ownerReadReceipt.predicate, original.predicate),
          !matchingFacts(material.ownerReadReceipt.factProofs, original.currentFacts),
          !matchingFacts(original.currentFacts, observation.currentFacts),
        )
      ) {
        return yield* unavailable('Discount original proof no longer binds the observed generation');
      }
      const checked = yield* dependencies.discounts
        .verifySetGeneration({ authority: original.authority, predicate: original.predicate, through })
        .pipe(Effect.mapError((cause) => unavailable('Discount generation history is unavailable', cause)));
      if (
        checked.outcome !== 'CONTRACTUAL_DISCOUNT_SET_GENERATION_CURRENT' ||
        anyMismatch(
          checked.verifiedThrough < through,
          checked.authority.generation !== original.authority.generation,
          checked.authority.ownerRevision !== observation.currentOwnerSetRevisionRef,
        )
      ) {
        return yield* unavailable('Discount generation was not stable through aggregate completion');
      }
      return yield* Effect.void;
    },
  );

  const confirmZeroFloorGeneration = Effect.fn('CurrentPricingDecisionOwnerFinalFence.confirmZeroFloorGeneration')(
    function* confirmZeroFloorGeneration({
      material,
      observation,
      through,
    }: {
      readonly material: PricingAuthorityMaterial<'PRICING_ZERO_FLOOR_AUTHORITY'>;
      readonly observation: PricingFenceObservation;
      readonly through: string;
    }) {
      const read = yield* dependencies.zeroFloor
        .readCurrentSet({ query: material.query })
        .pipe(Effect.mapError((cause) => unavailable('Zero Floor generation read is unavailable', cause)));
      if (
        anyMismatch(
          read.authority.verificationRef !== observation.evidenceVerificationRef,
          generationRef(read.authority.generation) !== observation.currentInvalidationGenerationRef,
        )
      ) {
        return yield* unavailable('Zero Floor generation changed before aggregate completion');
      }
      const checked = yield* dependencies.zeroFloor
        .verifyGeneration({
          generation: read.authority.generation,
          observedAt: read.authority.observedAt,
          ownerRevision: read.authority.ownerRevision,
          ownerRootRef: read.authority.ownerRootRef,
          query: material.query,
          through,
        })
        .pipe(Effect.mapError((cause) => unavailable('Zero Floor generation history is unavailable', cause)));
      if (
        checked.outcome !== 'ZERO_FLOOR_AUTHORIZATION_SET_GENERATION_CURRENT' ||
        anyMismatch(
          checked.verifiedThrough < through,
          checked.generation !== read.authority.generation,
          checked.ownerRevision !== observation.currentOwnerSetRevisionRef,
        )
      ) {
        return yield* unavailable('Zero Floor generation was not stable through aggregate completion');
      }
      return yield* Effect.void;
    },
  );

  const confirmCurrencySupportGeneration = Effect.fn(
    'CurrentPricingDecisionOwnerFinalFence.confirmCurrencySupportGeneration',
  )(function* confirmCurrencySupportGeneration({
    material,
    observation,
    through,
  }: {
    readonly material: PricingAuthorityMaterial<'PRICING_CURRENCY_SUPPORT_AUTHORITY'>;
    readonly observation: PricingFenceObservation;
    readonly through: string;
  }) {
    const checked = yield* dependencies.currencySupport
      .verifyCurrentThrough({ support: material.support, through })
      .pipe(Effect.mapError((cause) => unavailable('Currency Support generation history is unavailable', cause)));
    if (
      checked.outcome !== 'UNCHANGED_THROUGH' ||
      anyMismatch(
        checked.verifiedThrough < through,
        checked.generation !== material.support.generation,
        generationRef(checked.generation) !== observation.currentInvalidationGenerationRef,
        checked.supportRootId !== observation.ownerRootRef,
        checked.supportRevisionId !== observation.currentOwnerSetRevisionRef,
      )
    ) {
      return yield* unavailable('Currency Support generation was not stable through aggregate completion');
    }
    return yield* Effect.void;
  });

  const originalProofDoesNotBind = (
    expected: PricingMaterialEvidenceFenceExpectation,
    original: PricingCurrentDecisionResolvedOriginalProof,
  ) =>
    anyMismatch(
      original.evidenceVerificationRef !== expected.evidenceVerificationRef,
      original.observedAt !== expected.evidenceObservedAt,
      original.ownerRootRef !== expected.ownerRootRef,
      original.ownerSetRevisionRef !== expected.ownerSetRevisionRef,
      original.predicateRef !== expected.predicateRef,
      !matchingFacts(expected.currentFacts, original.currentFacts),
      !Number.isSafeInteger(original.evidenceInvalidationGeneration),
      original.evidenceInvalidationGeneration < 0,
    );

  const retainedOwnerReadDoesNotBind = (
    completeness: PricingSetBackedFenceSource['sourceEvidence']['completeness'],
    material: PricingVerificationMaterial,
    original: PricingCurrentDecisionResolvedOriginalProof,
  ) => {
    if (
      material.kind !== 'PRICING_PRICE_AUTHORITY' &&
      material.kind !== 'PRICING_QUANTITY_TIER_AUTHORITY' &&
      material.kind !== 'PRICING_COMMERCIAL_FEE_AUTHORITY' &&
      material.kind !== 'PRICING_ZERO_FLOOR_AUTHORITY'
    ) {
      return false;
    }
    return anyMismatch(
      material.ownerReadReceipt.authority.verificationRef !== original.evidenceVerificationRef,
      material.ownerReadReceipt.authority.observedAt !== original.observedAt,
      material.ownerReadReceipt.authority.nextApplicabilityBoundary !== completeness.temporal.nextMaterialBoundary,
      material.ownerReadReceipt.authority.ownerRootRef !== original.ownerRootRef,
      material.ownerReadReceipt.authority.ownerRevision !== original.ownerSetRevisionRef,
      material.ownerReadReceipt.authority.predicateRef !== original.predicateRef,
      material.ownerReadReceipt.authority.generation !== original.evidenceInvalidationGeneration,
      !matchingFacts(material.ownerReadReceipt.factProofs, original.currentFacts),
    );
  };

  const discountOwnerReadDoesNotBind = (
    material: PricingAuthorityMaterial<'PRICING_DISCOUNT_AUTHORITY'>,
    discountProof: DiscountOriginalProof | undefined,
  ) =>
    discountProof === undefined ||
    anyMismatch(
      material.ownerReadReceipt.authority.verificationRef !== discountProof.authority.verificationRef,
      material.ownerReadReceipt.authority.observedAt !== discountProof.authority.observedAt,
      material.ownerReadReceipt.authority.ownerRootRef !== discountProof.authority.ownerRootRef,
      material.ownerReadReceipt.authority.ownerRevision !== discountProof.authority.ownerRevision,
      material.ownerReadReceipt.authority.predicateRef !== discountProof.authority.predicateRef,
      material.ownerReadReceipt.authority.generation !== discountProof.authority.generation,
      !sameDiscountPredicate(material.ownerReadReceipt.predicate, discountProof.predicate),
      !matchingFacts(material.ownerReadReceipt.factProofs, discountProof.currentFacts),
    );

  const verifyPriceSource = Effect.fn('CurrentPricingDecisionOwnerFinalFence.verifyPriceSource')(
    function* verifyPriceSource({
      expected,
      material,
      original,
    }: {
      readonly expected: PricingMaterialEvidenceFenceExpectation;
      readonly material: PricingAuthorityMaterial<'PRICING_PRICE_AUTHORITY'>;
      readonly original: PricingCurrentDecisionResolvedOriginalProof;
    }) {
      const read = yield* dependencies.prices
        .readExactCandidateSet({
          effectiveAt: material.lookupRequest.effectiveAt,
          exactKey: material.lookupRequest.exactKey,
        })
        .pipe(Effect.mapError((cause) => unavailable('Price Current-set authority is unavailable', cause)));
      if (read.outcome !== 'EXACT_PRICE_CANDIDATE_SET_CURRENT') {
        return yield* unavailable('Price Current set is conflicting or unverifiable');
      }
      const { authority, candidateSet, factProofs } = read;
      const currentFacts = candidateSet.candidates.map(({ priceRef, priceRevision }) => ({
        factRef: priceRef.resourceId,
        factRevisionRef: priceRevision.revisionId,
      }));
      if (
        anyMismatch(
          authority.verificationRef !== expected.evidenceVerificationRef,
          authority.ownerRootRef !== expected.ownerRootRef,
          authority.ownerRevision !== expected.ownerSetRevisionRef,
          authority.predicateRef !== expected.predicateRef,
          candidateSet.effectiveAt !== material.lookupRequest.effectiveAt,
          !samePriceKey(candidateSet.exactKey, material.lookupRequest.exactKey),
          !matchingFactIdentities(original.currentFacts, currentFacts),
          !matchingFacts(original.currentFacts, factProofs),
        )
      ) {
        return yield* unavailable('Price opaque proof or Current facts do not match retained evidence');
      }
      return {
        currencyCode: expected.currencyCode,
        currentFacts: original.currentFacts,
        currentInvalidationGenerationRef: generationRef(authority.generation),
        currentOwnerSetRevisionRef: authority.ownerRevision,
        evidenceInvalidationGenerationRef: generationRef(original.evidenceInvalidationGeneration),
        evidenceVerificationRef: expected.evidenceVerificationRef,
        family: expected.family,
        observedAt: authority.observedAt,
        ownerModuleId: PRICING_MODULE_ID,
        ownerRootRef: authority.ownerRootRef,
        predicateRef: authority.predicateRef,
        tenantId: expected.tenantId,
      };
    },
  );

  const verifyTierSource = Effect.fn('CurrentPricingDecisionOwnerFinalFence.verifyTierSource')(
    function* verifyTierSource({
      expected,
      material,
      tierProof,
      verificationContext,
    }: {
      readonly expected: PricingMaterialEvidenceFenceExpectation;
      readonly material: PricingAuthorityMaterial<'PRICING_QUANTITY_TIER_AUTHORITY'>;
      readonly tierProof: QuantityTierOriginalProof;
      readonly verificationContext: PricingFenceVerificationContext;
    }) {
      if (tierProof.outcome !== 'QUANTITY_TIER_SET_PROOF_RESOLVED') {
        return yield* unavailable('Original Tier set proof is absent');
      }
      const retained = material.selectionInput.tierSet;
      const retainedReceipt = material.ownerReadReceipt;
      if (
        anyMismatch(
          expected.family !== 'QUANTITY_TIER',
          !samePriceRef(tierProof.tierSet.priceRef, retained.priceRef),
          retainedReceipt.authority.verificationRef !== expected.evidenceVerificationRef,
          retainedReceipt.authority.generation !== tierProof.authority.generation,
          retainedReceipt.authority.observedAt !== tierProof.authority.observedAt,
          retainedReceipt.authority.ownerRootRef !== tierProof.authority.ownerRootRef,
          retainedReceipt.authority.ownerRevision !== tierProof.authority.ownerRevision,
          retainedReceipt.authority.predicateRef !== tierProof.authority.predicateRef,
          !matchingFacts(retainedReceipt.factProofs, tierProof.currentFacts),
          !matchingFacts(retained.factProofs, tierProof.currentFacts),
        )
      ) {
        return yield* unavailable('Tier durable proof does not bind retained owner read');
      }
      const current = yield* dependencies.tiers
        .readCurrentSet({ effectiveAt: verificationContext.effectiveAt, priceRef: retained.priceRef })
        .pipe(Effect.mapError((cause) => unavailable('Tier Current-set authority is unavailable', cause)));
      if (current.outcome !== 'QUANTITY_TIER_SET_CURRENT') {
        return yield* unavailable('Tier Current set differs from retained owner proof');
      }
      if (
        anyMismatch(
          current.authority.generation !== tierProof.authority.generation,
          current.authority.ownerRootRef !== tierProof.authority.ownerRootRef,
          current.authority.ownerRevision !== tierProof.authority.ownerRevision,
          current.authority.predicateRef !== tierProof.authority.predicateRef,
          !samePriceRef(current.tierSet.priceRef, retained.priceRef),
          !matchingFactIdentities(tierProof.currentFacts, current.tierSet.factProofs),
        )
      ) {
        return yield* unavailable('Tier Current set differs from retained owner proof');
      }
      return {
        currencyCode: expected.currencyCode,
        currentFacts: tierProof.currentFacts,
        currentInvalidationGenerationRef: generationRef(current.authority.generation),
        currentOwnerSetRevisionRef: current.authority.ownerRevision,
        evidenceInvalidationGenerationRef: generationRef(tierProof.authority.generation),
        evidenceVerificationRef: expected.evidenceVerificationRef,
        family: expected.family,
        observedAt: current.authority.observedAt,
        ownerModuleId: PRICING_MODULE_ID,
        ownerRootRef: current.authority.ownerRootRef,
        predicateRef: current.authority.predicateRef,
        tenantId: expected.tenantId,
      };
    },
  );

  const verifyCommercialFeeSource = Effect.fn('CurrentPricingDecisionOwnerFinalFence.verifyCommercialFeeSource')(
    function* verifyCommercialFeeSource({
      expected,
      material,
      original,
      verificationContext,
    }: {
      readonly expected: PricingMaterialEvidenceFenceExpectation;
      readonly material: PricingAuthorityMaterial<'PRICING_COMMERCIAL_FEE_AUTHORITY'>;
      readonly original: PricingCurrentDecisionResolvedOriginalProof;
      readonly verificationContext: PricingFenceVerificationContext;
    }) {
      const retained = material.currentSet;
      const read = yield* dependencies.fees
        .readCurrentSet({
          commercialScope: retained.commercialScope,
          currencyCode: retained.currencyCode,
          effectiveAt: verificationContext.effectiveAt,
          target: retained.target,
        })
        .pipe(Effect.mapError((cause) => unavailable('Commercial Fee Current-set authority is unavailable', cause)));
      if (read.outcome !== 'COMMERCIAL_FEE_SET_CURRENT') {
        return yield* unavailable('Commercial Fee Current set is missing, conflicting, or unverifiable');
      }
      const { authority, factProofs, feeSet } = read;
      const currentFacts = feeSet.fees.map(({ definition }) => ({
        factRef: definition.feeRef.resourceId,
        factRevisionRef: definition.revision.revisionId,
      }));
      if (
        anyMismatch(
          authority.verificationRef !== expected.evidenceVerificationRef,
          authority.ownerRootRef !== expected.ownerRootRef,
          authority.ownerRevision !== expected.ownerSetRevisionRef,
          authority.predicateRef !== expected.predicateRef,
          !sameCommercialScope(feeSet.commercialScope, retained.commercialScope),
          feeSet.currencyCode !== retained.currencyCode,
          !sameFeeTarget(feeSet.target, retained.target),
          !matchingFactIdentities(original.currentFacts, currentFacts),
          !matchingFacts(original.currentFacts, factProofs),
        )
      ) {
        return yield* unavailable('Commercial Fee opaque proof or Current facts do not match retained evidence');
      }
      return {
        currencyCode: expected.currencyCode,
        currentFacts: original.currentFacts,
        currentInvalidationGenerationRef: generationRef(authority.generation),
        currentOwnerSetRevisionRef: authority.ownerRevision,
        evidenceInvalidationGenerationRef: generationRef(original.evidenceInvalidationGeneration),
        evidenceVerificationRef: expected.evidenceVerificationRef,
        family: expected.family,
        observedAt: authority.observedAt,
        ownerModuleId: PRICING_MODULE_ID,
        ownerRootRef: authority.ownerRootRef,
        predicateRef: authority.predicateRef,
        tenantId: expected.tenantId,
      };
    },
  );

  const verifyDiscountSource = Effect.fn('CurrentPricingDecisionOwnerFinalFence.verifyDiscountSource')(
    function* verifyDiscountSource({
      discountProof,
      expected,
      material,
      verificationContext,
    }: {
      readonly discountProof: DiscountOriginalProof;
      readonly expected: PricingMaterialEvidenceFenceExpectation;
      readonly material: PricingAuthorityMaterial<'PRICING_DISCOUNT_AUTHORITY'>;
      readonly verificationContext: PricingFenceVerificationContext;
    }) {
      const { predicate } = discountProof;
      if (!sameDiscountPredicate(material.ownerReadReceipt.predicate, predicate)) {
        return yield* unavailable('Discount proof does not bind the retained exact predicate');
      }
      if (
        anyMismatch(
          predicate.tenantId !== expected.tenantId,
          predicate.effectiveAt !== verificationContext.effectiveAt,
          expected.currencyCode !== undefined && predicate.currencyCode !== expected.currencyCode,
          material.identityKeys.some((key) => discountIdentityDoesNotBind(key, predicate)),
        )
      ) {
        return yield* unavailable('Discount proof predicate does not bind retained identity keys');
      }
      const current = yield* dependencies.discounts
        .readCurrentSet(predicate)
        .pipe(Effect.mapError((cause) => unavailable('Discount Current-set authority is unavailable', cause)));
      if (
        anyMismatch(
          current.authority.predicateRef !== expected.predicateRef,
          current.authority.ownerRootRef !== expected.ownerRootRef,
          current.authority.ownerRevision !== discountProof.authority.ownerRevision,
          current.authority.generation !== discountProof.authority.generation,
          !sameDiscountPredicate(current.predicate, material.ownerReadReceipt.predicate),
          !matchingFacts(discountProof.currentFacts, current.factProofs),
        )
      ) {
        return yield* unavailable('Discount Current set or fact proofs do not match retained evidence');
      }
      return {
        currencyCode: expected.currencyCode,
        currentFacts: current.factProofs,
        currentInvalidationGenerationRef: generationRef(current.authority.generation),
        currentOwnerSetRevisionRef: current.authority.ownerRevision,
        evidenceInvalidationGenerationRef: generationRef(discountProof.authority.generation),
        evidenceVerificationRef: expected.evidenceVerificationRef,
        family: expected.family,
        observedAt: current.authority.observedAt,
        ownerModuleId: PRICING_MODULE_ID,
        ownerRootRef: current.authority.ownerRootRef,
        predicateRef: current.authority.predicateRef,
        tenantId: expected.tenantId,
      };
    },
  );

  const verifyZeroFloorSource = Effect.fn('CurrentPricingDecisionOwnerFinalFence.verifyZeroFloorSource')(
    function* verifyZeroFloorSource({
      expected,
      material,
      original,
    }: {
      readonly expected: PricingMaterialEvidenceFenceExpectation;
      readonly material: PricingAuthorityMaterial<'PRICING_ZERO_FLOOR_AUTHORITY'>;
      readonly original: PricingCurrentDecisionResolvedOriginalProof;
    }) {
      const read = yield* dependencies.zeroFloor
        .readCurrentSet({ query: material.query })
        .pipe(Effect.mapError((cause) => unavailable('Zero Floor Current-set authority is unavailable', cause)));
      const { authority, authorizationSet, factProofs } = read;
      const currentFacts = authorizationSet.authorizations.map((authorization) => ({
        factRef: authorization.authorizationRef,
        factRevisionRef: authorization.authorizationRevision,
      }));
      if (
        anyMismatch(
          authority.verificationRef !== expected.evidenceVerificationRef,
          authority.ownerRootRef !== expected.ownerRootRef,
          authority.ownerRevision !== expected.ownerSetRevisionRef,
          authority.predicateRef !== expected.predicateRef,
          !sameZeroFloorQuery(authorizationSet.query, material.query),
          !matchingFactIdentities(original.currentFacts, currentFacts),
          !matchingFacts(original.currentFacts, factProofs),
        )
      ) {
        return yield* unavailable('Zero Floor opaque proof or Current facts do not match retained evidence');
      }
      return {
        currencyCode: expected.currencyCode,
        currentFacts: original.currentFacts,
        currentInvalidationGenerationRef: generationRef(authority.generation),
        currentOwnerSetRevisionRef: authority.ownerRevision,
        evidenceInvalidationGenerationRef: generationRef(original.evidenceInvalidationGeneration),
        evidenceVerificationRef: expected.evidenceVerificationRef,
        family: expected.family,
        observedAt: authority.observedAt,
        ownerModuleId: PRICING_MODULE_ID,
        ownerRootRef: authority.ownerRootRef,
        predicateRef: authority.predicateRef,
        tenantId: expected.tenantId,
      };
    },
  );

  const verifyCurrencySupportSource = Effect.fn('CurrentPricingDecisionOwnerFinalFence.verifyCurrencySupportSource')(
    function* verifyCurrencySupportSource({
      expected,
      material,
      original,
    }: {
      readonly expected: PricingMaterialEvidenceFenceExpectation;
      readonly material: PricingAuthorityMaterial<'PRICING_CURRENCY_SUPPORT_AUTHORITY'>;
      readonly original: PricingCurrentDecisionResolvedOriginalProof;
    }) {
      const retained = material.support;
      const read = yield* dependencies.currencySupport
        .loadCurrent({ effectiveAt: retained.effectiveAt, tenantId: retained.tenantId })
        .pipe(Effect.mapError((cause) => unavailable('Currency Support Current authority is unavailable', cause)));
      const currentOption = Match.value(read).pipe(
        Match.tag('current', ({ current: currentSupport }) => Option.some(currentSupport)),
        Match.orElse(() => Option.none<StoredCurrencySupport>()),
      );
      if (Option.isNone(currentOption)) {
        return yield* unavailable('Currency Support is absent, conflicting, or outside its Current period');
      }
      const current = currentOption.value;
      const currentFacts = [
        {
          factRef: current.supportRootRef.resourceId,
          factRevisionRef: current.supportRevisionRef.resourceId,
        },
      ];
      if (
        anyMismatch(
          current.supportRootRef.resourceId !== expected.ownerRootRef,
          current.supportRevisionRef.resourceId !== expected.ownerSetRevisionRef,
          current.predicateRef !== expected.predicateRef,
          current.verificationRef === undefined,
          current.factProofs === undefined,
          current.generation !== retained.generation,
          current.scheduleRevision !== retained.scheduleRevision,
          current.effectivePeriod.effectiveFrom !== retained.effectivePeriod.effectiveFrom,
          current.effectivePeriod.effectiveTo !== retained.effectivePeriod.effectiveTo,
          !sameOrderedValues(current.supportedCurrencies, retained.supportedCurrencies),
          !matchingFactIdentities(original.currentFacts, current.factProofs ?? []),
          !matchingFactIdentities(original.currentFacts, currentFacts),
        )
      ) {
        return yield* unavailable('Currency Support Current authority or facts do not match retained evidence');
      }
      return {
        currencyCode: expected.currencyCode,
        currentFacts: original.currentFacts,
        currentInvalidationGenerationRef: generationRef(current.generation),
        currentOwnerSetRevisionRef: current.supportRevisionRef.resourceId,
        evidenceInvalidationGenerationRef: generationRef(original.evidenceInvalidationGeneration),
        evidenceVerificationRef: expected.evidenceVerificationRef,
        family: expected.family,
        observedAt: current.observedAt,
        ownerModuleId: PRICING_MODULE_ID,
        ownerRootRef: current.supportRootRef.resourceId,
        predicateRef: expected.predicateRef,
        tenantId: expected.tenantId,
      };
    },
  );

  const resolveRetainedOriginalProof = Effect.fn('CurrentPricingDecisionOwnerFinalFence.resolveRetainedOriginalProof')(
    function* resolveRetainedOriginalProof({
      discountProof,
      expected,
      material,
      source,
      tierProof,
    }: {
      readonly discountProof: DiscountOriginalProof | undefined;
      readonly expected: PricingMaterialEvidenceFenceExpectation;
      readonly material: PricingVerificationMaterial;
      readonly source: PricingSetBackedFenceSource;
      readonly tierProof: QuantityTierOriginalProof | undefined;
    }) {
      if (material.kind === 'PRICING_CURRENCY_SUPPORT_AUTHORITY') {
        return yield* resolveCurrencyProof(source, expected);
      }
      if (tierProof?.outcome === 'QUANTITY_TIER_SET_PROOF_RESOLVED') {
        return {
          currentFacts: tierProof.currentFacts,
          evidenceInvalidationGeneration: tierProof.authority.generation,
          evidenceVerificationRef: tierProof.authority.verificationRef,
          observedAt: tierProof.authority.observedAt,
          ownerRootRef: tierProof.authority.ownerRootRef,
          ownerSetRevisionRef: tierProof.authority.ownerRevision,
          predicateRef: tierProof.authority.predicateRef,
        };
      }
      if (discountProof !== undefined) {
        return {
          currentFacts: discountProof.currentFacts,
          evidenceInvalidationGeneration: discountProof.authority.generation,
          evidenceVerificationRef: discountProof.authority.verificationRef,
          observedAt: discountProof.authority.observedAt,
          ownerRootRef: discountProof.authority.ownerRootRef,
          ownerSetRevisionRef: discountProof.authority.ownerRevision,
          predicateRef: discountProof.authority.predicateRef,
        };
      }
      if (dependencies.resolveOriginalProof === undefined) {
        return yield* unavailable('Original Pricing proof resolver has not been deployed');
      }
      return yield* dependencies.resolveOriginalProof({ expected, source });
    },
  );

  const verifyCurrentPricingSource = Effect.fn('CurrentPricingDecisionOwnerFinalFence.verifyCurrentPricingSource')(
    function* verifyCurrentPricingSource({
      discountProof,
      expected,
      material,
      original,
      tierProof,
      verificationContext,
    }: {
      readonly discountProof: DiscountOriginalProof | undefined;
      readonly expected: PricingMaterialEvidenceFenceExpectation;
      readonly material: PricingVerificationMaterial;
      readonly original: PricingCurrentDecisionResolvedOriginalProof;
      readonly tierProof: QuantityTierOriginalProof | undefined;
      readonly verificationContext: PricingFenceVerificationContext;
    }) {
      if (material.kind === 'PRICING_PRICE_AUTHORITY') {
        return yield* verifyPriceSource({ expected, material, original });
      }
      if (material.kind === 'PRICING_QUANTITY_TIER_AUTHORITY') {
        if (tierProof === undefined) {
          return yield* unavailable('Original Tier set proof is absent');
        }
        return yield* verifyTierSource({ expected, material, tierProof, verificationContext });
      }
      if (material.kind === 'PRICING_COMMERCIAL_FEE_AUTHORITY') {
        return yield* verifyCommercialFeeSource({ expected, material, original, verificationContext });
      }
      if (material.kind === 'PRICING_DISCOUNT_AUTHORITY') {
        if (discountProof === undefined) {
          return yield* unavailable('Original Discount predicate was not resolved');
        }
        return yield* verifyDiscountSource({ discountProof, expected, material, verificationContext });
      }
      if (material.kind === 'PRICING_ZERO_FLOOR_AUTHORITY') {
        return yield* verifyZeroFloorSource({ expected, material, original });
      }
      if (material.kind === 'PRICING_CURRENCY_SUPPORT_AUTHORITY') {
        return yield* verifyCurrencySupportSource({ expected, material, original });
      }
      return yield* unavailable(`Pricing owner has no exact proof resolver for ${material.kind}`);
    },
  );

  return {
    confirmObservedGenerationsThrough: Effect.fn(
      'CurrentPricingDecisionOwnerFinalFence.confirmObservedGenerationsThrough',
    )(function* confirmPricingGenerations({ candidateRef, observations, through, typedSources, verificationContext }) {
      if (
        typedSources === undefined ||
        verificationContext?.candidateRef !== candidateRef ||
        typedSources.length !== observations.length
      ) {
        return yield* unavailable('Exact typed Pricing source and candidate context are required');
      }
      const byProof = setBackedSourcesByProof(typedSources);
      if (byProof.size !== observations.length) {
        return yield* unavailable('Pricing source proofs must be distinct');
      }
      const confirmations = yield* Effect.forEach(
        observations,
        Effect.fn('CurrentPricingDecisionOwnerFinalFence.confirmPricingObservation')(
          function* confirmPricingObservation(observation) {
            const material = byProof.get(observation.evidenceVerificationRef)?.verificationMaterial;
            if (material?.kind === 'PRICING_PRICE_AUTHORITY') {
              yield* confirmPriceGeneration({ material, observation, through });
            } else if (material?.kind === 'PRICING_QUANTITY_TIER_AUTHORITY') {
              yield* confirmTierGeneration({
                effectiveAt: verificationContext.effectiveAt,
                material,
                observation,
                through,
              });
            } else if (material?.kind === 'PRICING_COMMERCIAL_FEE_AUTHORITY') {
              yield* confirmCommercialFeeGeneration({
                effectiveAt: verificationContext.effectiveAt,
                material,
                observation,
                through,
              });
            } else if (material?.kind === 'PRICING_DISCOUNT_AUTHORITY') {
              yield* confirmDiscountGeneration({ material, observation, through });
            } else if (material?.kind === 'PRICING_ZERO_FLOOR_AUTHORITY') {
              yield* confirmZeroFloorGeneration({ material, observation, through });
            } else if (material?.kind === 'PRICING_CURRENCY_SUPPORT_AUTHORITY') {
              yield* confirmCurrencySupportGeneration({ material, observation, through });
            } else {
              return yield* unavailable('Pricing owner cannot confirm this family generation');
            }
            return {
              currentFacts: observation.currentFacts,
              currentInvalidationGenerationRef: observation.currentInvalidationGenerationRef,
              currentOwnerSetRevisionRef: observation.currentOwnerSetRevisionRef,
              evidenceInvalidationGenerationRef: observation.evidenceInvalidationGenerationRef,
              evidenceVerificationRef: observation.evidenceVerificationRef,
            };
          },
        ),
        { concurrency: 1 },
      );
      return { confirmations, verifiedThrough: through };
    }),
    verifyOpaqueProofsAgainstCurrentState: Effect.fn(
      'CurrentPricingDecisionOwnerFinalFence.verifyOpaqueProofsAgainstCurrentState',
    )(function* verifyPricingProofs({ candidateRef, sources, typedSources, verificationContext }) {
      if (
        typedSources === undefined ||
        verificationContext?.candidateRef !== candidateRef ||
        typedSources.length !== sources.length
      ) {
        return yield* unavailable('Exact typed Pricing source and candidate context are required');
      }
      const byProof = setBackedSourcesByProof(typedSources);
      if (byProof.size !== sources.length) {
        return yield* unavailable('Pricing source proofs must be distinct');
      }
      const observations = yield* Effect.forEach(
        sources,
        Effect.fn('CurrentPricingDecisionOwnerFinalFence.verifyPricingSource')(function* verifyPricingSource(expected) {
          const source = byProof.get(expected.evidenceVerificationRef);
          if (source === undefined || source.sourceEvidence.request.ownerScope.ownerModuleId !== PRICING_MODULE_ID) {
            return yield* unavailable('Pricing source proof is missing or belongs to another owner');
          }
          const { completeness, request } = source.sourceEvidence;
          const retainedFactsMatch = Match.value(source.sourceEvidence).pipe(
            Match.tag('VERIFIED_PRESENT', ({ currentFacts }) =>
              matchingFacts(expected.currentFacts, retainedCurrentFacts(currentFacts)),
            ),
            Match.tag('VERIFIED_ABSENT', () => expected.currentFacts.length === 0),
            Match.exhaustive,
          );
          if (
            anyMismatch(
              request.family !== expected.family,
              request.currencyCode !== expected.currencyCode,
              request.effectiveAt !== verificationContext.effectiveAt,
              request.ownerScope.tenantId !== expected.tenantId,
              request.ownerScope.ownerRootRef !== expected.ownerRootRef,
              request.ownerScope.predicateRef !== expected.predicateRef,
              completeness.ownerSetRevisionRef !== expected.ownerSetRevisionRef,
              completeness.temporal.observedAt !== expected.evidenceObservedAt,
              !retainedFactsMatch,
            )
          ) {
            return yield* unavailable('Pricing retained source does not bind the requested owner proof');
          }
          const material = source.verificationMaterial;
          const discountProof =
            material.kind === 'PRICING_DISCOUNT_AUTHORITY'
              ? yield* dependencies.discounts
                  .resolveOriginalSetProof({ verificationRef: expected.evidenceVerificationRef })
                  .pipe(Effect.mapError((cause) => unavailable('Original Discount proof cannot be resolved', cause)))
              : undefined;
          const tierProof =
            material.kind === 'PRICING_QUANTITY_TIER_AUTHORITY'
              ? yield* dependencies.tiers
                  .resolveQuantityTierSetProof({
                    effectiveAt: verificationContext.effectiveAt,
                    priceRef: material.selectionInput.tierSet.priceRef,
                    verificationRef: expected.evidenceVerificationRef,
                  })
                  .pipe(Effect.mapError((cause) => unavailable('Original Tier proof cannot be resolved', cause)))
              : undefined;
          const original = yield* resolveRetainedOriginalProof({
            discountProof,
            expected,
            material,
            source,
            tierProof,
          });
          if (originalProofDoesNotBind(expected, original)) {
            return yield* unavailable(
              'Original Pricing proof did not resolve to its retained set, facts, and generation',
            );
          }
          if (retainedOwnerReadDoesNotBind(completeness, material, original)) {
            return yield* unavailable('Pricing original receipt differs from the retained owner read');
          }
          if (material.kind === 'PRICING_DISCOUNT_AUTHORITY' && discountOwnerReadDoesNotBind(material, discountProof)) {
            return yield* unavailable('Discount original proof differs from the retained Current-set receipt');
          }
          return yield* verifyCurrentPricingSource({
            discountProof,
            expected,
            material,
            original,
            tierProof,
            verificationContext,
          });
        }),
        { concurrency: 1 },
      );
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      return { completedAt, observations };
    }),
  };
};

/** Same governed transaction and trusted operational scope as the current Pricing evaluation. */
export const pricingCurrentDecisionPricingOwnerFinalFenceGatewayForScope = (
  transaction: Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0],
  scope: OperationalScope,
  compositionRevision: string,
): Effect.Effect<PricingOwnerMaterialEvidenceFenceGateway, OperationContextUnavailable> =>
  Effect.all(
    {
      currency: currencySupportPersistenceForScope(transaction, scope, compositionRevision),
      currencyGeneration: currencySupportGenerationVerificationPersistenceForScope(
        transaction,
        scope,
        compositionRevision,
      ),
      currencyProof: currencySupportProofResolutionPersistenceForScope(transaction, scope, compositionRevision),
      discounts: contractualDiscountPersistenceForScope(transaction, scope),
      fees: commercialFeePersistenceForScope(transaction, scope),
      prices: pricePersistenceForScope(transaction, scope),
      proof: materialEvidenceProofPersistenceForScope(transaction, scope),
      tiers: quantityTierPersistenceForScope(transaction, scope),
      zeroFloor: zeroFloorAuthorizationPersistenceForScope(transaction, scope),
    },
    { concurrency: 9 },
  ).pipe(
    Effect.map(({ currency, currencyGeneration, currencyProof, discounts, fees, prices, proof, tiers, zeroFloor }) =>
      makePricingCurrentDecisionPricingOwnerFinalFenceGateway({
        currencySupport: { ...currency, ...currencyGeneration, ...currencyProof },
        discounts,
        fees,
        prices,
        resolveOriginalProof: proof.resolveOriginalProof,
        tiers,
        zeroFloor,
      }),
    ),
  );

type MarketEvidenceClientEffect = ReturnType<typeof executePricingCurrentMarketEvidenceWithAuthorization>;
type MarketEvidenceClientFailure =
  MarketEvidenceClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type MarketEvidenceExecutor = (
  payload: PricingCurrentMarketEvidenceRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<unknown, MarketEvidenceClientFailure>;

const MARKET_OWNER_MODULE_ID = 'commerce.market-catalog';

const ownerGatewayUnavailable = (
  ownerModuleId: PricingMaterialEvidenceOwnerModule,
  reason: string,
  cause?: unknown,
) => {
  const failure = new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
    ownerModuleId,
    reason,
    retryable: true,
  });
  return cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { configurable: true, enumerable: false, value: cause });
};

const marketGatewayUnavailable = (reason: string, cause?: unknown) =>
  ownerGatewayUnavailable(MARKET_OWNER_MODULE_ID, reason, cause);

const customerContextGatewayUnavailable = (reason: string, cause?: unknown) =>
  ownerGatewayUnavailable('commerce.customer-context', reason, cause);

const catalogGatewayUnavailable = (reason: string, cause?: unknown) =>
  ownerGatewayUnavailable('commerce.catalog', reason, cause);

const indexSetBackedSourcesByProof = (sources: readonly PricingMaterialEvidenceFenceSource[]) => {
  const sourcesByProof = new Map<string, PricingSetBackedFenceSource>();
  for (const source of sources) {
    if (isSetBackedFenceSource(source)) {
      sourcesByProof.set(source.sourceEvidence.completeness.verification.verificationRef, source);
    }
  }
  return sourcesByProof;
};

const executeAuthorizedMarketEvidence: MarketEvidenceExecutor = (payload, credential, correlation, options) =>
  executePricingCurrentMarketEvidenceWithAuthorization(payload, Redacted.value(credential), correlation, options);

const marketReceiptFacts = (receipt: PricingMarketSourceReceipt) =>
  receipt.currentFacts.map((fact) => ({
    factRef: fact.factRef,
    factRevisionRef: fact.factRevisionRef,
    verificationRef: fact.verificationRef,
  }));

type MarketAuthorityMaterial = Extract<
  PricingSetBackedFenceSource['verificationMaterial'],
  { readonly kind: 'MARKET_CONTEXT_AUTHORITY' }
>;

const makeMarketRequest = ({
  effectiveAt,
  material,
  requestedAt,
  tenantId,
  verifyThrough,
}: {
  readonly effectiveAt: string;
  readonly material: MarketAuthorityMaterial;
  readonly requestedAt: DateTime.Utc;
  readonly tenantId: string;
  readonly verifyThrough: string | undefined;
}) => {
  const request = {
    commercialScope: {
      channel: material.commercialScope.channelId,
      marketRef: {
        moduleId: MARKET_OWNER_MODULE_ID,
        resourceId: material.commercialScope.marketId,
        resourceType: `${MARKET_OWNER_MODULE_ID}.market`,
        tenantId,
      },
      sellingLegalEntityRef: {
        moduleId: 'core.identity',
        resourceId: material.commercialScope.sellingLegalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
    },
    effectiveAt,
    requestedAt: DateTime.formatIso(requestedAt),
    retainedReceipt: material.receipt,
  };
  return Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceRequestSchema)(
    verifyThrough === undefined ? request : { ...request, verifyThrough },
  );
};

const sameMarketEvidenceRequest = Schema.toEquivalence(PricingCurrentMarketEvidenceRequestSchema);

export const makePricingCurrentDecisionMarketOwnerFinalFenceGateway = (dependencies: {
  readonly execute: MarketEvidenceExecutor;
  readonly issuer: CommercialContextGatewayCredentialIssuer;
}): PricingOwnerMaterialEvidenceFenceGateway => {
  const read = Effect.fn('makePricingCurrentDecisionMarketOwnerFinalFenceGateway.read')(function* readMarketEvidence({
    candidateRef,
    compositionRevision,
    expected,
    source,
    verifyThrough,
  }: {
    readonly candidateRef: string;
    readonly compositionRevision: string;
    readonly expected: Pick<PricingMaterialEvidenceFenceExpectation, 'tenantId'>;
    readonly source: PricingSetBackedFenceSource;
    readonly verifyThrough?: string;
  }) {
    const requestedAt = yield* DateTime.now;
    const material = source.verificationMaterial;
    if (material.kind !== 'MARKET_CONTEXT_AUTHORITY') {
      return yield* marketGatewayUnavailable('Market source does not retain owner-native replay authority');
    }
    const request = yield* makeMarketRequest({
      effectiveAt: source.sourceEvidence.request.effectiveAt,
      material,
      requestedAt,
      tenantId: expected.tenantId,
      verifyThrough,
    }).pipe(Effect.mapError((cause) => marketGatewayUnavailable('Market retained replay request is invalid', cause)));
    const { baseUrl, credential } = yield* dependencies.issuer
      .issue({
        audience: 'commerce-market-catalog',
        compositionRevision,
        legalEntityId: request.commercialScope.sellingLegalEntityRef.resourceId,
        requestCorrelation: candidateRef,
      })
      .pipe(Effect.mapError((cause) => marketGatewayUnavailable('Market owner credential is unavailable', cause)));
    const raw = yield* dependencies
      .execute(request, credential, candidateRef, { baseUrl, compositionRevision })
      .pipe(Effect.mapError((cause) => marketGatewayUnavailable('Market owner replay is unavailable', cause)));
    const response = yield* Schema.decodeUnknownEffect(PricingCurrentMarketEvidenceResponseSchema)(raw).pipe(
      Effect.mapError((cause) => marketGatewayUnavailable('Market owner replay response is unverifiable', cause)),
    );
    if (response.outcome !== 'PRICING_MARKET_SOURCE_PRESENT' && response.outcome !== 'PRICING_MARKET_SOURCE_ABSENT') {
      return yield* marketGatewayUnavailable(`Market owner replay failed closed with ${response.outcome}`);
    }
    if (!sameMarketEvidenceRequest(response.request, request)) {
      return yield* marketGatewayUnavailable('Market owner replay response does not bind the exact retained request');
    }
    return response;
  });

  const confirmMarketObservation = ({
    candidateRef,
    compositionRevision,
    observation,
    source,
    through,
  }: {
    readonly candidateRef: string;
    readonly compositionRevision: string;
    readonly observation: PricingFenceObservation;
    readonly source: PricingSetBackedFenceSource | undefined;
    readonly through: string;
  }) => {
    if (source === undefined) {
      return Effect.fail(marketGatewayUnavailable('Market generation source is missing'));
    }
    return read({ candidateRef, compositionRevision, expected: observation, source, verifyThrough: through }).pipe(
      Effect.flatMap((response) => {
        const { authority } = response.receipt;
        return response.verifiedThrough === undefined || DateTime.formatIso(response.verifiedThrough) < through
          ? Effect.fail(marketGatewayUnavailable('Market generation was not verified through aggregate completion'))
          : Effect.succeed({
              currentFacts: marketReceiptFacts(response.receipt),
              currentInvalidationGenerationRef: String(authority.generation),
              currentOwnerSetRevisionRef: authority.ownerSetRevisionRef,
              evidenceInvalidationGenerationRef: observation.evidenceInvalidationGenerationRef,
              evidenceVerificationRef: observation.evidenceVerificationRef,
            });
      }),
    );
  };

  const observeMarketExpectation = ({
    candidateRef,
    compositionRevision,
    expected,
    source,
  }: {
    readonly candidateRef: string;
    readonly compositionRevision: string;
    readonly expected: PricingMaterialEvidenceFenceExpectation;
    readonly source: PricingSetBackedFenceSource | undefined;
  }) => {
    if (source === undefined) {
      return Effect.fail(marketGatewayUnavailable('Market retained source is missing'));
    }
    return read({ candidateRef, compositionRevision, expected, source }).pipe(
      Effect.map((response) => {
        const { authority } = response.receipt;
        return {
          currentFacts: marketReceiptFacts(response.receipt),
          currentInvalidationGenerationRef: String(authority.generation),
          currentOwnerSetRevisionRef: authority.ownerSetRevisionRef,
          evidenceInvalidationGenerationRef: String(
            source.verificationMaterial.kind === 'MARKET_CONTEXT_AUTHORITY'
              ? source.verificationMaterial.receipt.authority.generation
              : -1,
          ),
          evidenceVerificationRef: expected.evidenceVerificationRef,
          family: expected.family,
          observedAt: DateTime.formatIso(authority.observedAt),
          ownerModuleId: expected.ownerModuleId,
          ownerRootRef: authority.ownerRootRef,
          predicateRef: authority.predicateRef,
          tenantId: expected.tenantId,
        };
      }),
    );
  };

  return {
    confirmObservedGenerationsThrough: Effect.fn(
      'makePricingCurrentDecisionMarketOwnerFinalFenceGateway.confirmObservedGenerationsThrough',
    )(function* confirmMarketGenerations({ candidateRef, compositionRevision, observations, through, typedSources }) {
      if (typedSources === undefined || typedSources.length !== observations.length) {
        return yield* marketGatewayUnavailable('Exact typed Market sources are required for generation confirmation');
      }
      const typedByProof = indexSetBackedSourcesByProof(typedSources);
      const confirmations = yield* Effect.forEach(
        observations,
        (observation) =>
          confirmMarketObservation({
            candidateRef,
            compositionRevision,
            observation,
            source: typedByProof.get(observation.evidenceVerificationRef),
            through,
          }),
        { concurrency: 5 },
      );
      return { confirmations, verifiedThrough: through };
    }),
    verifyOpaqueProofsAgainstCurrentState: Effect.fn(
      'makePricingCurrentDecisionMarketOwnerFinalFenceGateway.verifyOpaqueProofsAgainstCurrentState',
    )(function* verifyMarketProofs({ candidateRef, compositionRevision, sources, typedSources, verificationContext }) {
      if (
        typedSources === undefined ||
        verificationContext?.candidateRef !== candidateRef ||
        typedSources.length !== sources.length
      ) {
        return yield* marketGatewayUnavailable('Exact typed Market sources and candidate context are required');
      }
      const typedByProof = indexSetBackedSourcesByProof(typedSources);
      const observations = yield* Effect.forEach(
        sources,
        (expected) =>
          observeMarketExpectation({
            candidateRef,
            compositionRevision,
            expected,
            source: typedByProof.get(expected.evidenceVerificationRef),
          }),
        { concurrency: 5 },
      );
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      return { completedAt, observations };
    }),
  };
};

export const pricingCurrentDecisionMarketOwnerFinalFenceLive = Layer.effect(
  PricingMarketMaterialEvidenceFenceGateway,
  Effect.serviceOption(CommercialContextGatewayCredentialService).pipe(
    Effect.map((issuer) =>
      makePricingCurrentDecisionMarketOwnerFinalFenceGateway({
        execute: executeAuthorizedMarketEvidence,
        issuer: Option.isSome(issuer) ? issuer.value : unavailableCommercialContextGatewayCredentialIssuer,
      }),
    ),
  ),
);

type CustomerGroupClientEffect = ReturnType<typeof executeCustomerPriceGroupResolutionWithAuthorization>;
type CustomerGroupClientFailure =
  CustomerGroupClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type CustomerGroupExecutor = (
  payload: CustomerPriceGroupResolutionRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<unknown, CustomerGroupClientFailure>;

const executeAuthorizedCustomerGroup: CustomerGroupExecutor = (payload, credential, correlation, options) =>
  executeCustomerPriceGroupResolutionWithAuthorization(payload, Redacted.value(credential), correlation, options);
const sameCustomerGroupProfile = Schema.toEquivalence(PriceGroupAssignmentProfileSchema);
const sameCustomerGroupResolution = Schema.toEquivalence(PriceGroupAssignmentResolutionSchema);

export const makePricingCurrentDecisionCustomerContextOwnerFinalFenceGateway = (dependencies: {
  readonly execute: CustomerGroupExecutor;
  readonly issuer: CommercePriceGroupResolutionGatewayCredentialIssuer;
}): PricingOwnerMaterialEvidenceFenceGateway => {
  const read = Effect.fn('makePricingCurrentDecisionCustomerContextOwnerFinalFenceGateway.read')(
    function* readCustomerContextEvidence({
      candidateRef,
      compositionRevision,
      source,
    }: {
      readonly candidateRef: string;
      readonly compositionRevision: string;
      readonly source: PricingMaterialEvidenceFenceSource;
    }) {
      const material = source.verificationMaterial;
      if (material.kind !== 'CUSTOMER_CONTEXT_GROUP_AUTHORITY') {
        return yield* customerContextGatewayUnavailable(
          material.kind === 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY'
            ? 'Purchase Context replay requires the original trusted same-principal gateway assertion, which is not retained by the final-fence request'
            : 'Customer Context source is not an exact Price Group replay predicate',
        );
      }
      const request = yield* Schema.decodeEffect(CustomerPriceGroupResolutionRequestSchema)({
        ...material.request,
        effectiveAt: material.response.effectiveAt,
      }).pipe(
        Effect.mapError((cause) =>
          customerContextGatewayUnavailable('Customer Price Group replay request is invalid', cause),
        ),
      );
      const { baseUrl, credential } = yield* dependencies.issuer
        .issue({
          audience: 'commerce-customer-context',
          compositionRevision,
          legalEntityId: material.input.basis.commercialScope.sellingLegalEntityId,
          requestCorrelation: candidateRef,
        })
        .pipe(
          Effect.mapError((cause) =>
            customerContextGatewayUnavailable('Customer Context owner credential is unavailable', cause),
          ),
        );
      const raw = yield* dependencies
        .execute(request, credential, candidateRef, { baseUrl, compositionRevision })
        .pipe(
          Effect.mapError((cause) =>
            customerContextGatewayUnavailable('Customer Price Group owner replay is unavailable', cause),
          ),
        );
      const response = yield* Schema.decodeUnknownEffect(CustomerPriceGroupResolutionResponseSchema)(raw).pipe(
        Effect.mapError((cause) =>
          customerContextGatewayUnavailable('Customer Price Group owner replay response is unverifiable', cause),
        ),
      );
      const retained = material.response;
      if (
        !sameCustomerGroupProfile(response.profile, retained.profile) ||
        !Schema.is(PriceGroupAssignmentResolutionSchema)(response.resolution) ||
        !sameCustomerGroupResolution(response.resolution, retained.resolution) ||
        response.effectiveAt !== retained.effectiveAt ||
        response.generation !== retained.generation ||
        response.completenessEvidence.ownerRevision !== retained.completenessEvidence.ownerRevision ||
        response.completenessEvidence.scope.predicateRef !== retained.completenessEvidence.scope.predicateRef
      ) {
        return yield* customerContextGatewayUnavailable(
          'Customer Price Group generation or exact Current resolution changed',
        );
      }
      return response;
    },
  );
  const verifyPurchaseSingleton = (
    typedSources: readonly PricingMaterialEvidenceFenceSource[] | undefined,
  ): Effect.Effect<void, PricingOwnerMaterialEvidenceFenceGatewayUnavailable> => {
    const purchaseSources = typedSources?.filter(
      ({ verificationMaterial }) => verificationMaterial.kind === 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY',
    );
    return purchaseSources?.length === 1
      ? Effect.fail(
          customerContextGatewayUnavailable(
            'Purchase Context replay requires the original trusted same-principal gateway assertion, which is not retained by the final-fence request',
          ),
        )
      : Effect.fail(
          customerContextGatewayUnavailable(
            'Exact Purchase Context singleton authority is required at the final fence',
          ),
        );
  };

  const confirmCustomerGroupObservation = ({
    candidateRef,
    compositionRevision,
    observation,
    source,
    through,
  }: {
    readonly candidateRef: string;
    readonly compositionRevision: string;
    readonly observation: PricingFenceObservation;
    readonly source: PricingSetBackedFenceSource | undefined;
    readonly through: string;
  }) => {
    if (source === undefined) {
      return Effect.fail(customerContextGatewayUnavailable('Customer Context generation source is missing'));
    }
    return read({ candidateRef, compositionRevision, source }).pipe(
      Effect.flatMap((response) =>
        response.currentnessEvidence.revalidatedAt < through
          ? Effect.fail(
              customerContextGatewayUnavailable(
                'Customer Price Group generation was not revalidated through completion',
              ),
            )
          : Effect.succeed({
              currentFacts: observation.currentFacts,
              currentInvalidationGenerationRef: response.generation,
              currentOwnerSetRevisionRef: response.completenessEvidence.ownerRevision,
              evidenceInvalidationGenerationRef: observation.evidenceInvalidationGenerationRef,
              evidenceVerificationRef: observation.evidenceVerificationRef,
            }),
      ),
    );
  };

  const observeCustomerGroupExpectation = ({
    candidateRef,
    compositionRevision,
    expected,
    source,
  }: {
    readonly candidateRef: string;
    readonly compositionRevision: string;
    readonly expected: PricingMaterialEvidenceFenceExpectation;
    readonly source: PricingSetBackedFenceSource | undefined;
  }) => {
    if (source === undefined) {
      return Effect.fail(customerContextGatewayUnavailable('Customer Context retained source is missing'));
    }
    return read({ candidateRef, compositionRevision, source }).pipe(
      Effect.map((response) => {
        const retained = source.verificationMaterial;
        const evidenceGeneration =
          retained.kind === 'CUSTOMER_CONTEXT_GROUP_AUTHORITY' ? retained.response.generation : '';
        return {
          currentFacts: expected.currentFacts,
          currentInvalidationGenerationRef: response.generation,
          currentOwnerSetRevisionRef: response.completenessEvidence.ownerRevision,
          evidenceInvalidationGenerationRef: evidenceGeneration,
          evidenceVerificationRef: expected.evidenceVerificationRef,
          family: expected.family,
          observedAt: response.observedAt,
          ownerModuleId: expected.ownerModuleId,
          ownerRootRef: expected.ownerRootRef,
          predicateRef: response.completenessEvidence.scope.predicateRef,
          tenantId: expected.tenantId,
        };
      }),
    );
  };

  return {
    confirmObservedGenerationsThrough: Effect.fn(
      'makePricingCurrentDecisionCustomerContextOwnerFinalFenceGateway.confirmObservedGenerationsThrough',
    )(function* confirmCustomerContextGenerations({
      candidateRef,
      compositionRevision,
      observations,
      through,
      typedSources,
    }) {
      yield* verifyPurchaseSingleton(typedSources);
      if (typedSources === undefined) {
        return yield* customerContextGatewayUnavailable(
          'Exact typed Customer Context sources are required for generation confirmation',
        );
      }
      const setBackedSources = typedSources.filter(isSetBackedFenceSource);
      if (setBackedSources.length !== observations.length) {
        return yield* customerContextGatewayUnavailable(
          'Exact typed Customer Context sources are required for generation confirmation',
        );
      }
      const typedByProof = new Map(
        setBackedSources.map((source) => [source.sourceEvidence.completeness.verification.verificationRef, source]),
      );
      const confirmations = yield* Effect.forEach(
        observations,
        (observation) =>
          confirmCustomerGroupObservation({
            candidateRef,
            compositionRevision,
            observation,
            source: typedByProof.get(observation.evidenceVerificationRef),
            through,
          }),
        { concurrency: 5 },
      );
      return { confirmations, verifiedThrough: DateTime.formatIso(yield* DateTime.now) };
    }),
    verifyOpaqueProofsAgainstCurrentState: Effect.fn(
      'makePricingCurrentDecisionCustomerContextOwnerFinalFenceGateway.verifyOpaqueProofsAgainstCurrentState',
    )(function* verifyCustomerContextProofs({
      candidateRef,
      compositionRevision,
      sources,
      typedSources,
      verificationContext,
    }) {
      yield* verifyPurchaseSingleton(typedSources);
      if (typedSources === undefined) {
        return yield* customerContextGatewayUnavailable(
          'Exact typed Customer Context sources and candidate context are required',
        );
      }
      const setBackedSources = typedSources.filter(isSetBackedFenceSource);
      if (verificationContext?.candidateRef !== candidateRef || setBackedSources.length !== sources.length) {
        return yield* customerContextGatewayUnavailable(
          'Exact typed Customer Context sources and candidate context are required',
        );
      }
      const typedByProof = new Map(
        setBackedSources.map((source) => [source.sourceEvidence.completeness.verification.verificationRef, source]),
      );
      const observations = yield* Effect.forEach(
        sources,
        (expected) =>
          observeCustomerGroupExpectation({
            candidateRef,
            compositionRevision,
            expected,
            source: typedByProof.get(expected.evidenceVerificationRef),
          }),
        { concurrency: 5 },
      );
      return { completedAt: DateTime.formatIso(yield* DateTime.now), observations };
    }),
  };
};

export const pricingCurrentDecisionCustomerContextOwnerFinalFenceLive = Layer.effect(
  PricingCustomerContextMaterialEvidenceFenceGateway,
  Effect.serviceOption(CommercePriceGroupResolutionGatewayCredentialService).pipe(
    Effect.map((issuer) =>
      makePricingCurrentDecisionCustomerContextOwnerFinalFenceGateway({
        execute: executeAuthorizedCustomerGroup,
        issuer: Option.isSome(issuer) ? issuer.value : unavailableCommercePriceGroupResolutionGatewayCredentialIssuer,
      }),
    ),
  ),
);

type CatalogQuantityClientEffect = ReturnType<typeof executeQuantityBasisCompatibilityWithAuthorization>;
type CatalogQuantityClientFailure =
  CatalogQuantityClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type CatalogQuantityExecutor = (
  payload: QuantityBasisCompatibilityRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<unknown, CatalogQuantityClientFailure>;
type CatalogEquivalenceClientEffect = ReturnType<typeof executePricingPurposeEquivalenceWithAuthorization>;
type CatalogEquivalenceClientFailure =
  CatalogEquivalenceClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type CatalogEquivalenceExecutor = (
  payload: PricingPurposeEquivalenceRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<unknown, CatalogEquivalenceClientFailure>;

const executeAuthorizedCatalogQuantity: CatalogQuantityExecutor = (payload, credential, correlation, options) =>
  executeQuantityBasisCompatibilityWithAuthorization(payload, Redacted.value(credential), correlation, options);
const executeAuthorizedCatalogEquivalence: CatalogEquivalenceExecutor = (payload, credential, correlation, options) =>
  executePricingPurposeEquivalenceWithAuthorization(payload, Redacted.value(credential), correlation, options);

const CatalogOwnerReplaySchema = Schema.Struct({
  generation: Schema.String,
  observedAt: PricingInstantSchema,
  ownerRevision: Schema.String,
  predicateRef: Schema.String,
  revalidatedAt: PricingInstantSchema,
});
type CatalogOwnerReplay = typeof CatalogOwnerReplaySchema.Type;

const catalogEvidenceGeneration = (material: PricingSetBackedFenceSource['verificationMaterial']) => {
  if (material.kind === 'CATALOG_LINE_AUTHORITY') {
    return 'verificationReceipt' in material.compatibilityResponse ? material.compatibilityResponse.generation : '';
  }
  if (
    material.kind === 'CATALOG_EQUIVALENCE_AUTHORITY' &&
    material.response.outcome === 'CATALOG_EQUIVALENCE_CONFIRMED'
  ) {
    return material.response.generation;
  }
  return '';
};

export const makePricingCurrentDecisionCatalogOwnerFinalFenceGateway = (dependencies: {
  readonly equivalence: CatalogEquivalenceExecutor;
  readonly issuer: CatalogSelectionGatewayCredentialIssuer;
  readonly quantity: CatalogQuantityExecutor;
}): PricingOwnerMaterialEvidenceFenceGateway => {
  const credential = (legalEntityId: string, candidateRef: string, compositionRevision: string) =>
    dependencies.issuer
      .issue({ audience: 'catalog', compositionRevision, legalEntityId, requestCorrelation: candidateRef })
      .pipe(Effect.mapError((cause) => catalogGatewayUnavailable('Catalog owner credential is unavailable', cause)));
  const read = Effect.fn('makePricingCurrentDecisionCatalogOwnerFinalFenceGateway.read')(function* readCatalogEvidence({
    candidateRef,
    compositionRevision,
    expected,
    legalEntityId,
    source,
  }: {
    readonly candidateRef: string;
    readonly compositionRevision: string;
    readonly expected: Pick<PricingMaterialEvidenceFenceExpectation, 'ownerSetRevisionRef' | 'predicateRef'>;
    readonly legalEntityId: string;
    readonly source: PricingSetBackedFenceSource;
  }): Effect.fn.Return<CatalogOwnerReplay, PricingOwnerMaterialEvidenceFenceGatewayUnavailable> {
    const connection = yield* credential(legalEntityId, candidateRef, compositionRevision);
    const material = source.verificationMaterial;
    if (material.kind === 'CATALOG_LINE_AUTHORITY') {
      const raw = yield* dependencies
        .quantity(material.compatibilityRequest, connection.credential, candidateRef, {
          baseUrl: connection.baseUrl,
          compositionRevision,
        })
        .pipe(Effect.mapError((cause) => catalogGatewayUnavailable('Catalog Quantity replay is unavailable', cause)));
      const response = yield* Schema.decodeUnknownEffect(QuantityBasisCompatibilityResponseSchema)(raw).pipe(
        Effect.mapError((cause) =>
          catalogGatewayUnavailable('Catalog Quantity replay response is unverifiable', cause),
        ),
      );
      if (
        !('verificationReceipt' in response) ||
        !('verificationReceipt' in material.compatibilityResponse) ||
        response.generation !== material.compatibilityResponse.generation ||
        response.verificationReceipt.ownerRevision !== expected.ownerSetRevisionRef ||
        response.verificationReceipt.predicateRef !== expected.predicateRef
      ) {
        return yield* catalogGatewayUnavailable('Catalog Quantity generation or exact predicate changed');
      }
      return {
        generation: response.generation,
        observedAt: response.currentnessEvidence.observedAt,
        ownerRevision: response.verificationReceipt.ownerRevision,
        predicateRef: response.verificationReceipt.predicateRef,
        revalidatedAt: response.currentnessEvidence.revalidatedAt,
      };
    }
    if (material.kind === 'CATALOG_EQUIVALENCE_AUTHORITY') {
      const raw = yield* dependencies
        .equivalence(material.request, connection.credential, candidateRef, {
          baseUrl: connection.baseUrl,
          compositionRevision,
        })
        .pipe(
          Effect.mapError((cause) => catalogGatewayUnavailable('Catalog equivalence replay is unavailable', cause)),
        );
      const response = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceResponseSchema)(raw).pipe(
        Effect.mapError((cause) =>
          catalogGatewayUnavailable('Catalog equivalence replay response is unverifiable', cause),
        ),
      );
      if (
        response.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED' ||
        material.response.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED' ||
        response.generation !== material.response.generation ||
        response.verificationReceipt.ownerRevision !== expected.ownerSetRevisionRef ||
        response.verificationReceipt.predicateRef !== expected.predicateRef
      ) {
        return yield* catalogGatewayUnavailable('Catalog equivalence generation or exact predicate changed');
      }
      return {
        generation: response.generation,
        observedAt: response.currentnessEvidence.observedAt,
        ownerRevision: response.verificationReceipt.ownerRevision,
        predicateRef: response.verificationReceipt.predicateRef,
        revalidatedAt: response.currentnessEvidence.revalidatedAt,
      };
    }
    return yield* catalogGatewayUnavailable('Catalog source does not retain a supported replay predicate');
  });

  const confirmCatalogObservation = ({
    candidateRef,
    compositionRevision,
    legalEntityId,
    observation,
    source,
    through,
  }: {
    readonly candidateRef: string;
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly observation: PricingFenceObservation;
    readonly source: PricingSetBackedFenceSource | undefined;
    readonly through: string;
  }) => {
    if (source === undefined) {
      return Effect.fail(catalogGatewayUnavailable('Catalog generation source is missing'));
    }
    return read({
      candidateRef,
      compositionRevision,
      expected: {
        ownerSetRevisionRef: observation.currentOwnerSetRevisionRef,
        predicateRef: observation.predicateRef,
      },
      legalEntityId,
      source,
    }).pipe(
      Effect.flatMap((replay) =>
        replay.revalidatedAt < through
          ? Effect.fail(
              catalogGatewayUnavailable('Catalog generation was not revalidated through aggregate completion'),
            )
          : Effect.succeed({
              currentFacts: observation.currentFacts,
              currentInvalidationGenerationRef: replay.generation,
              currentOwnerSetRevisionRef: replay.ownerRevision,
              evidenceInvalidationGenerationRef: observation.evidenceInvalidationGenerationRef,
              evidenceVerificationRef: observation.evidenceVerificationRef,
            }),
      ),
    );
  };

  const observeCatalogExpectation = ({
    candidateRef,
    compositionRevision,
    expected,
    legalEntityId,
    source,
  }: {
    readonly candidateRef: string;
    readonly compositionRevision: string;
    readonly expected: PricingMaterialEvidenceFenceExpectation;
    readonly legalEntityId: string;
    readonly source: PricingSetBackedFenceSource | undefined;
  }) => {
    if (source === undefined) {
      return Effect.fail(catalogGatewayUnavailable('Catalog retained source is missing'));
    }
    return read({ candidateRef, compositionRevision, expected, legalEntityId, source }).pipe(
      Effect.map((replay) => ({
        currentFacts: expected.currentFacts,
        currentInvalidationGenerationRef: replay.generation,
        currentOwnerSetRevisionRef: replay.ownerRevision,
        evidenceInvalidationGenerationRef: catalogEvidenceGeneration(source.verificationMaterial),
        evidenceVerificationRef: expected.evidenceVerificationRef,
        family: expected.family,
        observedAt: replay.observedAt,
        ownerModuleId: expected.ownerModuleId,
        ownerRootRef: expected.ownerRootRef,
        predicateRef: replay.predicateRef,
        tenantId: expected.tenantId,
      })),
    );
  };

  return {
    confirmObservedGenerationsThrough: Effect.fn(
      'makePricingCurrentDecisionCatalogOwnerFinalFenceGateway.confirmObservedGenerationsThrough',
    )(function* confirmCatalogGenerations({
      candidateRef,
      compositionRevision,
      observations,
      through,
      typedSources,
      verificationContext,
    }) {
      if (
        typedSources === undefined ||
        verificationContext === undefined ||
        typedSources.length !== observations.length
      ) {
        return yield* catalogGatewayUnavailable('Exact typed Catalog sources and candidate context are required');
      }
      const typedByProof = indexSetBackedSourcesByProof(typedSources);
      const legalEntityId = verificationContext.decision.commercialScope.sellingLegalEntityId;
      const confirmations = yield* Effect.forEach(
        observations,
        (observation) =>
          confirmCatalogObservation({
            candidateRef,
            compositionRevision,
            legalEntityId,
            observation,
            source: typedByProof.get(observation.evidenceVerificationRef),
            through,
          }),
        { concurrency: 5 },
      );
      return { confirmations, verifiedThrough: DateTime.formatIso(yield* DateTime.now) };
    }),
    verifyOpaqueProofsAgainstCurrentState: Effect.fn(
      'makePricingCurrentDecisionCatalogOwnerFinalFenceGateway.verifyOpaqueProofsAgainstCurrentState',
    )(function* verifyCatalogProofs({ candidateRef, compositionRevision, sources, typedSources, verificationContext }) {
      if (
        typedSources === undefined ||
        verificationContext?.candidateRef !== candidateRef ||
        typedSources.length !== sources.length
      ) {
        return yield* catalogGatewayUnavailable('Exact typed Catalog sources and candidate context are required');
      }
      const typedByProof = indexSetBackedSourcesByProof(typedSources);
      const legalEntityId = verificationContext.decision.commercialScope.sellingLegalEntityId;
      const observations = yield* Effect.forEach(
        sources,
        (expected) =>
          observeCatalogExpectation({
            candidateRef,
            compositionRevision,
            expected,
            legalEntityId,
            source: typedByProof.get(expected.evidenceVerificationRef),
          }),
        { concurrency: 5 },
      );
      return { completedAt: DateTime.formatIso(yield* DateTime.now), observations };
    }),
  };
};

export const pricingCurrentDecisionCatalogOwnerFinalFenceLive = Layer.effect(
  PricingCatalogMaterialEvidenceFenceGateway,
  Effect.serviceOption(CatalogSelectionGatewayCredentialService).pipe(
    Effect.map((issuer) =>
      makePricingCurrentDecisionCatalogOwnerFinalFenceGateway({
        equivalence: executeAuthorizedCatalogEquivalence,
        issuer: Option.isSome(issuer) ? issuer.value : unavailableCatalogSelectionGatewayCredentialIssuer,
        quantity: executeAuthorizedCatalogQuantity,
      }),
    ),
  ),
);

const missingAuthorityReason = {
  'commerce.catalog':
    'Catalog exposes Pricing-purpose equivalence but no owner endpoint that verifies its original proof and confirms the generation through the aggregate fence',
  'commerce.customer-context':
    'Customer Context has no published owner endpoint that rebinds an opaque Group-assignment proof and confirms its generation through the aggregate fence',
  'commerce.market-catalog':
    'Commerce Market has no published owner endpoint that rebinds an opaque Market proof and confirms its generation through the aggregate fence',
  'commerce.pricing':
    'Pricing has scoped Current and generation verifiers, but no deployed resolver for original opaque set and fact proofs across every material family',
  'commerce.promotion':
    'Promotion has no deployed owner endpoint for opaque contribution-proof verification and generation confirmation',
} satisfies Readonly<Record<PricingMaterialEvidenceOwnerModule, string>>;

const unavailableGateway = (
  ownerModuleId: PricingMaterialEvidenceOwnerModule,
): PricingOwnerMaterialEvidenceFenceGateway => {
  const unavailable = () =>
    Effect.fail(
      new PricingOwnerMaterialEvidenceFenceGatewayUnavailable({
        ownerModuleId,
        reason: missingAuthorityReason[ownerModuleId],
        retryable: true,
      }),
    );

  return {
    confirmObservedGenerationsThrough: unavailable,
    verifyOpaqueProofsAgainstCurrentState: unavailable,
  };
};

export interface PricingCurrentDecisionOwnerFinalFenceGateways {
  readonly catalog: PricingOwnerMaterialEvidenceFenceGateway;
  readonly customerContext: PricingOwnerMaterialEvidenceFenceGateway;
  readonly market: PricingOwnerMaterialEvidenceFenceGateway;
  readonly pricing: PricingOwnerMaterialEvidenceFenceGateway;
  readonly promotion: PricingOwnerMaterialEvidenceFenceGateway;
}

/**
 * Composition seam for replacing each fail-closed provider with its deployed owner adapter. A real
 * adapter remains owner-specific: this module never infers typed lookup keys or generations from
 * opaque references.
 */
export const makePricingCurrentDecisionOwnerFinalFenceGatewaysLive = (
  gateways: Partial<PricingCurrentDecisionOwnerFinalFenceGateways> = {},
) =>
  Layer.mergeAll(
    Layer.succeed(
      PricingPricingMaterialEvidenceFenceGateway,
      gateways.pricing ?? unavailableGateway(PRICING_MODULE_ID),
    ),
    gateways.catalog === undefined
      ? pricingCurrentDecisionCatalogOwnerFinalFenceLive
      : Layer.succeed(PricingCatalogMaterialEvidenceFenceGateway, gateways.catalog),
    gateways.market === undefined
      ? pricingCurrentDecisionMarketOwnerFinalFenceLive
      : Layer.succeed(PricingMarketMaterialEvidenceFenceGateway, gateways.market),
    gateways.customerContext === undefined
      ? pricingCurrentDecisionCustomerContextOwnerFinalFenceLive
      : Layer.succeed(PricingCustomerContextMaterialEvidenceFenceGateway, gateways.customerContext),
    gateways.promotion === undefined
      ? promotionModuleNotInstalledFinalFenceLive
      : Layer.succeed(PricingPromotionMaterialEvidenceFenceGateway, gateways.promotion),
  );

/**
 * Complete production dependency graph for the current owner capabilities. It deliberately makes
 * unsupported owner paths typed fail-closed and proves the source-free Promotion path through
 * authoritative active Application Composition. Deployments can replace each provider through
 * the factory above when that owner exposes the exact verification authority.
 */
export const pricingCurrentDecisionOwnerFinalFenceGatewaysLive =
  makePricingCurrentDecisionOwnerFinalFenceGatewaysLive();
