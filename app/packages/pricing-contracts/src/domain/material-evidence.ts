import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import {
  CatalogQuantityBasisSchema,
  CatalogQuantityHandoffReadySchema,
} from '@app/catalog/domain/catalog-quantity-handoff';
import {
  PricingPurposeEquivalenceRequestSchema,
  PricingPurposeEquivalenceResponseSchema,
} from '@app/catalog/api/pricing-purpose-equivalence';
import {
  CatalogQuantityBasisCompatibleConversionSchema,
  CatalogQuantityBasisNoConversionRequiredSchema,
  QuantityBasisCompatibilityRequestSchema,
} from '@app/catalog/api/quantity-basis-compatibility';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Match, Schema } from 'effect';

import {
  CurrentSupportedCurrenciesSuccessSchema,
  PricingChannelIdSchema,
  PricingCurrencySubjectSchema,
  PricingMarketIdSchema,
  PricingSellingLegalEntityIdSchema,
  PricingTenantIdSchema,
} from '../apis/current-supported-currencies.ts';
import { PricingCommercialFeeCurrentSetSchema } from './commercial-fee.ts';
import {
  PricingContractualDiscountCurrentSetSchema,
  pricingContractualDiscountSetPredicateRef,
} from './contractual-discount-set.ts';
import { PricingZeroFloorAuthorizationQuerySchema } from './line-composition.ts';
import { PricingInstantSchema } from './currency-support.ts';
import {
  PricingDiscountAudienceEvidenceBindingSchema,
  PricingDiscountAudienceSchema,
  PricingDiscountIdentityBasisSchema,
  PricingDiscountIdentityKeySchema,
} from './discount.ts';
import { PricingAllocationResultSchema } from './discount-fee-allocation.ts';
import { PricingCommercialTotalReadySchema } from './commercial-total.ts';
import type { PricingCommercialTotalReady } from './commercial-total.ts';
import { ExactPriceLookupRequestSchema } from './exact-price-lookup.ts';
import {
  NonePriceGroupInterpretationSchema,
  PriceGroupAssignmentResolutionRequestSchema,
  PriceGroupAssignmentProfileSchema,
  PriceGroupAssignmentResolutionSchema,
  PriceGroupInterpretationInputSchema,
  PriceGroupInterpretationSchema,
} from './price-group-interpretation.ts';
import { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';
import {
  PricingAuthorizedZeroFloorGuardSchema,
  PricingCatalogSelectionSchema,
  PricingDecisionSchema,
  PricingLineSchema,
  PricingPurchaseDemandOccurrenceIdSchema,
  PricingUnitBasisSchema,
} from './pricing-decision.ts';
import type { PricingDecision } from './pricing-decision.ts';
import {
  PricingPromotionApplicationSchema,
  PricingPromotionCompositionCurrentnessSchema,
} from './promotion-composition.ts';
import { QuantityTierSelectionInputSchema } from './quantity-tier.ts';
import {
  PricingSourceEvidenceResultSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
  PricingSourceEvidenceVerifiedPresentSchema,
} from './source-revision-evidence.ts';
import type { PricingSourceEvidenceResult, PricingSourceEvidenceVerifiedPresent } from './source-revision-evidence.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const CATALOG_OWNER_MODULE_ID = 'commerce.catalog';
const CUSTOMER_CONTEXT_OWNER_MODULE_ID = 'commerce.customer-context';
const PRICING_OWNER_MODULE_ID = 'commerce.pricing';
const samePricingDecision = Schema.toEquivalence(PricingDecisionSchema);
const samePricingSubject = Schema.toEquivalence(PricingCurrencySubjectSchema);
const sameInterpretationInput = Schema.toEquivalence(PriceGroupInterpretationInputSchema);

const PricingCustomerContextSubjectAuthorityEvidenceSchema = Schema.Union([
  Schema.Struct({
    actorPrincipalId: PrincipalIdSchema,
    kind: Schema.Literal('PROFILE'),
    partyAuthorityRef: stableReference,
    partyAuthorityRevisionRef: stableReference,
    subject: PricingCurrencySubjectSchema,
    subjectAuthorityRef: stableReference,
    subjectAuthorityRevisionRef: stableReference,
  }).check(
    Schema.makeFilter(({ subject }) =>
      subject.kind === 'PROFILE' ? undefined : 'Profile subject proof must bind a Profile subject',
    ),
  ),
  Schema.Struct({
    guestEvidenceAuthorityRef: stableReference,
    guestSessionAuthorityRef: stableReference,
    kind: Schema.Literal('GUEST'),
    subject: PricingCurrencySubjectSchema,
    subjectAuthorityRevisionRef: stableReference,
  }).check(
    Schema.makeFilter(({ subject }) =>
      subject.kind === 'GUEST' ? undefined : 'Guest subject proof must bind a Guest subject',
    ),
  ),
]);

/**
 * Lossless structural image of the Commerce Customer Context proof consumed by Pricing. Keeping
 * the image here avoids a circular package dependency; Commerce remains the only issuer.
 */
export const PricingDiscountSubjectEvidenceSchema = Schema.Struct({
  currentness: Schema.Struct({
    evaluatedAt: PricingInstantSchema,
    observedAt: PricingInstantSchema,
    validFrom: PricingInstantSchema,
    validTo: Schema.NullOr(PricingInstantSchema),
  }),
  ownerRef: stableReference,
  ownerRevisionRef: stableReference,
  subjectAuthority: PricingCustomerContextSubjectAuthorityEvidenceSchema,
  verificationRef: stableReference,
}).check(
  Schema.makeFilter(({ currentness }) =>
    currentness.validFrom <= currentness.evaluatedAt &&
    (currentness.validTo === null || currentness.evaluatedAt < currentness.validTo) &&
    currentness.evaluatedAt <= currentness.observedAt
      ? undefined
      : 'Discount subject proof must be Current at its exact CCC evaluation instant',
  ),
);
export type PricingDiscountSubjectEvidence = typeof PricingDiscountSubjectEvidenceSchema.Type;

const PricingDiscountProfileNoneInterpretationSchema = Schema.Struct({
  input: PriceGroupInterpretationInputSchema,
  interpretation: NonePriceGroupInterpretationSchema,
}).check(
  Schema.makeFilter(({ input, interpretation }) =>
    sameInterpretationInput(input, {
      assignmentRequest: input.assignmentRequest,
      basis: interpretation.basis,
    })
      ? undefined
      : 'Discount non-selection must retain the exact owner NONE interpretation input',
  ),
);

const subjectProfileMatchesInterpretation = (
  subject: Extract<typeof PricingCurrencySubjectSchema.Type, { readonly kind: 'PROFILE' }>,
  input: typeof PriceGroupInterpretationInputSchema.Type,
): boolean => {
  const assignment = input.assignmentRequest;
  if (!Schema.is(PriceGroupAssignmentResolutionRequestSchema)(assignment)) {
    return false;
  }
  return (
    assignment.profile.kind === subject.authorizationSubject.kind &&
    assignment.profile.moduleId === subject.profileRef.moduleId &&
    assignment.profile.resourceId === subject.profileRef.resourceId &&
    assignment.profile.resourceType === subject.profileRef.resourceType &&
    assignment.profile.tenantId === subject.profileRef.tenantId
  );
};

/**
 * A non-selection is an audience decision backed by CCC subject authority. It is deliberately not
 * encoded as an empty Discount owner predicate or as owner-proven absence of Discount facts.
 */
export const PricingMaterialDiscountSelectionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('DISCOUNT_SELECTED'),
    sourceEvidence: PricingSourceEvidenceResultSchema,
  }),
  Schema.Struct({
    audienceDecision: Schema.Union([
      Schema.Struct({ kind: Schema.Literal('GUEST') }),
      Schema.Struct({
        interpretations: Schema.Array(PricingDiscountProfileNoneInterpretationSchema).check(Schema.isMinLength(1)),
        kind: Schema.Literal('PROFILE_OWNER_NONE'),
      }),
    ]),
    kind: Schema.Literal('DISCOUNT_NOT_SELECTED_NO_ELIGIBLE_AUDIENCE'),
    subjectEvidence: PricingDiscountSubjectEvidenceSchema,
  }).check(
    Schema.makeFilter(({ audienceDecision, subjectEvidence }) => {
      const { subjectAuthority } = subjectEvidence;
      if (audienceDecision.kind === 'GUEST') {
        return subjectAuthority.kind === 'GUEST'
          ? undefined
          : 'Guest Discount non-selection requires exact Guest CCC subject proof';
      }
      if (subjectAuthority.kind !== 'PROFILE') {
        return 'Profile Discount non-selection requires exact Profile CCC subject proof';
      }
      const { subject } = subjectAuthority;
      return subject.kind === 'PROFILE' &&
        audienceDecision.interpretations.every(({ input }) => subjectProfileMatchesInterpretation(subject, input))
        ? undefined
        : 'Profile Discount non-selection must bind every owner NONE interpretation to the exact CCC subject';
    }),
  ),
]);
export type PricingMaterialDiscountSelection = typeof PricingMaterialDiscountSelectionSchema.Type;

/**
 * Launch Price Group authority is line-scoped only. A Retail Profile with an assigned Price Group
 * therefore has no legal WHOLE_PURCHASE owner predicate to read; this is scope ineligibility, not
 * owner-proven absence and not a claim that the Profile has no eligible line audience.
 */
export const PricingMaterialWholePurchaseScopeIneligibleSchema = Schema.Struct({
  audienceKind: Schema.Literal('PRICE_GROUP'),
  kind: Schema.Literal('DISCOUNT_NOT_SELECTED_SCOPE_INELIGIBLE'),
  reason: Schema.Literal('PRICE_GROUP_LINE_SCOPE_ONLY'),
  scope: Schema.Literal('WHOLE_PURCHASE'),
  subjectEvidence: PricingDiscountSubjectEvidenceSchema,
}).check(
  Schema.makeFilter(({ subjectEvidence }) => {
    const { subjectAuthority } = subjectEvidence;
    return subjectAuthority.kind === 'PROFILE' &&
      subjectAuthority.subject.kind === 'PROFILE' &&
      subjectAuthority.subject.authorizationSubject.kind === 'RETAIL'
      ? undefined
      : 'Price Group whole-purchase scope ineligibility requires exact Retail Profile authority';
  }),
);
export type PricingMaterialWholePurchaseScopeIneligible = typeof PricingMaterialWholePurchaseScopeIneligibleSchema.Type;

export const PricingMaterialWholePurchaseDiscountSelectionSchema = Schema.Union([
  PricingMaterialDiscountSelectionSchema,
  PricingMaterialWholePurchaseScopeIneligibleSchema,
]);
export type PricingMaterialWholePurchaseDiscountSelection =
  typeof PricingMaterialWholePurchaseDiscountSelectionSchema.Type;

export const PricingMaterialPricePathEvidenceSchema = Schema.Struct({
  assignedGroupAbsence: Schema.optionalKey(PricingSourceEvidenceResultSchema),
  usedPrice: PricingSourceEvidenceResultSchema,
});
export type PricingMaterialPricePathEvidence = typeof PricingMaterialPricePathEvidenceSchema.Type;

export const PricingMaterialLineEvidenceSchema = Schema.Struct({
  commercialFees: PricingSourceEvidenceResultSchema,
  lineDiscounts: PricingMaterialDiscountSelectionSchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  pricePath: PricingMaterialPricePathEvidenceSchema,
  quantityTiers: PricingSourceEvidenceResultSchema,
  zeroFloor: Schema.optionalKey(PricingSourceEvidenceResultSchema),
});
export type PricingMaterialLineEvidence = typeof PricingMaterialLineEvidenceSchema.Type;

export const PricingMaterialWholePurchaseEvidenceSchema = Schema.Struct({
  allocationAssessment: Schema.optionalKey(Schema.toType(PricingAllocationResultSchema)),
  contractualDiscounts: PricingMaterialWholePurchaseDiscountSelectionSchema,
});
export type PricingMaterialWholePurchaseEvidence = typeof PricingMaterialWholePurchaseEvidenceSchema.Type;

export const PricingRetainedCatalogOwnerEvidenceSchema = Schema.Struct({
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  sourceEvidence: PricingSourceEvidenceResultSchema,
});
export type PricingRetainedCatalogOwnerEvidence = typeof PricingRetainedCatalogOwnerEvidenceSchema.Type;

/**
 * Promotion is material only after this Pricing attempt explicitly selected a Promotion
 * application. `PROMOTION_NOT_SELECTED` makes no claim about campaign applicability, owner
 * deployment, or a zero contribution; it records only that Promotion was outside this attempt.
 */
export const PricingRetainedPromotionEvidenceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('PROMOTION_NOT_SELECTED') }),
  Schema.Struct({
    kind: Schema.Literal('PROMOTION_SELECTED'),
    sourceEvidence: PricingSourceEvidenceResultSchema,
  }),
]);
export type PricingRetainedPromotionEvidence = typeof PricingRetainedPromotionEvidenceSchema.Type;

export interface PricingRetainedExternalOwnerEvidence {
  readonly candidateRef: string;
  readonly catalogSelections: readonly PricingRetainedCatalogOwnerEvidence[];
  readonly decision: PricingDecision;
  readonly market: PricingSourceEvidenceResult;
  readonly priceGroupAssignment?: PricingSourceEvidenceResult;
  readonly promotion: PricingRetainedPromotionEvidence;
  readonly requestedAt: typeof PricingInstantSchema.Type;
  readonly subject: typeof PricingCurrencySubjectSchema.Type;
  readonly validatedAt: typeof PricingInstantSchema.Type;
}

const verifiedOwnerEvidenceIsCurrent = (
  source: PricingSourceEvidenceResult,
  expectedOwnerModuleId: string,
  expectedFamily: 'COMMERCIAL_CONTEXT' | 'PROMOTION',
  decision: PricingDecision,
  requestedAt: typeof PricingInstantSchema.Type,
  validatedAt: typeof PricingInstantSchema.Type,
  allowAbsence: boolean,
): boolean => {
  if (
    source.request.ownerScope.ownerModuleId !== expectedOwnerModuleId ||
    source.request.ownerScope.tenantId !== decision.tenantId ||
    source.request.family !== expectedFamily ||
    source.request.effectiveAt !== decision.operationTime ||
    source.request.requestedAt !== requestedAt ||
    (!Schema.is(PricingSourceEvidenceVerifiedPresentSchema)(source) &&
      (!allowAbsence || !Schema.is(PricingSourceEvidenceVerifiedAbsentSchema)(source)))
  ) {
    return false;
  }
  const { temporal } = source.completeness;
  return (
    temporal.observedAt <= validatedAt &&
    (temporal.nextMaterialBoundary === undefined || validatedAt < temporal.nextMaterialBoundary)
  );
};

export const PricingRetainedExternalOwnerEvidenceSchema: Schema.Codec<PricingRetainedExternalOwnerEvidence, unknown> =
  Schema.Struct({
    candidateRef: stableReference,
    catalogSelections: Schema.Array(PricingRetainedCatalogOwnerEvidenceSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(500),
    ),
    decision: PricingDecisionSchema,
    market: PricingSourceEvidenceResultSchema,
    priceGroupAssignment: Schema.optionalKey(PricingSourceEvidenceResultSchema),
    promotion: PricingRetainedPromotionEvidenceSchema,
    requestedAt: PricingInstantSchema,
    subject: PricingCurrencySubjectSchema,
    validatedAt: PricingInstantSchema,
  }).check(
    Schema.makeFilter((bundle) => {
      if (bundle.requestedAt > bundle.validatedAt) {
        return 'External owner evidence cannot be validated before it was requested';
      }
      if (bundle.subject.kind === 'PROFILE' && bundle.subject.profileRef.tenantId !== bundle.decision.tenantId) {
        return 'External owner evidence subject must belong to the exact Pricing Tenant';
      }
      const expectedOccurrences = bundle.decision.lines.map(({ occurrenceId }) => occurrenceId);
      const retainedOccurrences = bundle.catalogSelections.map(({ occurrenceId }) => occurrenceId);
      if (
        expectedOccurrences.length !== retainedOccurrences.length ||
        !expectedOccurrences.every((occurrenceId, index) => retainedOccurrences[index] === occurrenceId)
      ) {
        return 'Catalog owner evidence must preserve the exact ordered Pricing candidate';
      }
      if (
        (bundle.subject.kind === 'PROFILE' && bundle.priceGroupAssignment === undefined) ||
        (bundle.subject.kind === 'GUEST' && bundle.priceGroupAssignment !== undefined)
      ) {
        return 'Only Profile subjects retain Customer Context Price Group assignment evidence';
      }
      return !bundle.catalogSelections.every(({ sourceEvidence }) =>
        verifiedOwnerEvidenceIsCurrent(
          sourceEvidence,
          CATALOG_OWNER_MODULE_ID,
          'COMMERCIAL_CONTEXT',
          bundle.decision,
          bundle.requestedAt,
          bundle.validatedAt,
          false,
        ),
      ) ||
        !verifiedOwnerEvidenceIsCurrent(
          bundle.market,
          'commerce.market-catalog',
          'COMMERCIAL_CONTEXT',
          bundle.decision,
          bundle.requestedAt,
          bundle.validatedAt,
          false,
        ) ||
        (bundle.priceGroupAssignment !== undefined &&
          !verifiedOwnerEvidenceIsCurrent(
            bundle.priceGroupAssignment,
            CUSTOMER_CONTEXT_OWNER_MODULE_ID,
            'COMMERCIAL_CONTEXT',
            bundle.decision,
            bundle.requestedAt,
            bundle.validatedAt,
            true,
          )) ||
        (bundle.promotion.kind === 'PROMOTION_SELECTED' &&
          !verifiedOwnerEvidenceIsCurrent(
            bundle.promotion.sourceEvidence,
            'commerce.promotion',
            'PROMOTION',
            bundle.decision,
            bundle.requestedAt,
            bundle.validatedAt,
            true,
          ))
        ? 'External owner evidence must retain Current owner-verifiable proof for the exact candidate context'
        : undefined;
    }),
  );

const verifiedSourceEvidenceSchema = Schema.Union([
  PricingSourceEvidenceVerifiedPresentSchema,
  PricingSourceEvidenceVerifiedAbsentSchema,
]);

const PricingOwnerFactProofSchema = Schema.Struct({
  factRef: stableReference,
  factRevisionRef: stableReference,
  verificationRef: stableReference,
});
export type PricingOwnerFactProof = typeof PricingOwnerFactProofSchema.Type;

const PricingPersistentOwnerSetAuthoritySchema = Schema.Struct({
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  nextApplicabilityBoundary: Schema.optionalKey(PricingInstantSchema),
  observedAt: PricingInstantSchema,
  ownerRevision: stableReference,
  ownerRootRef: stableReference,
  predicateRef: stableReference,
  verificationRef: stableReference,
});

const PricingExactPriceOwnerSetAuthoritySchema = Schema.Struct({
  ...PricingPersistentOwnerSetAuthoritySchema.fields,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  kind: Schema.Literals(['PERSISTENT', 'VIRTUAL_EMPTY']),
}).check(
  Schema.makeFilter(({ generation, kind }) =>
    (kind === 'PERSISTENT' && generation > 0) || (kind === 'VIRTUAL_EMPTY' && generation === 0)
      ? undefined
      : 'Exact Price authority kind must preserve its owner-issued generation class',
  ),
);

export const PricingExactPriceOwnerReadReceiptSchema = Schema.Struct({
  authority: PricingExactPriceOwnerSetAuthoritySchema,
  factProofs: Schema.Array(PricingOwnerFactProofSchema).check(Schema.isMaxLength(500)),
});
export type PricingExactPriceOwnerReadReceipt = typeof PricingExactPriceOwnerReadReceiptSchema.Type;

export const PricingTierOwnerReadReceiptSchema = Schema.Struct({
  authority: PricingPersistentOwnerSetAuthoritySchema,
  factProofs: Schema.Array(PricingOwnerFactProofSchema).check(Schema.isMaxLength(500)),
});
export type PricingTierOwnerReadReceipt = typeof PricingTierOwnerReadReceiptSchema.Type;

export const PricingCommercialFeeOwnerReadReceiptSchema = Schema.Struct({
  authority: PricingPersistentOwnerSetAuthoritySchema,
  factProofs: Schema.Array(PricingOwnerFactProofSchema).check(Schema.isMaxLength(500)),
});
export type PricingCommercialFeeOwnerReadReceipt = typeof PricingCommercialFeeOwnerReadReceiptSchema.Type;

export const PricingZeroFloorOwnerReadReceiptSchema = Schema.Struct({
  authority: PricingPersistentOwnerSetAuthoritySchema,
  factProofs: Schema.Array(PricingOwnerFactProofSchema).check(Schema.isMaxLength(500)),
});
export type PricingZeroFloorOwnerReadReceipt = typeof PricingZeroFloorOwnerReadReceiptSchema.Type;

/** Owner-issued replay receipt retained for external owner final-fence reads. */
const PricingPriceFenceAuthoritySchema = Schema.Struct({
  kind: Schema.Literal('PRICING_PRICE_AUTHORITY'),
  lookupRequest: ExactPriceLookupRequestSchema,
  ownerReadReceipt: PricingExactPriceOwnerReadReceiptSchema,
});

const PricingQuantityTierFenceAuthoritySchema = Schema.Struct({
  kind: Schema.Literal('PRICING_QUANTITY_TIER_AUTHORITY'),
  ownerReadReceipt: PricingTierOwnerReadReceiptSchema,
  selectionInput: QuantityTierSelectionInputSchema,
});

export const PricingDiscountOwnerReadReceiptSchema = Schema.Struct({
  authority: PricingContractualDiscountCurrentSetSchema.fields.authority,
  completenessEvidence: PricingContractualDiscountCurrentSetSchema.fields.completenessEvidence,
  factProofs: PricingContractualDiscountCurrentSetSchema.fields.factProofs,
  predicate: PricingContractualDiscountCurrentSetSchema.fields.predicate,
}).check(
  Schema.makeFilter(({ authority, completenessEvidence, predicate }) => {
    const predicateRef = pricingContractualDiscountSetPredicateRef(predicate);
    return authority.predicateRef === predicateRef &&
      completenessEvidence.observedAt === authority.observedAt &&
      completenessEvidence.ownerRevision === authority.ownerRevision &&
      completenessEvidence.scope.kind === 'EXACT_PREDICATE' &&
      completenessEvidence.scope.predicateRef === predicateRef &&
      (completenessEvidence.nextApplicabilityBoundary === undefined ||
        authority.verifiedAt < completenessEvidence.nextApplicabilityBoundary)
      ? undefined
      : 'Discount owner receipt must retain one exact owner Current-set predicate and generation';
  }),
);
export type PricingDiscountOwnerReadReceipt = typeof PricingDiscountOwnerReadReceiptSchema.Type;

const PricingDiscountFenceAuthoritySchema = Schema.Struct({
  applicabilityBindings: Schema.Array(PricingDiscountAudienceEvidenceBindingSchema).check(Schema.isMaxLength(500)),
  identityKeys: Schema.Array(PricingDiscountIdentityKeySchema).check(Schema.isMaxLength(500)),
  kind: Schema.Literal('PRICING_DISCOUNT_AUTHORITY'),
  ownerReadReceipt: PricingDiscountOwnerReadReceiptSchema,
}).check(
  Schema.makeFilter(({ identityKeys, ownerReadReceipt }) =>
    identityKeys.length === ownerReadReceipt.factProofs.length
      ? undefined
      : 'Discount material must retain one exact identity per owner-proven Current fact',
  ),
);

const PricingCommercialFeeFenceAuthoritySchema = Schema.Struct({
  currentSet: PricingCommercialFeeCurrentSetSchema,
  kind: Schema.Literal('PRICING_COMMERCIAL_FEE_AUTHORITY'),
  ownerReadReceipt: PricingCommercialFeeOwnerReadReceiptSchema,
});

const PricingZeroFloorFenceAuthoritySchema = Schema.Struct({
  appliedGuard: Schema.optionalKey(PricingAuthorizedZeroFloorGuardSchema),
  kind: Schema.Literal('PRICING_ZERO_FLOOR_AUTHORITY'),
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  ownerReadReceipt: PricingZeroFloorOwnerReadReceiptSchema,
  query: PricingZeroFloorAuthorizationQuerySchema,
});

const PricingCurrencySupportFenceAuthoritySchema = Schema.Struct({
  kind: Schema.Literal('PRICING_CURRENCY_SUPPORT_AUTHORITY'),
  support: CurrentSupportedCurrenciesSuccessSchema,
});

const PricingCatalogLineFenceAuthoritySchema = Schema.Struct({
  compatibilityRequest: QuantityBasisCompatibilityRequestSchema,
  compatibilityResponse: Schema.Union([
    CatalogQuantityBasisNoConversionRequiredSchema,
    CatalogQuantityBasisCompatibleConversionSchema,
  ]),
  handoff: CatalogQuantityHandoffReadySchema,
  kind: Schema.Literal('CATALOG_LINE_AUTHORITY'),
  line: PricingLineSchema,
  request: Schema.Struct({
    amount: Schema.String.check(Schema.isMaxLength(1000)),
    purpose: Schema.Literal('PRICING'),
    selection: PricingCatalogSelectionSchema,
  }),
});

const PricingCatalogCompatibilityReplayEvidenceSchema = Schema.Struct({
  currentnessEvidence: Schema.Struct({ revalidatedAt: PricingInstantSchema }),
  requestedQuantity: CatalogQuantityHandoffReadySchema.fields.quantity.fields.requested,
  requestedQuantityBasis: CatalogQuantityBasisSchema,
  requestedUnitRef: CatalogQuantityHandoffReadySchema.fields.unitRef,
  verificationReceipt: Schema.Struct({
    predicate: Schema.Struct({
      effectiveAt: PricingInstantSchema,
      price: QuantityBasisCompatibilityRequestSchema.fields.price,
      selection: PricingCatalogSelectionSchema,
      tier: QuantityBasisCompatibilityRequestSchema.fields.tier,
    }),
  }),
});

const PricingCatalogEquivalenceFenceAuthoritySchema = Schema.Struct({
  kind: Schema.Literal('CATALOG_EQUIVALENCE_AUTHORITY'),
  request: PricingPurposeEquivalenceRequestSchema,
  response: PricingPurposeEquivalenceResponseSchema,
});

export const PricingMarketSourceReceiptSchema = Schema.Union([
  Schema.Struct({
    authority: Schema.Struct({
      generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      nextApplicabilityBoundary: Schema.optionalKey(PricingInstantSchema),
      observedAt: PricingInstantSchema,
      ownerRootRef: stableReference,
      ownerSetRevisionRef: stableReference,
      predicateRef: stableReference,
      verificationRef: stableReference,
    }),
    currentFacts: Schema.Tuple([
      Schema.Struct({
        effectivePeriod: Schema.Struct({
          endsAt: Schema.optionalKey(PricingInstantSchema),
          startsAt: PricingInstantSchema,
        }),
        factRef: stableReference,
        factRevisionRef: stableReference,
        verificationRef: stableReference,
      }),
    ]),
    state: Schema.Literal('PRESENT'),
  }),
  Schema.Struct({
    authority: Schema.Struct({
      generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      nextApplicabilityBoundary: Schema.optionalKey(PricingInstantSchema),
      observedAt: PricingInstantSchema,
      ownerRootRef: stableReference,
      ownerSetRevisionRef: stableReference,
      predicateRef: stableReference,
      verificationRef: stableReference,
    }),
    currentFacts: Schema.Tuple([]),
    state: Schema.Literal('ABSENT'),
  }),
]);
export type PricingMarketSourceReceipt = typeof PricingMarketSourceReceiptSchema.Type;

const PricingMarketContextFenceAuthoritySchema = Schema.Struct({
  commercialScope: PricingCommercialScopeSchema,
  kind: Schema.Literal('MARKET_CONTEXT_AUTHORITY'),
  receipt: PricingMarketSourceReceiptSchema,
});

const PricingPurchaseContextActorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('AUTHENTICATED_CUSTOMER'), principalId: PrincipalIdSchema }),
  Schema.Struct({ kind: Schema.Literal('GUEST') }),
]);

const PricingPurchaseContextVerificationRequestSchema = Schema.Struct({
  actor: PricingPurchaseContextActorSchema,
  operationTime: PricingInstantSchema,
  purchasingContext: Schema.Struct({
    channelId: PricingChannelIdSchema,
    contextRef: stableReference,
    contextRevision: stableReference,
    marketId: PricingMarketIdSchema,
    sellingLegalEntityId: PricingSellingLegalEntityIdSchema,
  }),
  subject: PricingCurrencySubjectSchema,
  tenantId: PricingTenantIdSchema,
}).check(
  Schema.makeFilter(({ actor, subject, tenantId }) => {
    if (subject.kind === 'PROFILE' && subject.profileRef.tenantId !== tenantId) {
      return 'Purchase Context Profile subject must belong to the exact Tenant';
    }
    return (actor.kind === 'AUTHENTICATED_CUSTOMER' && subject.kind === 'PROFILE') ||
      (actor.kind === 'GUEST' && subject.kind === 'GUEST')
      ? undefined
      : 'Purchase Context actor and subject must preserve the exact authority class';
  }),
);

const PricingPurchaseContextVerificationEvidenceSchema = Schema.Struct({
  currentness: Schema.Struct({
    evaluatedAt: PricingInstantSchema,
    observedAt: PricingInstantSchema,
    validFrom: PricingInstantSchema,
    validTo: Schema.NullOr(PricingInstantSchema),
  }),
  ownerRef: stableReference,
  ownerRevisionRef: stableReference,
  subjectAuthority: PricingCustomerContextSubjectAuthorityEvidenceSchema,
  verificationRef: stableReference,
  verifiedScope: Schema.Struct({
    channelId: PricingChannelIdSchema,
    legalEntityId: PricingSellingLegalEntityIdSchema,
    marketId: PricingMarketIdSchema,
    tenantId: PricingTenantIdSchema,
  }),
}).check(
  Schema.makeFilter(({ currentness }) =>
    currentness.validFrom <= currentness.evaluatedAt &&
    currentness.evaluatedAt <= currentness.observedAt &&
    (currentness.validTo === null || currentness.evaluatedAt < currentness.validTo)
      ? undefined
      : 'Purchase Context singleton proof must be Current at its exact evaluation instant',
  ),
);

const PricingCustomerContextPurchaseFenceAuthoritySchema = Schema.Struct({
  evidence: PricingPurchaseContextVerificationEvidenceSchema,
  kind: Schema.Literal('CUSTOMER_CONTEXT_PURCHASE_AUTHORITY'),
  request: PricingPurchaseContextVerificationRequestSchema,
});

const PricingCustomerPriceGroupResolutionResponseSchema = Schema.Struct({
  completenessEvidence: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  currentnessEvidence: Schema.Struct({
    evaluatedAt: PricingInstantSchema,
    generation: stableReference,
    observedAt: PricingInstantSchema,
    ownerRevision: stableReference,
    predicateRef: stableReference,
    revalidatedAt: PricingInstantSchema,
    verificationMode: Schema.Literal('OWNER_CURRENT_SET_REVALIDATED'),
  }),
  effectiveAt: PricingInstantSchema,
  generation: stableReference,
  observedAt: PricingInstantSchema,
  profile: PriceGroupAssignmentProfileSchema,
  resolution: PriceGroupAssignmentResolutionSchema,
  verificationReceipt: Schema.Struct({
    generation: stableReference,
    issuedAt: PricingInstantSchema,
    ownerModuleId: Schema.Literal(CUSTOMER_CONTEXT_OWNER_MODULE_ID),
    ownerRevision: stableReference,
    predicateRef: stableReference,
    verificationRef: stableReference,
  }),
}).check(
  Schema.makeFilter(({ completenessEvidence, currentnessEvidence, generation, observedAt, verificationReceipt }) =>
    completenessEvidence.observedAt === observedAt &&
    currentnessEvidence.observedAt === observedAt &&
    completenessEvidence.ownerRevision === currentnessEvidence.ownerRevision &&
    completenessEvidence.ownerRevision === verificationReceipt.ownerRevision &&
    generation === currentnessEvidence.generation &&
    generation === verificationReceipt.generation &&
    completenessEvidence.scope.predicateRef === currentnessEvidence.predicateRef &&
    completenessEvidence.scope.predicateRef === verificationReceipt.predicateRef
      ? undefined
      : 'Customer Context Price Group replay must retain one exact owner generation and predicate',
  ),
);

const PricingCustomerContextGroupFenceAuthoritySchema = Schema.Struct({
  input: PriceGroupInterpretationInputSchema,
  interpretation: PriceGroupInterpretationSchema,
  kind: Schema.Literal('CUSTOMER_CONTEXT_GROUP_AUTHORITY'),
  request: PriceGroupAssignmentResolutionRequestSchema,
  response: PricingCustomerPriceGroupResolutionResponseSchema,
});

const PricingPromotionApplicabilityFenceAuthoritySchema = Schema.Struct({
  application: PricingPromotionApplicationSchema,
  currentness: PricingPromotionCompositionCurrentnessSchema,
  kind: Schema.Literal('PROMOTION_APPLICABILITY_AUTHORITY'),
});

/**
 * Owner-native material required to resolve the opaque proof and repeat the exact Current read.
 * This union is an internal gateway contract and is intentionally absent from customer projections.
 */
export const PricingMaterialEvidenceFenceVerificationMaterialSchema = Schema.Union([
  PricingPriceFenceAuthoritySchema,
  PricingQuantityTierFenceAuthoritySchema,
  PricingDiscountFenceAuthoritySchema,
  PricingCommercialFeeFenceAuthoritySchema,
  PricingZeroFloorFenceAuthoritySchema,
  PricingCurrencySupportFenceAuthoritySchema,
  PricingCatalogLineFenceAuthoritySchema,
  PricingCatalogEquivalenceFenceAuthoritySchema,
  PricingMarketContextFenceAuthoritySchema,
  PricingCustomerContextPurchaseFenceAuthoritySchema,
  PricingCustomerContextGroupFenceAuthoritySchema,
  PricingPromotionApplicabilityFenceAuthoritySchema,
]);
export type PricingMaterialEvidenceFenceVerificationMaterial =
  typeof PricingMaterialEvidenceFenceVerificationMaterialSchema.Type;

const PricingSetBackedMaterialEvidenceFenceVerificationMaterialSchema = Schema.Union([
  PricingPriceFenceAuthoritySchema,
  PricingQuantityTierFenceAuthoritySchema,
  PricingDiscountFenceAuthoritySchema,
  PricingCommercialFeeFenceAuthoritySchema,
  PricingZeroFloorFenceAuthoritySchema,
  PricingCurrencySupportFenceAuthoritySchema,
  PricingCatalogLineFenceAuthoritySchema,
  PricingCatalogEquivalenceFenceAuthoritySchema,
  PricingMarketContextFenceAuthoritySchema,
  PricingCustomerContextGroupFenceAuthoritySchema,
  PricingPromotionApplicabilityFenceAuthoritySchema,
]);

export const PricingSetBackedMaterialEvidenceFenceSourceSchema = Schema.Struct({
  sourceEvidence: verifiedSourceEvidenceSchema,
  verificationMaterial: PricingSetBackedMaterialEvidenceFenceVerificationMaterialSchema,
});

/** CCC verifies this exact purchase/subject authority as one singleton, not as an owner set. */
export const PricingCustomerContextPurchaseFenceSourceSchema = Schema.Struct({
  verificationMaterial: PricingCustomerContextPurchaseFenceAuthoritySchema,
});
export type PricingCustomerContextPurchaseFenceSource = typeof PricingCustomerContextPurchaseFenceSourceSchema.Type;

export const PricingMaterialEvidenceFenceSourceSchema = Schema.Union([
  PricingSetBackedMaterialEvidenceFenceSourceSchema,
  PricingCustomerContextPurchaseFenceSourceSchema,
]);
export type PricingMaterialEvidenceFenceSource = typeof PricingMaterialEvidenceFenceSourceSchema.Type;

const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameCatalogHandoff = Schema.toEquivalence(CatalogQuantityHandoffReadySchema);
const sameCatalogQuantityBasis = Schema.toEquivalence(CatalogQuantityBasisSchema);
const sameLine = Schema.toEquivalence(PricingLineSchema);
const sameSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);
const sameUnitBasis = Schema.toEquivalence(PricingUnitBasisSchema);
const sameDiscountAudience = Schema.toEquivalence(PricingDiscountAudienceSchema);
const sameDiscountBasis = Schema.toEquivalence(PricingDiscountIdentityBasisSchema);
const sameGroupRequest = Schema.toEquivalence(PriceGroupAssignmentResolutionRequestSchema);
const sameGroupResolution = Schema.toEquivalence(PriceGroupAssignmentResolutionSchema);

const expectedOwnerAndFamily = (
  material: typeof PricingSetBackedMaterialEvidenceFenceVerificationMaterialSchema.Type,
): readonly [ownerModuleId: string, family: string] =>
  Match.value(material).pipe(
    Match.discriminator('kind')('PRICING_PRICE_AUTHORITY', () => [PRICING_OWNER_MODULE_ID, 'PRICE'] as const),
    Match.discriminator('kind')(
      'PRICING_QUANTITY_TIER_AUTHORITY',
      () => [PRICING_OWNER_MODULE_ID, 'QUANTITY_TIER'] as const,
    ),
    Match.discriminator('kind')('PRICING_DISCOUNT_AUTHORITY', () => [PRICING_OWNER_MODULE_ID, 'DISCOUNT'] as const),
    Match.discriminator('kind')(
      'PRICING_COMMERCIAL_FEE_AUTHORITY',
      () => [PRICING_OWNER_MODULE_ID, 'COMMERCIAL_FEE'] as const,
    ),
    Match.discriminator('kind')('PRICING_ZERO_FLOOR_AUTHORITY', () => [PRICING_OWNER_MODULE_ID, 'ZERO_FLOOR'] as const),
    Match.discriminator('kind')(
      'PRICING_CURRENCY_SUPPORT_AUTHORITY',
      () => [PRICING_OWNER_MODULE_ID, 'CURRENCY_SUPPORT'] as const,
    ),
    Match.discriminator('kind')(
      'CATALOG_LINE_AUTHORITY',
      () => [CATALOG_OWNER_MODULE_ID, 'COMMERCIAL_CONTEXT'] as const,
    ),
    Match.discriminator('kind')(
      'CATALOG_EQUIVALENCE_AUTHORITY',
      () => [CATALOG_OWNER_MODULE_ID, 'COMMERCIAL_CONTEXT'] as const,
    ),
    Match.discriminator('kind')(
      'MARKET_CONTEXT_AUTHORITY',
      () => ['commerce.market-catalog', 'COMMERCIAL_CONTEXT'] as const,
    ),
    Match.discriminator('kind')(
      'CUSTOMER_CONTEXT_GROUP_AUTHORITY',
      () => [CUSTOMER_CONTEXT_OWNER_MODULE_ID, 'COMMERCIAL_CONTEXT'] as const,
    ),
    Match.discriminator('kind')(
      'PROMOTION_APPLICABILITY_AUTHORITY',
      () => ['commerce.promotion', 'PROMOTION'] as const,
    ),
    Match.exhaustive,
  );

const lineForOccurrence = (decision: PricingDecision, occurrenceId: string) =>
  decision.lines.find((line) => line.occurrenceId === occurrenceId);

const selectionBelongsToDecision = (decision: PricingDecision, selection: typeof PricingCatalogSelectionSchema.Type) =>
  decision.lines.some((line) => sameSelection(line.catalog.selection, selection));

const exactPriceBasisBelongsToDecision = (
  decision: PricingDecision,
  selection: typeof PricingCatalogSelectionSchema.Type,
  unitBasis: typeof PricingUnitBasisSchema.Type,
) =>
  decision.lines.some(
    (line) => sameSelection(line.catalog.selection, selection) && sameUnitBasis(line.pricingBasis, unitBasis),
  );

const sameCatalogResourceRef = (
  left: (typeof CatalogQuantityBasisSchema.Type)['unitRef'],
  right: (typeof CatalogQuantityBasisSchema.Type)['unitRef'],
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameCompatibilityEndpoint = (
  left: (typeof QuantityBasisCompatibilityRequestSchema.Type)['price'],
  right: (typeof QuantityBasisCompatibilityRequestSchema.Type)['price'],
): boolean => left.quantity === right.quantity && sameCatalogQuantityBasis(left.quantityBasis, right.quantityBasis);

const catalogCompatibilityBindsLine = (
  line: typeof PricingLineSchema.Type,
  handoff: typeof CatalogQuantityHandoffReadySchema.Type,
  evaluatedAt: typeof PricingInstantSchema.Type,
  request: typeof QuantityBasisCompatibilityRequestSchema.Type,
  response:
    | typeof CatalogQuantityBasisNoConversionRequiredSchema.Type
    | typeof CatalogQuantityBasisCompatibleConversionSchema.Type,
): boolean => {
  if (
    !Schema.is(PricingCatalogCompatibilityReplayEvidenceSchema)(response) ||
    !sameCatalogHandoff(request.handoff, handoff) ||
    request.price.quantity !== line.pricingBasis.quantity ||
    !sameCatalogResourceRef(request.price.quantityBasis.unitRef, line.pricingBasis.unitRef) ||
    response.currentnessEvidence.revalidatedAt > evaluatedAt ||
    response.effectiveAt !== request.effectiveAt ||
    response.requestedQuantity !== handoff.quantity.requested ||
    !sameCatalogQuantityBasis(response.requestedQuantityBasis, handoff.quantityBasis) ||
    !sameCatalogResourceRef(response.requestedUnitRef, handoff.unitRef)
  ) {
    return false;
  }
  const { predicate } = response.verificationReceipt;
  return (
    predicate.effectiveAt === request.effectiveAt &&
    sameSelection(predicate.selection, handoff.selection) &&
    sameCompatibilityEndpoint(predicate.price, request.price) &&
    ((predicate.tier === undefined && request.tier === undefined) ||
      (predicate.tier !== undefined &&
        request.tier !== undefined &&
        sameCompatibilityEndpoint(predicate.tier, request.tier)))
  );
};

const discountOwnerReceiptBindsDecision = (
  decision: PricingDecision,
  effectiveAt: typeof PricingInstantSchema.Type,
  evaluatedAt: typeof PricingInstantSchema.Type,
  identityKeys: readonly (typeof PricingDiscountIdentityKeySchema.Type)[],
  receipt: PricingDiscountOwnerReadReceipt,
): boolean => {
  const { authority, completenessEvidence, predicate } = receipt;
  if (
    predicate.tenantId !== decision.tenantId ||
    predicate.effectiveAt !== effectiveAt ||
    predicate.currencyCode !== decision.currencyCode ||
    !sameCommercialScope(predicate.commercialScope, decision.commercialScope) ||
    authority.observedAt > evaluatedAt ||
    authority.verifiedAt > evaluatedAt ||
    (completenessEvidence.nextApplicabilityBoundary !== undefined &&
      evaluatedAt >= completenessEvidence.nextApplicabilityBoundary)
  ) {
    return false;
  }
  if (
    predicate.basis.kind === 'VARIANT_LINE' &&
    !exactPriceBasisBelongsToDecision(decision, predicate.basis.catalogSelection, predicate.basis.unitBasis)
  ) {
    return false;
  }
  return identityKeys.every(
    (key) =>
      key.family === 'CONTRACTUAL_DISCOUNT' &&
      key.currencyCode === predicate.currencyCode &&
      sameCommercialScope(key.commercialScope, predicate.commercialScope) &&
      sameDiscountBasis(key.basis, predicate.basis) &&
      predicate.audiences.some((audience) => sameDiscountAudience(audience, key.audience)),
  );
};

const groupInterpretationMatchesResponse = (
  interpretation: typeof PriceGroupInterpretationSchema.Type,
  resolution: typeof PriceGroupAssignmentResolutionSchema.Type,
): boolean =>
  Match.value(interpretation).pipe(
    Match.tag('ASSIGNED', ({ assignmentResolution }) => sameGroupResolution(resolution, assignmentResolution)),
    Match.tag('NONE', ({ assignmentResolution }) => sameGroupResolution(resolution, assignmentResolution)),
    Match.tag('BROKEN', ({ assignmentResolution }) => sameGroupResolution(resolution, assignmentResolution)),
    Match.tag('INCONSISTENT', ({ assignmentResolution }) => sameGroupResolution(resolution, assignmentResolution)),
    Match.tag('UNAVAILABLE', () => false),
    Match.tag('UNVERIFIABLE', () => false),
    Match.exhaustive,
  );

const purchaseActorMatches = (
  request: typeof PricingPurchaseContextVerificationRequestSchema.Type,
  evidence: typeof PricingPurchaseContextVerificationEvidenceSchema.Type,
): boolean =>
  (request.actor.kind === 'AUTHENTICATED_CUSTOMER' &&
    request.subject.kind === 'PROFILE' &&
    evidence.subjectAuthority.kind === 'PROFILE' &&
    evidence.subjectAuthority.actorPrincipalId === request.actor.principalId) ||
  (request.actor.kind === 'GUEST' && request.subject.kind === 'GUEST' && evidence.subjectAuthority.kind === 'GUEST');

const purchaseContextMaterialBindsDecision = (
  decision: PricingDecision,
  subject: typeof PricingCurrencySubjectSchema.Type,
  effectiveAt: typeof PricingInstantSchema.Type,
  evaluatedAt: typeof PricingInstantSchema.Type,
  request: typeof PricingPurchaseContextVerificationRequestSchema.Type,
  evidence: typeof PricingPurchaseContextVerificationEvidenceSchema.Type,
): boolean =>
  request.tenantId === decision.tenantId &&
  request.operationTime === effectiveAt &&
  request.purchasingContext.contextRef === decision.purchasingContext.contextRef &&
  request.purchasingContext.contextRevision === decision.purchasingContext.contextRevision &&
  request.purchasingContext.channelId === decision.commercialScope.channelId &&
  request.purchasingContext.marketId === decision.commercialScope.marketId &&
  request.purchasingContext.sellingLegalEntityId === decision.commercialScope.sellingLegalEntityId &&
  samePricingSubject(request.subject, subject) &&
  evidence.currentness.evaluatedAt === effectiveAt &&
  evidence.currentness.observedAt <= evaluatedAt &&
  evidence.ownerRef === decision.purchasingContext.contextRef &&
  evidence.ownerRevisionRef === decision.purchasingContext.contextRevision &&
  evidence.verifiedScope.tenantId === decision.tenantId &&
  evidence.verifiedScope.channelId === decision.commercialScope.channelId &&
  evidence.verifiedScope.marketId === decision.commercialScope.marketId &&
  evidence.verifiedScope.legalEntityId === decision.commercialScope.sellingLegalEntityId &&
  samePricingSubject(evidence.subjectAuthority.subject, subject) &&
  purchaseActorMatches(request, evidence);

const catalogEquivalenceMaterialBindsDecision = (
  decision: PricingDecision,
  effectiveAt: typeof PricingInstantSchema.Type,
  evaluatedAt: typeof PricingInstantSchema.Type,
  request: typeof PricingPurposeEquivalenceRequestSchema.Type,
  response: typeof PricingPurposeEquivalenceResponseSchema.Type,
): boolean => {
  const exactMembers =
    request.members.length === decision.lines.length &&
    request.members.every(({ handoff, occurrenceId }, index) => {
      const line = decision.lines[index];
      return line !== undefined && occurrenceId === line.occurrenceId && sameCatalogHandoff(handoff, line.catalog);
    });
  if (
    request.effectiveAt !== effectiveAt ||
    !selectionBelongsToDecision(decision, request.anchorSelection) ||
    !exactMembers
  ) {
    return false;
  }
  return Match.value(response).pipe(
    Match.discriminator('outcome')('CATALOG_EQUIVALENCE_CONFIRMED', ({ assessments, evidence }) => {
      const [anchor, ...members] = assessments;
      return (
        anchor?.role === 'ANCHOR' &&
        sameSelection(anchor.handoff.selection, request.anchorSelection) &&
        evidence.effectiveAt === effectiveAt &&
        evidence.observedAt <= evaluatedAt &&
        evaluatedAt < evidence.validThrough &&
        members.length === request.members.length &&
        members.every((assessment, index) => {
          const requested = request.members[index];
          return (
            assessment.role === 'MEMBER' &&
            requested !== undefined &&
            assessment.occurrenceId === requested.occurrenceId &&
            sameCatalogHandoff(assessment.handoff, requested.handoff)
          );
        })
      );
    }),
    Match.orElse(() => false),
  );
};

const materialBindsDecision = (
  candidateRef: string,
  decision: PricingDecision,
  subject: typeof PricingCurrencySubjectSchema.Type,
  effectiveAt: typeof PricingInstantSchema.Type,
  evaluatedAt: typeof PricingInstantSchema.Type,
  verificationMaterial: PricingMaterialEvidenceFenceVerificationMaterial,
  sourceEvidence?: typeof verifiedSourceEvidenceSchema.Type,
): boolean =>
  Match.value(verificationMaterial).pipe(
    Match.discriminator('kind')('PRICING_PRICE_AUTHORITY', (material) => {
      const key = material.lookupRequest.exactKey;
      return (
        material.lookupRequest.effectiveAt === effectiveAt &&
        key.currencyCode === decision.currencyCode &&
        sameCommercialScope(key.commercialScope, decision.commercialScope) &&
        exactPriceBasisBelongsToDecision(decision, key.catalogSelection, key.unitBasis)
      );
    }),
    Match.discriminator('kind')('PRICING_QUANTITY_TIER_AUTHORITY', (material) => {
      const { attempt } = material.selectionInput;
      const identity = attempt.exactPrice.price.definition.identityKey;
      return (
        attempt.evaluatedAt <= evaluatedAt &&
        identity.currencyCode === decision.currencyCode &&
        sameCommercialScope(identity.commercialScope, decision.commercialScope) &&
        exactPriceBasisBelongsToDecision(decision, identity.catalogSelection, identity.unitBasis)
      );
    }),
    Match.discriminator('kind')(
      'PRICING_DISCOUNT_AUTHORITY',
      (material) =>
        discountOwnerReceiptBindsDecision(
          decision,
          effectiveAt,
          evaluatedAt,
          material.identityKeys,
          material.ownerReadReceipt,
        ) &&
        material.identityKeys.every(
          (key) =>
            key.currencyCode === decision.currencyCode &&
            sameCommercialScope(key.commercialScope, decision.commercialScope) &&
            (key.basis.kind === 'WHOLE_PURCHASE' || selectionBelongsToDecision(decision, key.basis.catalogSelection)),
        ) &&
        material.applicabilityBindings.every(({ applicabilityBasis }) => applicabilityBasis.observedAt <= evaluatedAt),
    ),
    Match.discriminator('kind')(
      'PRICING_COMMERCIAL_FEE_AUTHORITY',
      (material) =>
        material.currentSet.observedAt <= evaluatedAt &&
        material.currentSet.currencyCode === decision.currencyCode &&
        sameCommercialScope(material.currentSet.commercialScope, decision.commercialScope) &&
        decision.lines.some(
          (line) => line.catalog.selection.variantRef.resourceId === material.currentSet.target.variantRef.resourceId,
        ),
    ),
    Match.discriminator('kind')('PRICING_ZERO_FLOOR_AUTHORITY', (material) => {
      const line = lineForOccurrence(decision, material.occurrenceId);
      const { query } = material;
      if (
        line === undefined ||
        query.tenantId !== decision.tenantId ||
        query.effectiveAt !== effectiveAt ||
        query.currencyCode !== decision.currencyCode ||
        !sameCommercialScope(query.commercialScope, decision.commercialScope) ||
        !sameSelection(query.catalogSelection, line.catalog.selection) ||
        !sameUnitBasis(query.pricingBasis, line.pricingBasis)
      ) {
        return false;
      }
      const guard = material.appliedGuard;
      return (
        guard === undefined ||
        (sameCommercialScope(guard.authorization.commercialScope, decision.commercialScope) &&
          guard.authorization.economicEnvelope.currencyCode === decision.currencyCode &&
          sameSelection(guard.authorization.selection, line.catalog.selection) &&
          sameUnitBasis(guard.authorization.pricingBasis, line.pricingBasis) &&
          guard.authorization.effectivePeriod.startsAt <= effectiveAt &&
          (guard.authorization.effectivePeriod.endsAt === undefined ||
            effectiveAt < guard.authorization.effectivePeriod.endsAt))
      );
    }),
    Match.discriminator('kind')(
      'PRICING_CURRENCY_SUPPORT_AUTHORITY',
      ({ support }) =>
        support.tenantId === decision.tenantId &&
        support.effectiveAt === effectiveAt &&
        support.supportedCurrencies.includes(decision.currencyCode),
    ),
    Match.discriminator('kind')(
      'CATALOG_LINE_AUTHORITY',
      ({ compatibilityRequest, compatibilityResponse, handoff, line: retainedLine, request }) => {
        const line = lineForOccurrence(decision, retainedLine.occurrenceId);
        return (
          line !== undefined &&
          sameLine(line, retainedLine) &&
          sameCatalogHandoff(handoff, line.catalog) &&
          catalogCompatibilityBindsLine(line, handoff, evaluatedAt, compatibilityRequest, compatibilityResponse) &&
          request.amount === handoff.quantity.requested &&
          sameSelection(request.selection, handoff.selection)
        );
      },
    ),
    Match.discriminator('kind')('CATALOG_EQUIVALENCE_AUTHORITY', ({ request, response }) =>
      catalogEquivalenceMaterialBindsDecision(decision, effectiveAt, evaluatedAt, request, response),
    ),
    Match.discriminator('kind')('MARKET_CONTEXT_AUTHORITY', ({ commercialScope }) =>
      sameCommercialScope(commercialScope, decision.commercialScope),
    ),
    Match.discriminator('kind')('CUSTOMER_CONTEXT_GROUP_AUTHORITY', ({ input, interpretation, request, response }) => {
      const { assignmentRequest } = input;
      return (
        Schema.is(PriceGroupAssignmentResolutionRequestSchema)(assignmentRequest) &&
        sameGroupRequest(request, assignmentRequest) &&
        response.effectiveAt === effectiveAt &&
        response.observedAt <= evaluatedAt &&
        response.currentnessEvidence.revalidatedAt <= evaluatedAt &&
        response.currentnessEvidence.evaluatedAt === effectiveAt &&
        groupInterpretationMatchesResponse(interpretation, response.resolution) &&
        input.basis.currencyCode === decision.currencyCode &&
        sameCommercialScope(input.basis.commercialScope, decision.commercialScope) &&
        selectionBelongsToDecision(decision, input.basis.catalogSelection)
      );
    }),
    Match.discriminator('kind')('CUSTOMER_CONTEXT_PURCHASE_AUTHORITY', ({ evidence, request }) =>
      purchaseContextMaterialBindsDecision(decision, subject, effectiveAt, evaluatedAt, request, evidence),
    ),
    Match.discriminator('kind')(
      'PROMOTION_APPLICABILITY_AUTHORITY',
      ({ application, currentness }) =>
        sourceEvidence !== undefined &&
        application.acceptedRequest.candidateRef === candidateRef &&
        currentness.candidateRef === candidateRef &&
        application.acceptedRequest.exactPredicateRef === sourceEvidence.request.ownerScope.predicateRef &&
        currentness.exactPredicateRef === sourceEvidence.request.ownerScope.predicateRef &&
        currentness.ownerEvidence.currentness.evaluatedAt <= evaluatedAt,
    ),
    Match.exhaustive,
  );

type PricingMaterialOwnerReadReceipt =
  | PricingExactPriceOwnerReadReceipt
  | PricingTierOwnerReadReceipt
  | PricingCommercialFeeOwnerReadReceipt
  | PricingZeroFloorOwnerReadReceipt;

const sameFactProof = (left: PricingOwnerFactProof, right: PricingOwnerFactProof): boolean =>
  left.factRef === right.factRef &&
  left.factRevisionRef === right.factRevisionRef &&
  left.verificationRef === right.verificationRef;

const exactFactProofMultiset = (
  left: readonly PricingOwnerFactProof[],
  right: readonly PricingOwnerFactProof[],
): boolean =>
  left.length === right.length &&
  left.every(
    (proof) =>
      left.filter((candidate) => sameFactProof(proof, candidate)).length ===
      right.filter((candidate) => sameFactProof(proof, candidate)).length,
  ) &&
  right.every(
    (proof) =>
      right.filter((candidate) => sameFactProof(proof, candidate)).length ===
      left.filter((candidate) => sameFactProof(proof, candidate)).length,
  );

const ownerReadReceiptMatchesSource = (
  receipt: PricingMaterialOwnerReadReceipt,
  source: typeof verifiedSourceEvidenceSchema.Type,
): boolean => {
  const { authority, factProofs } = receipt;
  const { completeness } = source;
  if (
    authority.observedAt !== completeness.temporal.observedAt ||
    authority.ownerRevision !== completeness.ownerSetRevisionRef ||
    authority.ownerRootRef !== completeness.ownerScope.ownerRootRef ||
    authority.predicateRef !== completeness.ownerScope.predicateRef ||
    authority.verificationRef !== completeness.verification.verificationRef ||
    authority.nextApplicabilityBoundary !== completeness.temporal.nextMaterialBoundary
  ) {
    return false;
  }
  const retainedFacts = Match.value(source).pipe(
    Match.tag('VERIFIED_PRESENT', ({ currentFacts }) => currentFacts),
    Match.tag('VERIFIED_ABSENT', () => []),
    Match.exhaustive,
  );
  return exactFactProofMultiset(
    factProofs,
    retainedFacts.map(({ factRef, factRevisionRef, verification }) => ({
      factRef,
      factRevisionRef,
      verificationRef: verification.verificationRef,
    })),
  );
};

const discountOwnerReceiptMatchesSource = (
  receipt: PricingDiscountOwnerReadReceipt,
  source: typeof verifiedSourceEvidenceSchema.Type,
): boolean => {
  const nextBoundary = receipt.completenessEvidence.nextApplicabilityBoundary;
  const authority =
    nextBoundary === undefined ? receipt.authority : { ...receipt.authority, nextApplicabilityBoundary: nextBoundary };
  return ownerReadReceiptMatchesSource({ authority, factProofs: receipt.factProofs }, source);
};

const currencySupportReceiptMatchesSource = (
  support: typeof CurrentSupportedCurrenciesSuccessSchema.Type,
  source: typeof verifiedSourceEvidenceSchema.Type,
): boolean => {
  const { completeness } = source;
  const retainedFacts = Match.value(source).pipe(
    Match.tag('VERIFIED_PRESENT', ({ currentFacts }) => currentFacts),
    Match.tag('VERIFIED_ABSENT', () => []),
    Match.exhaustive,
  );
  return (
    support.observedAt === completeness.temporal.observedAt &&
    support.supportRevisionRef.resourceId === completeness.ownerSetRevisionRef &&
    support.supportRootRef.resourceId === completeness.ownerScope.ownerRootRef &&
    support.completenessEvidence.scope.predicateRef === completeness.ownerScope.predicateRef &&
    support.verificationRef === completeness.verification.verificationRef &&
    support.nextApplicabilityBoundary === completeness.temporal.nextMaterialBoundary &&
    exactFactProofMultiset(
      support.factProofs,
      retainedFacts.map(({ factRef, factRevisionRef, verification }) => ({
        factRef,
        factRevisionRef,
        verificationRef: verification.verificationRef,
      })),
    )
  );
};

const customerGroupReceiptMatchesSource = (
  response: typeof PricingCustomerPriceGroupResolutionResponseSchema.Type,
  source: typeof verifiedSourceEvidenceSchema.Type,
): boolean => {
  const { completeness } = source;
  return (
    response.observedAt === completeness.temporal.observedAt &&
    response.completenessEvidence.ownerRevision === completeness.ownerSetRevisionRef &&
    response.completenessEvidence.scope.predicateRef === completeness.ownerScope.predicateRef &&
    response.verificationReceipt.verificationRef === completeness.verification.verificationRef &&
    response.completenessEvidence.nextApplicabilityBoundary === completeness.temporal.nextMaterialBoundary
  );
};

const catalogLineReceiptMatchesSource = (
  handoff: typeof CatalogQuantityHandoffReadySchema.Type,
  source: typeof verifiedSourceEvidenceSchema.Type,
): boolean =>
  handoff.completeness.observedAt === source.completeness.temporal.observedAt &&
  handoff.completeness.ownerRevision === source.completeness.ownerSetRevisionRef &&
  handoff.completeness.scope.predicateRef === source.completeness.ownerScope.predicateRef &&
  handoff.completeness.nextApplicabilityBoundary === source.completeness.temporal.nextMaterialBoundary;

const catalogEquivalenceReceiptMatchesSource = (
  response: typeof PricingPurposeEquivalenceResponseSchema.Type,
  source: typeof verifiedSourceEvidenceSchema.Type,
): boolean =>
  Match.value(response).pipe(
    Match.discriminator('outcome')(
      'CATALOG_EQUIVALENCE_CONFIRMED',
      ({ evidence }) =>
        evidence.observedAt === source.completeness.temporal.observedAt &&
        evidence.ownerRevision === source.completeness.ownerSetRevisionRef &&
        evidence.validThrough === source.completeness.temporal.nextMaterialBoundary,
    ),
    Match.orElse(() => false),
  );

const marketReceiptMatchesSource = (
  receipt: typeof PricingMarketSourceReceiptSchema.Type,
  source: typeof verifiedSourceEvidenceSchema.Type,
): boolean => {
  const { authority } = receipt;
  if (
    authority.observedAt !== source.completeness.temporal.observedAt ||
    authority.ownerRootRef !== source.completeness.ownerScope.ownerRootRef ||
    authority.ownerSetRevisionRef !== source.completeness.ownerSetRevisionRef ||
    authority.predicateRef !== source.completeness.ownerScope.predicateRef ||
    authority.verificationRef !== source.completeness.verification.verificationRef ||
    authority.nextApplicabilityBoundary !== source.completeness.temporal.nextMaterialBoundary
  ) {
    return false;
  }
  return Match.value(source).pipe(
    Match.tag('VERIFIED_PRESENT', ({ currentFacts }) => {
      const [receiptFact] = receipt.currentFacts;
      const [sourceFact] = currentFacts;
      return (
        receipt.state === 'PRESENT' &&
        currentFacts.length === 1 &&
        receiptFact !== undefined &&
        sourceFact !== undefined &&
        receiptFact.factRef === sourceFact.factRef &&
        receiptFact.factRevisionRef === sourceFact.factRevisionRef &&
        receiptFact.verificationRef === sourceFact.verification.verificationRef &&
        receiptFact.effectivePeriod.startsAt === sourceFact.effectivePeriod.effectiveFrom &&
        receiptFact.effectivePeriod.endsAt === (sourceFact.effectivePeriod.effectiveTo ?? undefined)
      );
    }),
    Match.tag('VERIFIED_ABSENT', () => receipt.state === 'ABSENT'),
    Match.exhaustive,
  );
};

const ownerReceiptMaterialMatchesSource = (
  material: PricingMaterialEvidenceFenceVerificationMaterial,
  source: typeof verifiedSourceEvidenceSchema.Type,
): boolean =>
  Match.value(material).pipe(
    Match.discriminator('kind')('PRICING_COMMERCIAL_FEE_AUTHORITY', ({ ownerReadReceipt }) =>
      ownerReadReceiptMatchesSource(ownerReadReceipt, source),
    ),
    Match.discriminator('kind')('PRICING_CURRENCY_SUPPORT_AUTHORITY', ({ support }) =>
      currencySupportReceiptMatchesSource(support, source),
    ),
    Match.discriminator('kind')('PRICING_DISCOUNT_AUTHORITY', ({ ownerReadReceipt }) =>
      discountOwnerReceiptMatchesSource(ownerReadReceipt, source),
    ),
    Match.discriminator('kind')('PRICING_PRICE_AUTHORITY', ({ ownerReadReceipt }) =>
      ownerReadReceiptMatchesSource(ownerReadReceipt, source),
    ),
    Match.discriminator('kind')('PRICING_QUANTITY_TIER_AUTHORITY', ({ ownerReadReceipt }) =>
      ownerReadReceiptMatchesSource(ownerReadReceipt, source),
    ),
    Match.discriminator('kind')('PRICING_ZERO_FLOOR_AUTHORITY', ({ ownerReadReceipt }) =>
      ownerReadReceiptMatchesSource(ownerReadReceipt, source),
    ),
    Match.discriminator('kind')('CATALOG_LINE_AUTHORITY', ({ handoff }) =>
      catalogLineReceiptMatchesSource(handoff, source),
    ),
    Match.discriminator('kind')('CATALOG_EQUIVALENCE_AUTHORITY', ({ response }) =>
      catalogEquivalenceReceiptMatchesSource(response, source),
    ),
    Match.discriminator('kind')('CUSTOMER_CONTEXT_GROUP_AUTHORITY', ({ response }) =>
      customerGroupReceiptMatchesSource(response, source),
    ),
    Match.discriminator('kind')('MARKET_CONTEXT_AUTHORITY', ({ receipt }) =>
      marketReceiptMatchesSource(receipt, source),
    ),
    Match.orElse(() => true),
  );

const fenceSourceBindsRequest = (
  candidateRef: string,
  decision: PricingDecision,
  subject: typeof PricingCurrencySubjectSchema.Type,
  effectiveAt: typeof PricingInstantSchema.Type,
  evaluatedAt: typeof PricingInstantSchema.Type,
  requestedAt: typeof PricingInstantSchema.Type,
  source: PricingMaterialEvidenceFenceSource,
): boolean => {
  if (!('sourceEvidence' in source)) {
    const { evidence, request } = source.verificationMaterial;
    return purchaseContextMaterialBindsDecision(decision, subject, effectiveAt, evaluatedAt, request, evidence);
  }
  const { completeness, request } = source.sourceEvidence;
  const [ownerModuleId, family] = expectedOwnerAndFamily(source.verificationMaterial);
  return (
    request.ownerScope.ownerModuleId === ownerModuleId &&
    request.family === family &&
    request.ownerScope.tenantId === decision.tenantId &&
    request.effectiveAt === effectiveAt &&
    request.requestedAt === requestedAt &&
    (request.currencyCode === undefined || request.currencyCode === decision.currencyCode) &&
    completeness.temporal.evaluatedAt <= evaluatedAt &&
    completeness.temporal.observedAt <= evaluatedAt &&
    (completeness.temporal.nextMaterialBoundary === undefined ||
      evaluatedAt < completeness.temporal.nextMaterialBoundary) &&
    ownerReceiptMaterialMatchesSource(source.verificationMaterial, source.sourceEvidence) &&
    materialBindsDecision(
      candidateRef,
      decision,
      subject,
      effectiveAt,
      evaluatedAt,
      source.verificationMaterial,
      source.sourceEvidence,
    )
  );
};

export interface PricingOwnerMaterialEvidenceFenceGatewayRequest {
  readonly candidateRef: string;
  readonly decision: PricingDecision;
  readonly effectiveAt: typeof PricingInstantSchema.Type;
  readonly evaluatedAt: typeof PricingInstantSchema.Type;
  readonly requestedAt: typeof PricingInstantSchema.Type;
  readonly sources: readonly PricingMaterialEvidenceFenceSource[];
  readonly subject: typeof PricingCurrencySubjectSchema.Type;
}

/** Lossless internal request used by each owner for an immediate typed Current/generation-through check. */
export const PricingOwnerMaterialEvidenceFenceGatewayRequestSchema: Schema.Codec<
  PricingOwnerMaterialEvidenceFenceGatewayRequest,
  unknown
> = Schema.Struct({
  candidateRef: stableReference,
  decision: PricingDecisionSchema,
  effectiveAt: PricingInstantSchema,
  evaluatedAt: PricingInstantSchema,
  requestedAt: PricingInstantSchema,
  sources: Schema.Array(PricingMaterialEvidenceFenceSourceSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2000),
  ),
  subject: PricingCurrencySubjectSchema,
}).check(
  Schema.makeFilter(({ candidateRef, decision, effectiveAt, evaluatedAt, requestedAt, sources, subject }) => {
    if (decision.operationTime !== effectiveAt) {
      return 'Owner final fence must preserve the trusted Pricing Decision effective instant';
    }
    if (requestedAt > evaluatedAt) {
      return 'Owner final fence cannot complete candidate evaluation before the source request';
    }
    const purchaseAuthorityCount = sources.filter(
      ({ verificationMaterial }) => verificationMaterial.kind === 'CUSTOMER_CONTEXT_PURCHASE_AUTHORITY',
    ).length;
    const groupAuthorityCount = sources.filter(
      ({ verificationMaterial }) => verificationMaterial.kind === 'CUSTOMER_CONTEXT_GROUP_AUTHORITY',
    ).length;
    if (purchaseAuthorityCount !== 1 || groupAuthorityCount !== (subject.kind === 'PROFILE' ? 1 : 0)) {
      return 'Final fence requires one Purchase Context singleton proof and Price Group authority only for Profile subjects';
    }
    return sources.every((source) =>
      fenceSourceBindsRequest(candidateRef, decision, subject, effectiveAt, evaluatedAt, requestedAt, source),
    )
      ? undefined
      : 'Every owner final-fence source must retain exact typed authority and bind the same candidate evaluation';
  }),
);

const discountNonSelectionBindsCandidate = (
  selection: PricingMaterialDiscountSelection | PricingMaterialWholePurchaseScopeIneligible,
  decision: PricingDecision,
  subject: typeof PricingCurrencySubjectSchema.Type,
  revalidatedAt: typeof PricingInstantSchema.Type,
): boolean => {
  if (selection.kind === 'DISCOUNT_SELECTED') {
    return true;
  }
  const { currentness, ownerRef, ownerRevisionRef, subjectAuthority } = selection.subjectEvidence;
  if (
    !samePricingSubject(subjectAuthority.subject, subject) ||
    ownerRef !== decision.purchasingContext.contextRef ||
    ownerRevisionRef !== decision.purchasingContext.contextRevision ||
    currentness.evaluatedAt !== decision.operationTime ||
    currentness.observedAt > revalidatedAt
  ) {
    return false;
  }
  if (selection.kind === 'DISCOUNT_NOT_SELECTED_SCOPE_INELIGIBLE') {
    return (
      subjectAuthority.kind === 'PROFILE' &&
      subjectAuthority.subject.kind === 'PROFILE' &&
      subjectAuthority.subject.authorizationSubject.kind === 'RETAIL'
    );
  }
  if (selection.audienceDecision.kind === 'GUEST') {
    return subjectAuthority.kind === 'GUEST';
  }
  if (subjectAuthority.kind !== 'PROFILE' || subjectAuthority.subject.kind !== 'PROFILE') {
    return false;
  }
  const { interpretations } = selection.audienceDecision;
  return (
    interpretations.length === decision.lines.length &&
    interpretations.every(({ input }, index) => {
      const line = decision.lines[index];
      return (
        line !== undefined &&
        Schema.is(PriceGroupAssignmentResolutionRequestSchema)(input.assignmentRequest) &&
        input.basis.currencyCode === decision.currencyCode &&
        sameCommercialScope(input.basis.commercialScope, decision.commercialScope) &&
        sameSelection(input.basis.catalogSelection, line.catalog.selection) &&
        sameUnitBasis(input.basis.unitBasis, line.pricingBasis)
      );
    })
  );
};

export interface PricingMaterialEvidenceAssemblyRequest {
  readonly commercialTotal: PricingCommercialTotalReady;
  readonly currencySupport: PricingSourceEvidenceResult;
  readonly externalOwnerEvidence: PricingRetainedExternalOwnerEvidence;
  readonly lines: readonly PricingMaterialLineEvidence[];
  /** Exact owner predicates and handoffs retained for the final publication fence. */
  readonly ownerFenceRequest?: PricingOwnerMaterialEvidenceFenceGatewayRequest;
  readonly requestedAt: typeof PricingInstantSchema.Type;
  readonly revalidatedAt: typeof PricingInstantSchema.Type;
  readonly wholePurchase: PricingMaterialWholePurchaseEvidence;
}

export const PricingMaterialEvidenceAssemblyRequestSchema: Schema.Codec<
  PricingMaterialEvidenceAssemblyRequest,
  unknown
> = Schema.Struct({
  commercialTotal: Schema.toType(PricingCommercialTotalReadySchema),
  currencySupport: PricingSourceEvidenceResultSchema,
  externalOwnerEvidence: Schema.toType(PricingRetainedExternalOwnerEvidenceSchema),
  lines: Schema.Array(PricingMaterialLineEvidenceSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ownerFenceRequest: Schema.optionalKey(Schema.toType(PricingOwnerMaterialEvidenceFenceGatewayRequestSchema)),
  requestedAt: PricingInstantSchema,
  revalidatedAt: PricingInstantSchema,
  wholePurchase: PricingMaterialWholePurchaseEvidenceSchema,
}).check(
  Schema.makeFilter(
    ({
      commercialTotal,
      externalOwnerEvidence,
      lines,
      ownerFenceRequest,
      requestedAt,
      revalidatedAt,
      wholePurchase,
    }) => {
      if (requestedAt > revalidatedAt) {
        return 'Material-evidence final revalidation cannot precede the source request';
      }
      if (
        externalOwnerEvidence.candidateRef !== commercialTotal.candidateRef ||
        !samePricingDecision(externalOwnerEvidence.decision, commercialTotal.decision) ||
        externalOwnerEvidence.requestedAt !== requestedAt ||
        externalOwnerEvidence.validatedAt !== revalidatedAt
      ) {
        return 'External owner evidence must bind the exact candidate and final validation interval';
      }
      if (
        ownerFenceRequest !== undefined &&
        (ownerFenceRequest.candidateRef !== commercialTotal.candidateRef ||
          !samePricingDecision(ownerFenceRequest.decision, commercialTotal.decision) ||
          !samePricingSubject(ownerFenceRequest.subject, externalOwnerEvidence.subject) ||
          ownerFenceRequest.effectiveAt !== commercialTotal.decision.operationTime ||
          ownerFenceRequest.requestedAt !== requestedAt ||
          ownerFenceRequest.evaluatedAt !== revalidatedAt)
      ) {
        return 'Owner final-fence request must bind the exact material-evidence candidate and validation interval';
      }
      const discountSelections = [
        ...lines.map(({ lineDiscounts }) => lineDiscounts),
        wholePurchase.contractualDiscounts,
      ];
      const nonSelections = discountSelections.filter(({ kind }) => kind !== 'DISCOUNT_SELECTED');
      if (
        !nonSelections.every((selection) =>
          discountNonSelectionBindsCandidate(
            selection,
            commercialTotal.decision,
            externalOwnerEvidence.subject,
            revalidatedAt,
          ),
        )
      ) {
        return 'Each Discount non-selection must retain exact CCC-backed audience or scope-ineligibility evidence';
      }
      const expectedOccurrences = commercialTotal.decision.lines.map(({ occurrenceId }) => occurrenceId);
      const suppliedOccurrences = lines.map(({ occurrenceId }) => occurrenceId);
      if (new Set(suppliedOccurrences).size !== suppliedOccurrences.length) {
        return 'Material-evidence lines must preserve distinct stable occurrence identities';
      }
      return expectedOccurrences.length === suppliedOccurrences.length &&
        expectedOccurrences.every((occurrenceId, index) => suppliedOccurrences[index] === occurrenceId)
        ? undefined
        : 'Material-evidence lines must preserve the exact ordered Pricing candidate';
    },
  ),
);

export const PricingMaterialCalculationVersionsSchema = Schema.Struct({
  allocationContractVersions: Schema.Array(stableReference),
  arithmeticProfileVersions: Schema.Array(stableReference).check(Schema.isMinLength(1)),
  publicationProfileVersions: Schema.Array(stableReference).check(Schema.isMinLength(1)),
});
export type PricingMaterialCalculationVersions = typeof PricingMaterialCalculationVersionsSchema.Type;

const sameRetainedExternalOwnerEvidence = Schema.toEquivalence(PricingRetainedExternalOwnerEvidenceSchema);
const sameCalculationVersions = Schema.toEquivalence(PricingMaterialCalculationVersionsSchema);

export interface PricingMaterialEvidenceReady {
  readonly calculationVersions: PricingMaterialCalculationVersions;
  readonly candidateRef: string;
  readonly externalOwnerEvidence: PricingRetainedExternalOwnerEvidence;
  readonly outcome: 'PRICING_MATERIAL_EVIDENCE_READY';
  readonly sourceEvidence: PricingMaterialEvidenceAssemblyRequest;
  readonly validatedAt: typeof PricingInstantSchema.Type;
}

export const PricingMaterialEvidenceReadySchema: Schema.Codec<PricingMaterialEvidenceReady, unknown> = Schema.Struct({
  calculationVersions: PricingMaterialCalculationVersionsSchema,
  candidateRef: stableReference,
  externalOwnerEvidence: Schema.toType(PricingRetainedExternalOwnerEvidenceSchema),
  outcome: Schema.Literal('PRICING_MATERIAL_EVIDENCE_READY'),
  sourceEvidence: Schema.toType(PricingMaterialEvidenceAssemblyRequestSchema),
  validatedAt: PricingInstantSchema,
}).check(
  Schema.makeFilter(({ calculationVersions, candidateRef, externalOwnerEvidence, sourceEvidence, validatedAt }) =>
    candidateRef === sourceEvidence.commercialTotal.candidateRef &&
    sameCalculationVersions(calculationVersions, sourceEvidence.commercialTotal.calculationVersions) &&
    sameRetainedExternalOwnerEvidence(externalOwnerEvidence, sourceEvidence.externalOwnerEvidence) &&
    validatedAt === sourceEvidence.revalidatedAt
      ? undefined
      : 'Material-evidence result must bind the exact candidate and final validation instant',
  ),
);

const commonFailureFields = {
  candidateRef: stableReference,
  family: Schema.optionalKey(stableReference),
  occurrenceId: Schema.optionalKey(PricingPurchaseDemandOccurrenceIdSchema),
  predicateRef: Schema.optionalKey(stableReference),
  reason: boundedReason,
} as const;

export class PricingMaterialEvidenceMissingFailure extends Schema.TaggedError<PricingMaterialEvidenceMissingFailure>()(
  'PricingMaterialEvidenceMissingFailure',
  commonFailureFields,
) {}

export class PricingMaterialEvidenceConflictFailure extends Schema.TaggedError<PricingMaterialEvidenceConflictFailure>()(
  'PricingMaterialEvidenceConflictFailure',
  commonFailureFields,
) {}

export class PricingMaterialEvidenceUnverifiableFailure extends Schema.TaggedError<PricingMaterialEvidenceUnverifiableFailure>()(
  'PricingMaterialEvidenceUnverifiableFailure',
  {
    ...commonFailureFields,
    retryable: Schema.Boolean,
  },
) {}

export type PricingMaterialEvidenceFailure =
  | PricingMaterialEvidenceMissingFailure
  | PricingMaterialEvidenceConflictFailure
  | PricingMaterialEvidenceUnverifiableFailure;

/** Narrowed alias used by adapters that can only proceed with a Current non-empty owner set. */
export { PricingSourceEvidenceVerifiedPresentSchema as PricingMaterialVerifiedPresentSchema } from './source-revision-evidence.ts';
export type PricingMaterialVerifiedPresent = PricingSourceEvidenceVerifiedPresent;
