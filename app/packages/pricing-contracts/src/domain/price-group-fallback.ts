import { Schema } from 'effect';

import {
  ExactPriceLookupAbsentSchema as AbsentExactPriceSchema,
  ExactPriceLookupConflictSchema as ConflictingExactPriceSchema,
  ExactPriceLookupFoundSchema as FoundExactPriceSchema,
  ExactPriceLookupInvalidReasonSchema,
  ExactPriceLookupInvalidSchema as InvalidExactPriceSchema,
  ExactPriceLookupRequestSchema,
  ExactPriceLookupResultSchema,
  ExactPriceLookupUnavailableSchema as UnavailableExactPriceSchema,
  ExactPriceLookupUnverifiableSchema as UnverifiableExactPriceSchema,
} from './exact-price-lookup.ts';
import { PricingInstantSchema } from './currency-support.ts';
import type { PriceIdentityKey } from './price-definition.ts';
import {
  AssignedPriceGroupInterpretationSchema,
  BrokenPriceGroupInterpretationSchema,
  InconsistentPriceGroupInterpretationSchema,
  NonePriceGroupInterpretationSchema,
  PriceGroupAssignmentResolutionResponseSchema,
  PriceGroupInterpretationBasisSchema,
  UnavailablePriceGroupInterpretationSchema,
  UnverifiablePriceGroupInterpretationSchema,
} from './price-group-interpretation.ts';

type ExactKey = PriceIdentityKey;
type InterpretationBasis = typeof PriceGroupInterpretationBasisSchema.Type;

const interpretationBasisEquivalence = Schema.toEquivalence(PriceGroupInterpretationBasisSchema);
const basisFromExactKey = (exactKey: ExactKey): InterpretationBasis => ({
  catalogSelection: exactKey.catalogSelection,
  commercialScope: exactKey.commercialScope,
  currencyCode: exactKey.currencyCode,
  unitBasis: exactKey.unitBasis,
});

const exactKeyMatchesBasis = (exactKey: ExactKey, basis: InterpretationBasis): boolean =>
  interpretationBasisEquivalence(basisFromExactKey(exactKey), basis);

const exactKeysDifferOnlyByGroup = (left: ExactKey, right: ExactKey): boolean =>
  interpretationBasisEquivalence(basisFromExactKey(left), basisFromExactKey(right));

const samePriceGroupRef = (
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

const OwnerNoneResolutionSchema = PriceGroupAssignmentResolutionResponseSchema.check(
  Schema.makeFilter(({ resolution }) =>
    Schema.is(NonePriceGroupInterpretationSchema.fields.assignmentResolution)(resolution)
      ? undefined
      : 'Owner no-group authority requires an owner-issued NONE resolution',
  ),
);

const AssignedFallbackInputSchema = Schema.TaggedStruct('ASSIGNED', {
  effectiveAt: PricingInstantSchema,
  interpretation: AssignedPriceGroupInterpretationSchema,
});

const OwnerNoneFallbackInputSchema = Schema.TaggedStruct('OWNER_NONE', {
  effectiveAt: PricingInstantSchema,
  interpretation: NonePriceGroupInterpretationSchema,
  ownerResolution: OwnerNoneResolutionSchema,
}).check(
  Schema.makeFilter(({ effectiveAt, interpretation, ownerResolution }) =>
    ownerResolution.effectiveAt === effectiveAt &&
    ownerResolution.profile.tenantId === interpretation.basis.catalogSelection.productRef.tenantId
      ? undefined
      : 'Owner NONE evidence must apply to the exact Tenant and evaluated instant',
  ),
);

const GuestFallbackInputSchema = Schema.TaggedStruct('GUEST', {
  basis: PriceGroupInterpretationBasisSchema,
  effectiveAt: PricingInstantSchema,
});

const BlockedFallbackInputSchema = Schema.TaggedStruct('BLOCKED', {
  effectiveAt: PricingInstantSchema,
  interpretation: Schema.Union([
    BrokenPriceGroupInterpretationSchema,
    InconsistentPriceGroupInterpretationSchema,
    UnavailablePriceGroupInterpretationSchema,
    UnverifiablePriceGroupInterpretationSchema,
  ]),
});

export const PriceGroupFallbackResolutionInputSchema = Schema.Union([
  AssignedFallbackInputSchema,
  OwnerNoneFallbackInputSchema,
  GuestFallbackInputSchema,
  BlockedFallbackInputSchema,
]);
export type PriceGroupFallbackResolutionInput = typeof PriceGroupFallbackResolutionInputSchema.Type;

export const PriceGroupFallbackExactLookupRequestSchema = ExactPriceLookupRequestSchema;
export type PriceGroupFallbackExactLookupRequest = typeof PriceGroupFallbackExactLookupRequestSchema.Type;

export const PriceGroupFallbackInvalidReasonSchema = ExactPriceLookupInvalidReasonSchema;
export type PriceGroupFallbackInvalidReason = typeof PriceGroupFallbackInvalidReasonSchema.Type;

export const PriceGroupFallbackExactLookupResultSchema = ExactPriceLookupResultSchema;
export type PriceGroupFallbackExactLookupResult = typeof PriceGroupFallbackExactLookupResultSchema.Type;

const AssignedDiscountAudienceSchema = AssignedPriceGroupInterpretationSchema.fields.discountAudience;
const NoGroupDiscountAudienceSchema = Schema.Struct({ kind: Schema.Literal('NONE') });

const GroupPriceResolutionSchema = Schema.TaggedStruct('GROUP_PRICE', {
  discountAudience: AssignedDiscountAudienceSchema,
  resolutionInput: AssignedFallbackInputSchema,
  usedPrice: FoundExactPriceSchema,
}).check(
  Schema.makeFilter(({ discountAudience, resolutionInput, usedPrice }) => {
    const selector = usedPrice.request.exactKey.priceGroupSelector;
    return usedPrice.request.effectiveAt === resolutionInput.effectiveAt &&
      exactKeyMatchesBasis(usedPrice.request.exactKey, resolutionInput.interpretation.basis) &&
      selector.kind === 'PRICE_GROUP' &&
      samePriceGroupRef(selector.priceGroupRef, resolutionInput.interpretation.priceGroupRef) &&
      samePriceGroupRef(discountAudience.priceGroupRef, resolutionInput.interpretation.priceGroupRef)
      ? undefined
      : 'Group Price resolution must use the assigned Group exact key and preserve its Discount audience';
  }),
);

const NoGroupNoneResolutionSchema = Schema.TaggedStruct('NO_GROUP_NONE', {
  discountAudience: NoGroupDiscountAudienceSchema,
  resolutionInput: OwnerNoneFallbackInputSchema,
  usedPrice: FoundExactPriceSchema,
}).check(
  Schema.makeFilter(({ resolutionInput, usedPrice }) =>
    usedPrice.request.effectiveAt === resolutionInput.effectiveAt &&
    usedPrice.request.exactKey.priceGroupSelector.kind === 'NO_GROUP' &&
    exactKeyMatchesBasis(usedPrice.request.exactKey, resolutionInput.interpretation.basis)
      ? undefined
      : 'Owner NONE resolution must use the exact no-group Price key',
  ),
);

const NoGroupGuestResolutionSchema = Schema.TaggedStruct('NO_GROUP_GUEST', {
  discountAudience: NoGroupDiscountAudienceSchema,
  resolutionInput: GuestFallbackInputSchema,
  usedPrice: FoundExactPriceSchema,
}).check(
  Schema.makeFilter(({ resolutionInput, usedPrice }) =>
    usedPrice.request.effectiveAt === resolutionInput.effectiveAt &&
    usedPrice.request.exactKey.priceGroupSelector.kind === 'NO_GROUP' &&
    exactKeyMatchesBasis(usedPrice.request.exactKey, resolutionInput.basis)
      ? undefined
      : 'Guest resolution must use the exact no-group Price key',
  ),
);

const NoGroupAfterAbsenceResolutionSchema = Schema.TaggedStruct('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', {
  discountAudience: AssignedDiscountAudienceSchema,
  groupAbsence: AbsentExactPriceSchema,
  resolutionInput: AssignedFallbackInputSchema,
  usedPrice: FoundExactPriceSchema,
}).check(
  Schema.makeFilter(({ discountAudience, groupAbsence, resolutionInput, usedPrice }) => {
    const groupSelector = groupAbsence.request.exactKey.priceGroupSelector;
    return groupAbsence.request.effectiveAt === resolutionInput.effectiveAt &&
      usedPrice.request.effectiveAt === resolutionInput.effectiveAt &&
      groupSelector.kind === 'PRICE_GROUP' &&
      samePriceGroupRef(groupSelector.priceGroupRef, resolutionInput.interpretation.priceGroupRef) &&
      samePriceGroupRef(discountAudience.priceGroupRef, resolutionInput.interpretation.priceGroupRef) &&
      usedPrice.request.exactKey.priceGroupSelector.kind === 'NO_GROUP' &&
      exactKeyMatchesBasis(groupAbsence.request.exactKey, resolutionInput.interpretation.basis) &&
      exactKeyMatchesBasis(usedPrice.request.exactKey, resolutionInput.interpretation.basis) &&
      exactKeysDifferOnlyByGroup(groupAbsence.request.exactKey, usedPrice.request.exactKey)
      ? undefined
      : 'Assigned fallback requires proven absence of the exact Group key before the matching no-group Price';
  }),
);

const NoApplicablePriceResolutionSchema = Schema.TaggedStruct('NO_APPLICABLE_PRICE', {
  groupAbsence: Schema.optionalKey(AbsentExactPriceSchema),
  noGroupAbsence: AbsentExactPriceSchema,
  resolutionInput: Schema.Union([AssignedFallbackInputSchema, OwnerNoneFallbackInputSchema, GuestFallbackInputSchema]),
}).check(
  Schema.makeFilter(({ groupAbsence, noGroupAbsence, resolutionInput }) => {
    const basis = Schema.is(GuestFallbackInputSchema)(resolutionInput)
      ? resolutionInput.basis
      : resolutionInput.interpretation.basis;
    if (
      noGroupAbsence.request.effectiveAt !== resolutionInput.effectiveAt ||
      noGroupAbsence.request.exactKey.priceGroupSelector.kind !== 'NO_GROUP' ||
      !exactKeyMatchesBasis(noGroupAbsence.request.exactKey, basis)
    ) {
      return 'No-applicable-Price requires proven absence of the exact no-group key';
    }
    if (!Schema.is(AssignedFallbackInputSchema)(resolutionInput)) {
      return groupAbsence === undefined
        ? undefined
        : 'Owner NONE and Guest no-price paths must not invent a Group lookup';
    }
    if (groupAbsence === undefined) {
      return 'Assigned no-price resolution requires proven exact Group absence before no-group absence';
    }
    const groupSelector = groupAbsence.request.exactKey.priceGroupSelector;
    return groupAbsence.request.effectiveAt === resolutionInput.effectiveAt &&
      groupSelector.kind === 'PRICE_GROUP' &&
      samePriceGroupRef(groupSelector.priceGroupRef, resolutionInput.interpretation.priceGroupRef) &&
      exactKeyMatchesBasis(groupAbsence.request.exactKey, basis) &&
      exactKeysDifferOnlyByGroup(groupAbsence.request.exactKey, noGroupAbsence.request.exactKey)
      ? undefined
      : 'Assigned no-price resolution requires matching exact Group and no-group absence evidence';
  }),
);

export const PriceGroupFallbackConfigurationReasonSchema = Schema.Union([
  PriceGroupFallbackInvalidReasonSchema,
  Schema.Literal('BROKEN_ASSIGNMENT'),
]);
export type PriceGroupFallbackConfigurationReason = typeof PriceGroupFallbackConfigurationReasonSchema.Type;

const ConfigurationErrorResolutionSchema = Schema.TaggedStruct('CONFIGURATION_ERROR', {
  lookup: Schema.optionalKey(InvalidExactPriceSchema),
  reason: PriceGroupFallbackConfigurationReasonSchema,
  resolutionInput: PriceGroupFallbackResolutionInputSchema,
}).check(
  Schema.makeFilter(({ lookup, reason, resolutionInput }) => {
    if (Schema.is(BlockedFallbackInputSchema)(resolutionInput)) {
      return Schema.is(BrokenPriceGroupInterpretationSchema)(resolutionInput.interpretation) &&
        lookup === undefined &&
        reason === 'BROKEN_ASSIGNMENT'
        ? undefined
        : 'Only a BROKEN interpretation can produce an assignment configuration error without a Price lookup';
    }
    return lookup !== undefined && lookup.reason === reason
      ? undefined
      : 'Invalid exact Price state must remain attached to its configuration outcome';
  }),
);

const ConflictResolutionSchema = Schema.TaggedStruct('CONFLICT', {
  lookup: Schema.optionalKey(ConflictingExactPriceSchema),
  reason: Schema.Literals(['COMPETING_CURRENT_EXACT_PRICES', 'INCONSISTENT_ASSIGNMENT']),
  resolutionInput: PriceGroupFallbackResolutionInputSchema,
}).check(
  Schema.makeFilter(({ lookup, reason, resolutionInput }) => {
    if (reason === 'INCONSISTENT_ASSIGNMENT') {
      return Schema.is(BlockedFallbackInputSchema)(resolutionInput) &&
        Schema.is(InconsistentPriceGroupInterpretationSchema)(resolutionInput.interpretation) &&
        lookup === undefined
        ? undefined
        : 'Inconsistent assignment conflicts must preserve their blocked owner interpretation';
    }
    return !Schema.is(BlockedFallbackInputSchema)(resolutionInput) && lookup !== undefined
      ? undefined
      : 'Competing Current Price conflicts must preserve their exact lookup evidence';
  }),
);

const IndeterminateResolutionSchema = Schema.TaggedStruct('INDETERMINATE', {
  lookup: Schema.optionalKey(Schema.Union([UnavailableExactPriceSchema, UnverifiableExactPriceSchema])),
  reason: Schema.Literals(['OWNER_STATE_UNAVAILABLE', 'OWNER_STATE_UNVERIFIABLE']),
  resolutionInput: PriceGroupFallbackResolutionInputSchema,
}).check(
  Schema.makeFilter(({ lookup, reason, resolutionInput }) => {
    if (Schema.is(BlockedFallbackInputSchema)(resolutionInput)) {
      return lookup === undefined &&
        ((Schema.is(UnavailablePriceGroupInterpretationSchema)(resolutionInput.interpretation) &&
          reason === 'OWNER_STATE_UNAVAILABLE') ||
          (Schema.is(UnverifiablePriceGroupInterpretationSchema)(resolutionInput.interpretation) &&
            reason === 'OWNER_STATE_UNVERIFIABLE'))
        ? undefined
        : 'Owner indeterminate outcomes must preserve the unavailable or unverifiable interpretation';
    }
    return lookup !== undefined &&
      ((Schema.is(UnavailableExactPriceSchema)(lookup) && reason === 'OWNER_STATE_UNAVAILABLE') ||
        (Schema.is(UnverifiableExactPriceSchema)(lookup) && reason === 'OWNER_STATE_UNVERIFIABLE'))
      ? undefined
      : 'Exact lookup indeterminate outcomes must preserve their unavailable or unverifiable evidence';
  }),
);

export const PriceGroupFallbackResolutionSchema = Schema.Union([
  GroupPriceResolutionSchema,
  NoGroupNoneResolutionSchema,
  NoGroupGuestResolutionSchema,
  NoGroupAfterAbsenceResolutionSchema,
  NoApplicablePriceResolutionSchema,
  ConfigurationErrorResolutionSchema,
  ConflictResolutionSchema,
  IndeterminateResolutionSchema,
]);
export type PriceGroupFallbackResolution = typeof PriceGroupFallbackResolutionSchema.Type;
