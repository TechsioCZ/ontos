import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Schema } from 'effect';

import {
  PricingCurrencyCodeSchema,
  PricingInstantSchema,
  PricingTenantIdSchema,
} from '../apis/current-supported-currencies.ts';
import {
  PricingDiscountScheduleAcknowledgementSchema,
  PricingDiscountScheduleFingerprintSchema,
  PricingDiscountScheduleSnapshotSchema,
  PricingDiscountAudienceSchema,
  PricingDiscountIdentityBasisSchema,
  ScheduledPricingDiscountRevisionSchema,
  pricingDiscountIdentityKeysEqual,
} from './discount.ts';
import type { PricingDiscountAudience, PricingDiscountIdentityBasis, PricingDiscountIdentityKey } from './discount.ts';
import { priceCatalogTargetsEqual } from './catalog-price-target.ts';
import { priceDecimalValuesEqual } from './price-definition.ts';
import { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

const sameResourceRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameBasis = (left: PricingDiscountIdentityBasis, right: PricingDiscountIdentityBasis): boolean => {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'WHOLE_PURCHASE' || right.kind === 'WHOLE_PURCHASE') {
    return left.kind === right.kind;
  }
  return (
    priceCatalogTargetsEqual(left.catalogSelection, right.catalogSelection) &&
    sameResourceRef(left.unitBasis.unitRef, right.unitBasis.unitRef) &&
    priceDecimalValuesEqual(left.unitBasis.quantity, right.unitBasis.quantity)
  );
};

const sameAudience = Schema.toEquivalence(PricingDiscountAudienceSchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);

const contractualAudience = (audience: PricingDiscountAudience): boolean => audience.kind !== 'CATALOG_PATH';
const contractualIdentity = (identityKey: PricingDiscountIdentityKey): boolean =>
  identityKey.family === 'CONTRACTUAL_DISCOUNT' && contractualAudience(identityKey.audience);

/** Immutable Discount revision narrowed to the contractual family owned by Pricing administration. */
export const PricingContractualDiscountRevisionSchema = ScheduledPricingDiscountRevisionSchema.check(
  Schema.makeFilter(({ definition }) =>
    contractualIdentity(definition.identityKey)
      ? undefined
      : 'Contractual Discount Revision must use a non-Catalog CONTRACTUAL_DISCOUNT identity',
  ),
);
export type PricingContractualDiscountRevision = typeof PricingContractualDiscountRevisionSchema.Type;

/** Complete immutable revision history and exact Current/future set for one contractual Discount. */
export const PricingContractualDiscountScheduleSnapshotSchema = PricingDiscountScheduleSnapshotSchema.check(
  Schema.makeFilter(({ identityKey }) =>
    contractualIdentity(identityKey)
      ? undefined
      : 'Contractual Discount schedule must use a non-Catalog CONTRACTUAL_DISCOUNT identity',
  ),
);
export type PricingContractualDiscountScheduleSnapshot = typeof PricingContractualDiscountScheduleSnapshotSchema.Type;

/** Exact lowercase SHA-256 fingerprint of the presented contractual Discount schedule state. */
export const PricingContractualDiscountScheduleFingerprintSchema = PricingDiscountScheduleFingerprintSchema;
export type PricingContractualDiscountScheduleFingerprint =
  typeof PricingContractualDiscountScheduleFingerprintSchema.Type;

/** Backend-verifiable acknowledgement bound to Principal, target, payload, interval, and presented future history. */
export const PricingContractualDiscountScheduleAcknowledgementSchema =
  PricingDiscountScheduleAcknowledgementSchema.check(
    Schema.makeFilter(({ identityKey }) =>
      contractualIdentity(identityKey)
        ? undefined
        : 'Contractual Discount acknowledgement must use a non-Catalog CONTRACTUAL_DISCOUNT identity',
    ),
  );
export type PricingContractualDiscountScheduleAcknowledgement =
  typeof PricingContractualDiscountScheduleAcknowledgementSchema.Type;

const audienceTenantId = (audience: PricingDiscountAudience): string => {
  if (audience.kind === 'PRICE_GROUP') {
    return audience.priceGroupRef.tenantId;
  }
  return audience.kind === 'COUNTERPARTY' ? audience.counterpartyRef.tenantId : audience.selection.productRef.tenantId;
};

export const PricingContractualDiscountSetPredicateSchema = Schema.Struct({
  audiences: Schema.Array(PricingDiscountAudienceSchema).check(
    Schema.isMinLength(1),
    Schema.makeFilter((audiences) =>
      audiences.every(contractualAudience) ? undefined : 'Contractual Discount set cannot contain Catalog audiences',
    ),
    Schema.makeFilter((audiences) =>
      audiences.every(
        (audience, index) =>
          !audiences.some((candidate, candidateIndex) => candidateIndex !== index && sameAudience(candidate, audience)),
      )
        ? undefined
        : 'Contractual Discount set audiences must be unique',
    ),
  ),
  basis: PricingDiscountIdentityBasisSchema,
  commercialScope: PricingCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  effectiveAt: PricingInstantSchema,
  tenantId: PricingTenantIdSchema,
}).check(
  Schema.makeFilter(({ audiences, basis, tenantId }) => {
    if (audiences.some((audience) => audienceTenantId(audience) !== tenantId)) {
      return 'Contractual Discount set audiences must belong to the exact Tenant predicate';
    }
    if (basis.kind === 'VARIANT_LINE' && basis.catalogSelection.productRef.tenantId !== tenantId) {
      return 'Contractual Discount set Variant basis must belong to the exact Tenant predicate';
    }
    return basis.kind === 'WHOLE_PURCHASE' && audiences.some((audience) => audience.kind !== 'COUNTERPARTY')
      ? 'Whole-purchase contractual Discount set supports only exact Counterparty audiences'
      : undefined;
  }),
);
export type PricingContractualDiscountSetPredicate = typeof PricingContractualDiscountSetPredicateSchema.Type;

const resourceReference = (reference: {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}): string => [reference.tenantId, reference.moduleId, reference.resourceType, reference.resourceId].join('/');

const audienceReference = (audience: PricingDiscountAudience): string => {
  if (audience.kind === 'PRICE_GROUP') {
    return resourceReference(audience.priceGroupRef);
  }
  return audience.kind === 'COUNTERPARTY' ? resourceReference(audience.counterpartyRef) : 'catalog';
};

export const pricingContractualDiscountSetPredicateRef = (
  predicate: PricingContractualDiscountSetPredicate,
): string => {
  const basisReference =
    predicate.basis.kind === 'WHOLE_PURCHASE'
      ? 'whole-purchase'
      : [
          resourceReference(predicate.basis.catalogSelection.productRef),
          resourceReference(predicate.basis.catalogSelection.variantRef),
          resourceReference(predicate.basis.unitBasis.unitRef),
          predicate.basis.unitBasis.quantity,
        ].join(':');
  const audienceReferences = predicate.audiences.map(audienceReference).toSorted().join(',');
  const values = [
    predicate.tenantId,
    predicate.commercialScope.sellingLegalEntityId,
    predicate.commercialScope.channelId,
    predicate.commercialScope.marketId,
    predicate.currencyCode,
    basisReference,
    audienceReferences,
  ];
  return `pricing-contractual-discount-current-set:v1:${values.map(encodeURIComponent).join(':')}`;
};

export const PricingContractualDiscountSetAuthoritySchema = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  observedAt: PricingInstantSchema,
  ownerRevision: stableReference,
  ownerRootRef: stableReference,
  predicateRef: stableReference,
  verificationRef: stableReference,
  verifiedAt: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ observedAt, verifiedAt }) =>
    observedAt <= verifiedAt ? undefined : 'Discount-set verification cannot precede its observation instant',
  ),
);
export type PricingContractualDiscountSetAuthority = typeof PricingContractualDiscountSetAuthoritySchema.Type;

export const PricingContractualDiscountFactProofSchema = Schema.Struct({
  factRef: stableReference,
  factRevisionRef: stableReference,
  verificationRef: stableReference,
});
export type PricingContractualDiscountFactProof = typeof PricingContractualDiscountFactProofSchema.Type;

export const PricingContractualDiscountCurrentSetSchema = Schema.Struct({
  authority: PricingContractualDiscountSetAuthoritySchema,
  completenessEvidence: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  currentDiscounts: Schema.Array(ScheduledPricingDiscountRevisionSchema),
  factProofs: Schema.Array(PricingContractualDiscountFactProofSchema),
  predicate: PricingContractualDiscountSetPredicateSchema,
}).check(
  Schema.makeFilter(({ authority, completenessEvidence, currentDiscounts, factProofs, predicate }) => {
    const expectedPredicateRef = pricingContractualDiscountSetPredicateRef(predicate);
    if (
      predicate.effectiveAt > authority.observedAt ||
      authority.predicateRef !== expectedPredicateRef ||
      completenessEvidence.observedAt !== authority.observedAt ||
      completenessEvidence.ownerRevision !== authority.ownerRevision ||
      completenessEvidence.scope.kind !== 'EXACT_PREDICATE' ||
      completenessEvidence.scope.predicateRef !== expectedPredicateRef
    ) {
      return 'Contractual Discount authority and completeness must bind one exact Current-set predicate';
    }
    if (
      completenessEvidence.nextApplicabilityBoundary !== undefined &&
      authority.verifiedAt >= completenessEvidence.nextApplicabilityBoundary
    ) {
      return 'Contractual Discount set must be verified before its next applicability boundary';
    }
    const invalid = currentDiscounts.some(({ definition, effectivePeriod }) => {
      const key = definition.identityKey;
      return (
        key.family !== 'CONTRACTUAL_DISCOUNT' ||
        key.currencyCode !== predicate.currencyCode ||
        !sameCommercialScope(key.commercialScope, predicate.commercialScope) ||
        !sameBasis(key.basis, predicate.basis) ||
        !predicate.audiences.some((audience) => sameAudience(audience, key.audience)) ||
        effectivePeriod.effectiveFrom > predicate.effectiveAt ||
        (effectivePeriod.effectiveTo !== null && predicate.effectiveAt >= effectivePeriod.effectiveTo)
      );
    });
    if (invalid) {
      return 'Current contractual Discount set contains a non-matching or non-Current fact';
    }
    const duplicateFactProof = factProofs.some((proof, index) =>
      factProofs.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          ((candidate.factRef === proof.factRef && candidate.factRevisionRef === proof.factRevisionRef) ||
            candidate.verificationRef === proof.verificationRef),
      ),
    );
    if (
      factProofs.length !== currentDiscounts.length ||
      duplicateFactProof ||
      currentDiscounts.some(
        ({ definition }) =>
          !factProofs.some(
            ({ factRef, factRevisionRef }) =>
              factRef === definition.discountId && factRevisionRef === definition.revision.revisionId,
          ),
      )
    ) {
      return 'Current contractual Discount fact proofs must bind every Current Discount revision exactly once';
    }
    const duplicateLogicalKey = currentDiscounts.some(({ definition }, index) =>
      currentDiscounts.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          pricingDiscountIdentityKeysEqual(candidate.definition.identityKey, definition.identityKey),
      ),
    );
    return duplicateLogicalKey
      ? 'Current contractual Discount set cannot collapse duplicate Current logical-key claimants'
      : undefined;
  }),
);
export type PricingContractualDiscountCurrentSet = typeof PricingContractualDiscountCurrentSetSchema.Type;

export const PricingContractualDiscountResolvedProofSchema = Schema.Struct({
  authority: PricingContractualDiscountSetAuthoritySchema,
  currentFacts: Schema.Array(PricingContractualDiscountFactProofSchema),
  outcome: Schema.Literal('CONTRACTUAL_DISCOUNT_SET_PROOF_RESOLVED'),
  predicate: PricingContractualDiscountSetPredicateSchema,
}).check(
  Schema.makeFilter(({ authority, currentFacts, predicate }) => {
    const exactPredicateRef = pricingContractualDiscountSetPredicateRef(predicate);
    const factsAreDistinct = !currentFacts.some((fact, index) =>
      currentFacts.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          ((candidate.factRef === fact.factRef && candidate.factRevisionRef === fact.factRevisionRef) ||
            candidate.verificationRef === fact.verificationRef),
      ),
    );
    return predicate.effectiveAt <= authority.observedAt &&
      authority.predicateRef === exactPredicateRef &&
      factsAreDistinct
      ? undefined
      : 'Resolved contractual Discount proof must bind its exact original predicate and fact proofs';
  }),
);
export type PricingContractualDiscountResolvedProof = typeof PricingContractualDiscountResolvedProofSchema.Type;

export const PricingContractualDiscountSetGenerationVerificationSchema = Schema.Union([
  Schema.Struct({
    authority: PricingContractualDiscountSetAuthoritySchema,
    outcome: Schema.Literal('CONTRACTUAL_DISCOUNT_SET_GENERATION_CURRENT'),
    verifiedThrough: PricingInstantSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('CONTRACTUAL_DISCOUNT_SET_GENERATION_CHANGED'),
    verifiedThrough: PricingInstantSchema,
  }),
]);
export type PricingContractualDiscountSetGenerationVerification =
  typeof PricingContractualDiscountSetGenerationVerificationSchema.Type;
