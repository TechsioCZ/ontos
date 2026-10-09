import {
  CatalogQuantityHandoffReadySchema,
  CatalogQuantityHandoffSchema,
} from '@app/catalog/domain/catalog-quantity-handoff';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Schema } from 'effect';

import {
  PricingContextRevisionSchema,
  PricingCurrencyCodeSchema,
  PricingCurrencySubjectSchema,
  PricingInstantSchema,
  PricingTenantIdSchema,
  CurrentSupportedCurrenciesSuccessSchema,
} from '../apis/current-supported-currencies.ts';
import { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

export const PricingPrincipalIdSchema = stableReference.pipe(
  Schema.brand('PricingPrincipalId'),
  Schema.decodeTo(Schema.String),
);
export type PricingPrincipalId = typeof PricingPrincipalIdSchema.Type;

export const PricingPurchaseDemandOccurrenceIdSchema = stableReference.pipe(
  Schema.brand('PricingPurchaseDemandOccurrenceId'),
  Schema.decodeTo(Schema.String),
);

export const PricingPositiveDecimalSchema = Schema.String.check(
  Schema.isPattern(/^(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d+)?)$/u),
);

const sameCatalogRef = (
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

/**
 * Pricing consumes Catalog's exact selection value unchanged; optional Catalog-owned Package,
 * Configuration, and Set meaning remains attached to the concrete Variant.
 */
export const PricingCatalogSelectionSchema = CatalogSelectionSchema;
export type PricingCatalogSelection = typeof PricingCatalogSelectionSchema.Type;

/** Resulting Quantity and Unit are upstream facts consumed as one immutable value. */
export const PricingQuantitySchema = Schema.Struct({
  amount: PricingPositiveDecimalSchema,
  unitRef: ProductUnitRefSchema,
});
export type PricingQuantity = typeof PricingQuantitySchema.Type;

/** Exact quantity-of-unit basis used to select a reusable Price fact. */
export const PricingUnitBasisSchema = Schema.Struct({
  quantity: PricingPositiveDecimalSchema,
  unitRef: ProductUnitRefSchema,
});
export type PricingUnitBasis = typeof PricingUnitBasisSchema.Type;

/** Pricing accepts only an owner-ready handoff whose purchase Unit is the Catalog Product Unit. */
export const PricingCatalogQuantityHandoffSchema = CatalogQuantityHandoffReadySchema.check(
  Schema.makeFilter(({ unitRef }) =>
    Schema.is(ProductUnitRefSchema)(unitRef) ? undefined : 'Pricing requires the Catalog handoff to use a Product Unit',
  ),
);
export type PricingCatalogQuantityHandoff = typeof PricingCatalogQuantityHandoffSchema.Type;

/** Catalog owns typed invalid, unverifiable, and stale preparation outcomes; Pricing preserves them. */
export const PricingLineInputAssessmentSchema = Schema.Struct({
  catalog: CatalogQuantityHandoffSchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
});
export type PricingLineInputAssessment = typeof PricingLineInputAssessmentSchema.Type;

/** Pricing's view of one upstream Purchase Demand Occurrence; it has no Cart or Order lifecycle. */
export const PricingLineSchema = Schema.Struct({
  catalog: PricingCatalogQuantityHandoffSchema,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  pricingBasis: PricingUnitBasisSchema,
}).check(
  Schema.makeFilter(({ catalog, pricingBasis }) => {
    const selectionTenantId = catalog.selection.productRef.tenantId;
    return pricingBasis.unitRef.tenantId === selectionTenantId && sameCatalogRef(pricingBasis.unitRef, catalog.unitRef)
      ? undefined
      : 'Pricing Line selection, resulting Quantity, and pricing basis must use the same Catalog Product Unit';
  }),
);
export type PricingLine = typeof PricingLineSchema.Type;

export { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';
export type { PricingCommercialScope } from './pricing-commercial-scope.ts';

const PricingPrincipalActorSchema = Schema.Struct({
  kind: Schema.Literal('PRINCIPAL'),
  principalId: PricingPrincipalIdSchema,
});

const PricingGuestActorSchema = Schema.Struct({
  guestEvidenceRef: stableReference,
  guestSessionRef: stableReference,
  kind: Schema.Literal('GUEST'),
});

export const PricingPurchasingActorSchema = Schema.Union([PricingPrincipalActorSchema, PricingGuestActorSchema]);
export type PricingPurchasingActor = typeof PricingPurchasingActorSchema.Type;

const PricingOwnerDecisionBindingSchema = Schema.Struct({
  decisionRef: stableReference,
  decisionRevision: stableReference,
});

/**
 * Commerce-issued per-operation context consumed by Pricing. Cart and Storefront identity stay
 * outside the business key; owner decisions bind access, commercial settings, and currency.
 */
export const PricingPurchasingContextSchema = Schema.Struct({
  accessDecision: PricingOwnerDecisionBindingSchema,
  actor: PricingPurchasingActorSchema,
  commercialSettingsDecision: PricingOwnerDecisionBindingSchema,
  contextRef: stableReference,
  contextRevision: PricingContextRevisionSchema,
  currencyResolution: Schema.Struct({
    currencyCode: PricingCurrencyCodeSchema,
    resolutionRef: stableReference,
    resolutionRevision: stableReference,
  }),
  subject: PricingCurrencySubjectSchema,
}).check(
  Schema.makeFilter(({ actor, subject }) => {
    if (subject.kind === 'GUEST') {
      return actor.kind === 'GUEST' &&
        actor.guestEvidenceRef === subject.guestEvidenceRef &&
        actor.guestSessionRef === subject.guestSessionRef
        ? undefined
        : 'Guest purchasing subject and acting Guest context must bind the same owner-issued session evidence';
    }
    return actor.kind === 'PRINCIPAL'
      ? undefined
      : 'Profile purchasing subjects require an authenticated acting Principal';
  }),
);
export type PricingPurchasingContext = typeof PricingPurchasingContextSchema.Type;

const PricingLinesSchema = Schema.Array(PricingLineSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((lines) =>
    new Set(lines.map(({ occurrenceId }) => occurrenceId)).size === lines.length
      ? undefined
      : 'A Pricing Decision must preserve distinct upstream occurrence identities',
  ),
);

/**
 * Canonical whole-candidate Pricing boundary. One-line and multi-line candidates use this same
 * pre-Tax model. Storefront, Tax, Promotion, Availability, Payment, Cart, and Order fields are
 * deliberately absent because they cannot select or become part of Pricing monetary truth.
 */
export const PricingDecisionSchema = Schema.Struct({
  commercialScope: PricingCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  lines: PricingLinesSchema,
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  operationTime: PricingInstantSchema,
  purchasingContext: PricingPurchasingContextSchema,
  tenantId: PricingTenantIdSchema,
}).check(
  Schema.makeFilter(({ currencyCode, lines, purchasingContext, tenantId }) => {
    if (!lines.every(({ catalog }) => catalog.selection.productRef.tenantId === tenantId)) {
      return 'Every Pricing Line must belong to the Pricing Decision Tenant';
    }
    if (purchasingContext.subject.kind === 'PROFILE' && purchasingContext.subject.profileRef.tenantId !== tenantId) {
      return 'The purchasing Profile must belong to the Pricing Decision Tenant';
    }
    return purchasingContext.currencyResolution.currencyCode === currencyCode
      ? undefined
      : 'The Pricing Decision currency must equal the owner-resolved purchase currency';
  }),
);
export type PricingDecision = typeof PricingDecisionSchema.Type;

const nonNegativeDecimalPattern = /^(?:0(?:\.\d+)?|[1-9]\d*(?:\.\d+)?)$/u;
const strictlyNegativeDecimalPattern = /^-(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d+)?)$/u;

export const PricingNonNegativeDecimalSchema = Schema.String.check(Schema.isPattern(nonNegativeDecimalPattern));
export const PricingStrictlyNegativeDecimalSchema = Schema.String.check(
  Schema.isPattern(strictlyNegativeDecimalPattern),
);
export const PricingNonPositiveDecimalSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    if (nonNegativeDecimalPattern.test(value) && /^0(?:\.0+)?$/u.test(value)) {
      return [];
    }
    return strictlyNegativeDecimalPattern.test(value) ? undefined : 'Expected zero or a negative canonical decimal';
  }),
);

export const PricingPercentageSchema = Schema.String.check(
  Schema.isPattern(/^(?:0(?:\.\d+)?|[1-9]\d?(?:\.\d+)?|100(?:\.0+)?)$/u),
);

const PricingCompletenessEvidenceSchema = Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema);

const PricingNonNegativeMoneySchema = Schema.Struct({
  amount: PricingNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});

const PricingStrictlyNegativeMoneySchema = Schema.Struct({
  amount: PricingStrictlyNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});

const PricingCandidateIdentitySchema = Schema.Struct({
  candidateRef: stableReference,
  occurrenceIds: Schema.Array(PricingPurchaseDemandOccurrenceIdSchema).check(
    Schema.isMinLength(1),
    Schema.makeFilter((ids) =>
      new Set(ids).size === ids.length ? undefined : 'Candidate occurrence identities must be distinct',
    ),
  ),
});

const PricingNoGroupSelectorSchema = Schema.Struct({ kind: Schema.Literal('NO_GROUP') });
const PricingAssignedGroupSelectorSchema = Schema.Struct({
  kind: Schema.Literal('ASSIGNED_GROUP'),
  priceGroupRef: stableReference,
});

/** Every Price lookup axis is explicit; Storefront and Product-only fallback cannot enter this key. */
export const PricingExactPriceKeySchema = Schema.Struct({
  commercialScope: PricingCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  exactPredicateRef: stableReference,
  groupSelector: Schema.Union([PricingNoGroupSelectorSchema, PricingAssignedGroupSelectorSchema]),
  pricingBasis: PricingUnitBasisSchema,
  selection: PricingCatalogSelectionSchema,
});
export type PricingExactPriceKey = typeof PricingExactPriceKeySchema.Type;

const PricingResolvedExactKeySchema = Schema.Struct({
  completenessEvidence: PricingCompletenessEvidenceSchema,
  exactKey: PricingExactPriceKeySchema,
  priceRef: stableReference,
  priceRevision: stableReference,
});

const PricingAbsentExactKeySchema = Schema.Struct({
  absenceEvidence: PricingCompletenessEvidenceSchema,
  exactKey: PricingExactPriceKeySchema,
});

const PricingNoGroupResolvedSchema = Schema.Struct({
  ...PricingResolvedExactKeySchema.fields,
  kind: Schema.Literal('NO_GROUP_RESOLVED'),
}).check(
  Schema.makeFilter(({ exactKey }) =>
    exactKey.groupSelector.kind === 'NO_GROUP' ? undefined : 'No-group resolution requires a no-group exact key',
  ),
);

const PricingAssignedGroupResolvedSchema = Schema.Struct({
  ...PricingResolvedExactKeySchema.fields,
  kind: Schema.Literal('ASSIGNED_GROUP_RESOLVED'),
}).check(
  Schema.makeFilter(({ exactKey }) =>
    exactKey.groupSelector.kind === 'ASSIGNED_GROUP'
      ? undefined
      : 'Assigned-group resolution requires an assigned-group exact key',
  ),
);

const PricingAssignedGroupFallbackResolvedSchema = Schema.Struct({
  assignedGroupAttempt: PricingAbsentExactKeySchema,
  kind: Schema.Literal('ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_RESOLVED'),
  noGroupResolution: PricingResolvedExactKeySchema,
}).check(
  Schema.makeFilter(({ assignedGroupAttempt, noGroupResolution }) =>
    assignedGroupAttempt.exactKey.groupSelector.kind === 'ASSIGNED_GROUP' &&
    noGroupResolution.exactKey.groupSelector.kind === 'NO_GROUP'
      ? undefined
      : 'Assigned-group fallback must preserve separate assigned-group and no-group exact keys',
  ),
);

const PricingExactLookupResolvedSchema = Schema.Union([
  PricingNoGroupResolvedSchema,
  PricingAssignedGroupResolvedSchema,
  PricingAssignedGroupFallbackResolvedSchema,
]);

const PricingContributionCalculationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('FIXED') }),
  Schema.Struct({ kind: Schema.Literal('PERCENTAGE'), percentage: PricingPercentageSchema }),
]);
const PricingContributionScopeSchema = Schema.Literals(['LINE', 'WHOLE_CANDIDATE']);

const PricingFeeContributionSchema = Schema.Struct({
  amount: PricingNonNegativeMoneySchema,
  calculation: PricingContributionCalculationSchema,
  completenessEvidence: PricingCompletenessEvidenceSchema,
  effect: Schema.Literal('FEE'),
  scope: PricingContributionScopeSchema,
  sourceRef: stableReference,
  sourceRevision: stableReference,
  status: Schema.Literal('APPLIED'),
});

const PricingDiscountContributionSchema = Schema.Struct({
  amount: Schema.Struct({
    amount: PricingNonPositiveDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  calculation: PricingContributionCalculationSchema,
  completenessEvidence: PricingCompletenessEvidenceSchema,
  effect: Schema.Literals(['CONTRACTUAL_DISCOUNT', 'PROMOTION']),
  scope: PricingContributionScopeSchema,
  sourceRef: stableReference,
  sourceRevision: stableReference,
  status: Schema.Literal('APPLIED'),
});

const PricingWholePurchaseDiscountNotApplicableSchema = Schema.Struct({
  amount: Schema.Struct({ amount: Schema.Literal('0'), currencyCode: PricingCurrencyCodeSchema }),
  completenessEvidence: PricingCompletenessEvidenceSchema,
  effect: Schema.Literal('CONTRACTUAL_DISCOUNT'),
  reason: Schema.Literals(['NO_POSITIVE_ELIGIBLE_BASIS', 'ELIGIBLE_BASIS_NOT_GREATER_THAN_FIXED_AMOUNT']),
  scope: Schema.Literal('WHOLE_CANDIDATE'),
  sourceRef: stableReference,
  sourceRevision: stableReference,
  status: Schema.Literal('NOT_APPLICABLE'),
});

const PricingContributionAssessmentSchema = Schema.Union([
  PricingFeeContributionSchema,
  PricingDiscountContributionSchema,
  PricingWholePurchaseDiscountNotApplicableSchema,
]);

const PricingTierContributionSchema = Schema.Struct({
  amount: PricingNonNegativeMoneySchema,
  completenessEvidence: PricingCompletenessEvidenceSchema,
  tierRef: stableReference,
  tierRevision: stableReference,
});

const PricingNoFloorGuardSchema = Schema.Struct({
  floorDelta: Schema.Struct({ amount: Schema.Literal('0'), currencyCode: PricingCurrencyCodeSchema }),
  kind: Schema.Literal('NOT_REQUIRED'),
  rawPreTaxAmount: PricingNonNegativeMoneySchema,
});

export const PricingAuthorizedZeroFloorGuardSchema = Schema.Struct({
  authorization: Schema.Struct({
    commercialScope: PricingCommercialScopeSchema,
    completenessEvidence: PricingCompletenessEvidenceSchema,
    economicEnvelope: Schema.Struct({
      currencyCode: PricingCurrencyCodeSchema,
      maximumRawAmount: Schema.Literal('0'),
      minimumRawAmount: PricingStrictlyNegativeDecimalSchema,
    }),
    effectivePeriod: Schema.Struct({
      endsAt: Schema.optionalKey(PricingInstantSchema),
      startsAt: PricingInstantSchema,
    }),
    pricingBasis: PricingUnitBasisSchema,
    selection: PricingCatalogSelectionSchema,
    zeroFloorRef: stableReference,
    zeroFloorRevision: stableReference,
  }),
  floorDelta: PricingNonNegativeMoneySchema.check(
    Schema.makeFilter(({ amount }) =>
      amount === '0' || /^0\.0+$/u.test(amount) ? 'Floor delta must be positive' : undefined,
    ),
  ),
  kind: Schema.Literal('AUTHORIZED_ZERO_FLOOR'),
  rawPreTaxAmount: PricingStrictlyNegativeMoneySchema,
});
export type PricingAuthorizedZeroFloorGuard = typeof PricingAuthorizedZeroFloorGuardSchema.Type;

const PricingFloorGuardSchema = Schema.Union([PricingNoFloorGuardSchema, PricingAuthorizedZeroFloorGuardSchema]);

const PricingResolvedLineSchema = Schema.Struct({
  contributionAssessments: Schema.Array(PricingContributionAssessmentSchema),
  finalPreTaxAmount: PricingNonNegativeMoneySchema,
  floorGuard: PricingFloorGuardSchema,
  input: PricingLineSchema,
  lookup: PricingExactLookupResolvedSchema,
  preRoundedPreTaxAmount: PricingNonNegativeMoneySchema,
  tierContributions: Schema.Array(PricingTierContributionSchema),
  unitPrice: PricingNonNegativeMoneySchema,
});

export const PricingMaterialCurrentBindingSchema = Schema.Struct({
  completenessEvidence: PricingCompletenessEvidenceSchema,
  exactPredicateRef: stableReference,
  identityRef: stableReference,
  kind: Schema.Literals([
    'CATALOG_HANDOFF',
    'CATALOG_HIERARCHY',
    'PRICE',
    'TIER',
    'CONTRIBUTION',
    'ABSENCE',
    'CURRENCY_SUPPORT',
    'ZERO_FLOOR',
  ]),
  revisionRef: stableReference,
}).check(
  Schema.makeFilter((binding) => {
    if (binding.completenessEvidence.scope.predicateRef !== binding.exactPredicateRef) {
      return 'Material binding predicate must equal its owner completeness predicate';
    }
    if (
      binding.kind === 'CATALOG_HANDOFF' ||
      binding.kind === 'ABSENCE' ||
      binding.kind === 'CURRENCY_SUPPORT' ||
      binding.kind === 'ZERO_FLOOR'
    ) {
      return binding.completenessEvidence.ownerRevision === binding.revisionRef
        ? undefined
        : 'Owner-revision material binding must equal its owner completeness revision';
    }
    return [];
  }),
);
export type PricingMaterialCurrentBinding = typeof PricingMaterialCurrentBindingSchema.Type;

const PricingDecisionProofSchema = Schema.Struct({
  currencySupport: CurrentSupportedCurrenciesSuccessSchema,
  currentness: Schema.Struct({
    materialBindings: Schema.Array(PricingMaterialCurrentBindingSchema).check(
      Schema.isMinLength(1),
      Schema.makeFilter((bindings) => {
        const currentSlots = bindings.map(({ exactPredicateRef, identityRef, kind }) =>
          kind === 'PRICE' || kind === 'ABSENCE'
            ? `PRICE_OR_ABSENCE\u0000${exactPredicateRef}`
            : `${kind}\u0000${identityRef}\u0000${exactPredicateRef}`,
        );
        return new Set(currentSlots).size === currentSlots.length
          ? undefined
          : 'Multiple truths occupy one Current material slot; this is a Pricing conflict';
      }),
    ),
    status: Schema.Literal('CURRENT'),
    verifiedAt: PricingInstantSchema,
  }),
  effectiveAt: PricingInstantSchema,
  observedAt: PricingInstantSchema,
});

const decimalParts = (value: string): readonly [bigint, number] => {
  const [whole = '0', fractional = ''] = value.split('.');
  return [BigInt(`${whole}${fractional}`), fractional.length];
};

const decimalEqualsSum = (total: string, parts: readonly string[]): boolean => {
  const parsed = [total, ...parts].map(decimalParts);
  const scale = Math.max(...parsed.map(([, decimalPlaces]) => decimalPlaces));
  const scaled = parsed.map(([integer, decimalPlaces]) => integer * 10n ** BigInt(scale - decimalPlaces));
  return scaled[0] === scaled.slice(1).reduce((sum, value) => sum + value, 0n);
};

const compareDecimals = (left: string, right: string): number => {
  const [leftInteger, leftPlaces] = decimalParts(left);
  const [rightInteger, rightPlaces] = decimalParts(right);
  const scale = Math.max(leftPlaces, rightPlaces);
  const scaledLeft = leftInteger * 10n ** BigInt(scale - leftPlaces);
  const scaledRight = rightInteger * 10n ** BigInt(scale - rightPlaces);
  if (scaledLeft < scaledRight) {
    return -1;
  }
  return scaledLeft > scaledRight ? 1 : 0;
};

const isCzkHalfUpResult = (preRounded: string, rounded: string): boolean => {
  const [preRoundedInteger, preRoundedPlaces] = decimalParts(preRounded);
  const [roundedInteger, roundedPlaces] = decimalParts(rounded);
  if (roundedPlaces > 2) {
    return false;
  }
  const roundedCents = roundedInteger * 10n ** BigInt(2 - roundedPlaces);
  if (preRoundedPlaces <= 2) {
    return roundedCents === preRoundedInteger * 10n ** BigInt(2 - preRoundedPlaces);
  }
  const divisor = 10n ** BigInt(preRoundedPlaces - 2);
  const quotient = preRoundedInteger / divisor;
  const remainder = preRoundedInteger % divisor;
  return roundedCents === quotient + (remainder * 2n >= divisor ? 1n : 0n);
};

const catalogSelectionEquivalence = Schema.toEquivalence(PricingCatalogSelectionSchema);
const pricingLineEquivalence = Schema.toEquivalence(PricingLineSchema);
const pricingCommercialScopeEquivalence = Schema.toEquivalence(PricingCommercialScopeSchema);
const pricingUnitBasisEquivalence = Schema.toEquivalence(PricingUnitBasisSchema);

const catalogSelectionsAgree = (left: PricingCatalogSelection, right: PricingCatalogSelection): boolean =>
  catalogSelectionEquivalence(left, right);

const exactKeyMatchesLine = (exactKey: PricingExactPriceKey, line: PricingLine): boolean =>
  catalogSelectionsAgree(exactKey.selection, line.catalog.selection) &&
  exactKey.pricingBasis.quantity === line.pricingBasis.quantity &&
  sameCatalogRef(exactKey.pricingBasis.unitRef, line.pricingBasis.unitRef);

const linesAgree = (left: PricingLine, right: PricingLine): boolean => pricingLineEquivalence(left, right);

const exactKeysDifferOnlyByGroup = (left: PricingExactPriceKey, right: PricingExactPriceKey): boolean =>
  pricingCommercialScopeEquivalence(left.commercialScope, right.commercialScope) &&
  left.currencyCode === right.currencyCode &&
  pricingUnitBasisEquivalence(left.pricingBasis, right.pricingBasis) &&
  catalogSelectionsAgree(left.selection, right.selection);

const resolvedLookupKey = (lookup: typeof PricingExactLookupResolvedSchema.Type): PricingExactPriceKey =>
  lookup.kind === 'ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_RESOLVED' ? lookup.noGroupResolution.exactKey : lookup.exactKey;

const resolvedLookupAllowedForSubject = (
  decision: PricingDecision,
  lookup: typeof PricingExactLookupResolvedSchema.Type,
): boolean => decision.purchasingContext.subject.kind !== 'GUEST' || lookup.kind === 'NO_GROUP_RESOLVED';

const materialBindingEquivalence = Schema.toEquivalence(PricingMaterialCurrentBindingSchema);

const proofHasMaterialBinding = (
  proof: typeof PricingDecisionProofSchema.Type,
  binding: PricingMaterialCurrentBinding,
): boolean => proof.currentness.materialBindings.some((candidate) => materialBindingEquivalence(candidate, binding));

const materialBinding = (
  kind: PricingMaterialCurrentBinding['kind'],
  identityRef: string,
  revisionRef: string,
  exactPredicateRef: string,
  completenessEvidence: typeof PricingCompletenessEvidenceSchema.Type,
): PricingMaterialCurrentBinding => ({
  completenessEvidence,
  exactPredicateRef,
  identityRef,
  kind,
  revisionRef,
});

const proofBindsAbsence = (
  proof: typeof PricingDecisionProofSchema.Type,
  absence: typeof PricingAbsentExactKeySchema.Type,
): boolean =>
  absence.absenceEvidence.scope.predicateRef === absence.exactKey.exactPredicateRef &&
  proofHasMaterialBinding(
    proof,
    materialBinding(
      'ABSENCE',
      absence.exactKey.exactPredicateRef,
      absence.absenceEvidence.ownerRevision,
      absence.exactKey.exactPredicateRef,
      absence.absenceEvidence,
    ),
  );

const proofBindsPrice = (
  proof: typeof PricingDecisionProofSchema.Type,
  price: typeof PricingResolvedExactKeySchema.Type,
): boolean =>
  price.completenessEvidence.scope.predicateRef === price.exactKey.exactPredicateRef &&
  proofHasMaterialBinding(
    proof,
    materialBinding(
      'PRICE',
      price.priceRef,
      price.priceRevision,
      price.exactKey.exactPredicateRef,
      price.completenessEvidence,
    ),
  );

const proofBindsResolvedLookup = (
  proof: typeof PricingDecisionProofSchema.Type,
  lookup: typeof PricingExactLookupResolvedSchema.Type,
): boolean => {
  if (lookup.kind === 'ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_RESOLVED') {
    return (
      exactKeysDifferOnlyByGroup(lookup.assignedGroupAttempt.exactKey, lookup.noGroupResolution.exactKey) &&
      lookup.assignedGroupAttempt.exactKey.exactPredicateRef !== lookup.noGroupResolution.exactKey.exactPredicateRef &&
      lookup.assignedGroupAttempt.absenceEvidence.scope.predicateRef ===
        lookup.assignedGroupAttempt.exactKey.exactPredicateRef &&
      lookup.noGroupResolution.completenessEvidence.scope.predicateRef ===
        lookup.noGroupResolution.exactKey.exactPredicateRef &&
      proofBindsAbsence(proof, lookup.assignedGroupAttempt) &&
      proofBindsPrice(proof, lookup.noGroupResolution)
    );
  }
  return (
    lookup.completenessEvidence.scope.predicateRef === lookup.exactKey.exactPredicateRef &&
    proofBindsPrice(proof, lookup)
  );
};

const resolvedLineMatchesDecision = (
  decision: PricingDecision,
  line: typeof PricingResolvedLineSchema.Type,
): boolean => {
  const exactKey = resolvedLookupKey(line.lookup);
  return (
    exactKey.currencyCode === decision.currencyCode &&
    exactKey.commercialScope.channelId === decision.commercialScope.channelId &&
    exactKey.commercialScope.marketId === decision.commercialScope.marketId &&
    exactKey.commercialScope.sellingLegalEntityId === decision.commercialScope.sellingLegalEntityId &&
    resolvedLookupAllowedForSubject(decision, line.lookup) &&
    exactKeyMatchesLine(exactKey, line.input)
  );
};

const currenciesAgree = (currencyCode: string, line: typeof PricingResolvedLineSchema.Type): boolean => {
  const amounts = [
    line.unitPrice,
    line.preRoundedPreTaxAmount,
    line.finalPreTaxAmount,
    line.floorGuard.rawPreTaxAmount,
    line.floorGuard.floorDelta,
    ...line.tierContributions.map(({ amount }) => amount),
    ...line.contributionAssessments.map(({ amount }) => amount),
  ];
  return amounts.every((amount) => amount.currencyCode === currencyCode);
};

const floorGuardIsCoherent = (
  decision: PricingDecision,
  proof: typeof PricingDecisionProofSchema.Type,
  line: typeof PricingResolvedLineSchema.Type,
): boolean => {
  if (
    !decimalEqualsSum(line.preRoundedPreTaxAmount.amount, [
      line.floorGuard.rawPreTaxAmount.amount,
      line.floorGuard.floorDelta.amount,
    ])
  ) {
    return false;
  }
  if (line.floorGuard.kind === 'NOT_REQUIRED') {
    return true;
  }
  const { authorization } = line.floorGuard;
  return (
    /^0(?:\.0+)?$/u.test(line.preRoundedPreTaxAmount.amount) &&
    /^0(?:\.0+)?$/u.test(line.finalPreTaxAmount.amount) &&
    pricingCommercialScopeEquivalence(authorization.commercialScope, decision.commercialScope) &&
    catalogSelectionsAgree(authorization.selection, line.input.catalog.selection) &&
    pricingUnitBasisEquivalence(authorization.pricingBasis, line.input.pricingBasis) &&
    authorization.economicEnvelope.currencyCode === decision.currencyCode &&
    compareDecimals(line.floorGuard.rawPreTaxAmount.amount, authorization.economicEnvelope.minimumRawAmount) >= 0 &&
    authorization.effectivePeriod.startsAt <= decision.operationTime &&
    (authorization.effectivePeriod.endsAt === undefined ||
      decision.operationTime < authorization.effectivePeriod.endsAt) &&
    proofHasMaterialBinding(
      proof,
      materialBinding(
        'ZERO_FLOOR',
        authorization.zeroFloorRef,
        authorization.zeroFloorRevision,
        authorization.completenessEvidence.scope.predicateRef,
        authorization.completenessEvidence,
      ),
    )
  );
};

const proofBindsLineMaterials = (
  proof: typeof PricingDecisionProofSchema.Type,
  line: typeof PricingResolvedLineSchema.Type,
): boolean => {
  const catalogCompleteness = line.input.catalog.completeness;
  return (
    proofHasMaterialBinding(
      proof,
      materialBinding(
        'CATALOG_HANDOFF',
        line.input.occurrenceId,
        line.input.catalog.ownerRevision,
        catalogCompleteness.scope.predicateRef,
        catalogCompleteness,
      ),
    ) &&
    proofHasMaterialBinding(
      proof,
      materialBinding(
        'CATALOG_HIERARCHY',
        line.input.occurrenceId,
        line.input.catalog.hierarchyRevision,
        catalogCompleteness.scope.predicateRef,
        catalogCompleteness,
      ),
    ) &&
    proofBindsResolvedLookup(proof, line.lookup) &&
    line.tierContributions.every(({ completenessEvidence, tierRef, tierRevision }) =>
      proofHasMaterialBinding(
        proof,
        materialBinding('TIER', tierRef, tierRevision, completenessEvidence.scope.predicateRef, completenessEvidence),
      ),
    ) &&
    line.contributionAssessments.every(({ completenessEvidence, sourceRef, sourceRevision }) =>
      proofHasMaterialBinding(
        proof,
        materialBinding(
          'CONTRIBUTION',
          sourceRef,
          sourceRevision,
          completenessEvidence.scope.predicateRef,
          completenessEvidence,
        ),
      ),
    )
  );
};

const proofBindsCurrencySupport = (proof: typeof PricingDecisionProofSchema.Type, decision: PricingDecision): boolean =>
  proof.currencySupport.effectiveAt === decision.operationTime &&
  proof.currencySupport.supportedCurrencies.includes(decision.currencyCode) &&
  proofHasMaterialBinding(
    proof,
    materialBinding(
      'CURRENCY_SUPPORT',
      decision.tenantId,
      proof.currencySupport.supportRevisionRef.resourceId,
      proof.currencySupport.completenessEvidence.scope.predicateRef,
      proof.currencySupport.completenessEvidence,
    ),
  );

export const PricingPriceResolvedSchema = Schema.Struct({
  decision: PricingDecisionSchema,
  outcome: Schema.Literal('PRICE_RESOLVED'),
  proof: PricingDecisionProofSchema,
  result: Schema.Struct({
    currencyCode: PricingCurrencyCodeSchema,
    lines: Schema.Array(PricingResolvedLineSchema).check(Schema.isMinLength(1)),
    monetaryBoundary: Schema.Literal('PRE_TAX'),
    rounding: Schema.Struct({
      increment: PricingPositiveDecimalSchema,
      mode: Schema.Literal('HALF_UP'),
    }),
    total: PricingNonNegativeMoneySchema,
    totalMethod: Schema.Literal('EXACT_SUM_OF_ROUNDED_LINES'),
  }),
}).check(
  Schema.makeFilter(({ decision, proof, result }) => {
    if (proof.effectiveAt !== decision.operationTime) {
      return 'Decision proof must apply at the operation instant';
    }
    if (!proofBindsCurrencySupport(proof, decision)) {
      return 'Decision currency must be proven supported at the operation instant';
    }
    if (result.currencyCode !== decision.currencyCode || result.total.currencyCode !== decision.currencyCode) {
      return 'Every resolved monetary value must use the Decision currency';
    }
    if (decision.currencyCode === 'CZK' && result.rounding.increment !== '0.01') {
      return 'CZK Decision results require HALF_UP rounding to 0.01';
    }
    if (result.lines.length !== decision.lines.length) {
      return 'Resolved result must preserve candidate cardinality';
    }
    for (let index = 0; index < decision.lines.length; index += 1) {
      const input = decision.lines[index];
      const resolved = result.lines[index];
      if (
        input === undefined ||
        resolved === undefined ||
        !linesAgree(input, resolved.input) ||
        !resolvedLineMatchesDecision(decision, resolved) ||
        !currenciesAgree(decision.currencyCode, resolved) ||
        !floorGuardIsCoherent(decision, proof, resolved) ||
        !proofBindsLineMaterials(proof, resolved) ||
        (decision.currencyCode === 'CZK' &&
          !isCzkHalfUpResult(resolved.preRoundedPreTaxAmount.amount, resolved.finalPreTaxAmount.amount))
      ) {
        return 'Resolved lines must preserve the exact ordered candidate and lookup axes';
      }
    }
    return decimalEqualsSum(
      result.total.amount,
      result.lines.map(({ finalPreTaxAmount }) => finalPreTaxAmount.amount),
    )
      ? undefined
      : 'Decision total must equal the exact sum of final rounded line amounts';
  }),
);
export type PricingPriceResolved = typeof PricingPriceResolvedSchema.Type;

const PricingNoGroupAbsentSchema = Schema.Struct({
  ...PricingAbsentExactKeySchema.fields,
  kind: Schema.Literal('NO_GROUP_ABSENT'),
}).check(
  Schema.makeFilter(({ exactKey }) =>
    exactKey.groupSelector.kind === 'NO_GROUP' ? undefined : 'No-group absence requires a no-group exact key',
  ),
);

const PricingAssignedGroupFallbackAbsentSchema = Schema.Struct({
  assignedGroupAttempt: PricingAbsentExactKeySchema,
  kind: Schema.Literal('ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_ABSENT'),
  noGroupAttempt: PricingAbsentExactKeySchema,
}).check(
  Schema.makeFilter(({ assignedGroupAttempt, noGroupAttempt }) =>
    assignedGroupAttempt.exactKey.groupSelector.kind === 'ASSIGNED_GROUP' &&
    noGroupAttempt.exactKey.groupSelector.kind === 'NO_GROUP'
      ? undefined
      : 'Assigned-group no-price proof requires separate assigned-group and no-group absence keys',
  ),
);

const PricingExactLookupAbsentSchema = Schema.Union([
  PricingNoGroupAbsentSchema,
  PricingAssignedGroupFallbackAbsentSchema,
]);

const PricingLookupAssessmentSchema = Schema.Union([
  Schema.Struct({
    lookup: PricingExactLookupResolvedSchema,
    occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
    status: Schema.Literal('RESOLVED'),
  }),
  Schema.Struct({
    lookup: PricingExactLookupAbsentSchema,
    occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
    status: Schema.Literal('ABSENT'),
  }),
]);

const absentLookupKey = (lookup: typeof PricingExactLookupAbsentSchema.Type): PricingExactPriceKey =>
  lookup.kind === 'ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_ABSENT' ? lookup.noGroupAttempt.exactKey : lookup.exactKey;

const absentLookupAllowedForSubject = (
  decision: PricingDecision,
  lookup: typeof PricingExactLookupAbsentSchema.Type,
): boolean => decision.purchasingContext.subject.kind !== 'GUEST' || lookup.kind === 'NO_GROUP_ABSENT';

const proofBindsAbsentLookup = (
  proof: typeof PricingDecisionProofSchema.Type,
  lookup: typeof PricingExactLookupAbsentSchema.Type,
): boolean => {
  if (lookup.kind === 'ASSIGNED_GROUP_ABSENT_THEN_NO_GROUP_ABSENT') {
    return (
      exactKeysDifferOnlyByGroup(lookup.assignedGroupAttempt.exactKey, lookup.noGroupAttempt.exactKey) &&
      lookup.assignedGroupAttempt.exactKey.exactPredicateRef !== lookup.noGroupAttempt.exactKey.exactPredicateRef &&
      lookup.assignedGroupAttempt.absenceEvidence.scope.predicateRef ===
        lookup.assignedGroupAttempt.exactKey.exactPredicateRef &&
      lookup.noGroupAttempt.absenceEvidence.scope.predicateRef === lookup.noGroupAttempt.exactKey.exactPredicateRef &&
      proofBindsAbsence(proof, lookup.assignedGroupAttempt) &&
      proofBindsAbsence(proof, lookup.noGroupAttempt)
    );
  }
  return (
    lookup.absenceEvidence.scope.predicateRef === lookup.exactKey.exactPredicateRef && proofBindsAbsence(proof, lookup)
  );
};

export const PricingNoApplicablePriceSchema = Schema.Struct({
  decision: PricingDecisionSchema,
  lookups: Schema.Array(PricingLookupAssessmentSchema).check(Schema.isMinLength(1)),
  outcome: Schema.Literal('NO_APPLICABLE_PRICE'),
  proof: PricingDecisionProofSchema,
}).check(
  Schema.makeFilter(({ decision, lookups, proof }) =>
    proof.effectiveAt === decision.operationTime &&
    proofBindsCurrencySupport(proof, decision) &&
    lookups.length === decision.lines.length &&
    lookups.some(({ status }) => status === 'ABSENT') &&
    lookups.every((lookup, index) => {
      const line = decision.lines[index];
      const exactKey = lookup.status === 'RESOLVED' ? resolvedLookupKey(lookup.lookup) : absentLookupKey(lookup.lookup);
      return (
        line !== undefined &&
        lookup.occurrenceId === line.occurrenceId &&
        exactKey.currencyCode === decision.currencyCode &&
        exactKey.commercialScope.channelId === decision.commercialScope.channelId &&
        exactKey.commercialScope.marketId === decision.commercialScope.marketId &&
        exactKey.commercialScope.sellingLegalEntityId === decision.commercialScope.sellingLegalEntityId &&
        exactKeyMatchesLine(exactKey, line) &&
        (lookup.status === 'RESOLVED'
          ? resolvedLookupAllowedForSubject(decision, lookup.lookup)
          : absentLookupAllowedForSubject(decision, lookup.lookup)) &&
        proofHasMaterialBinding(
          proof,
          materialBinding(
            'CATALOG_HANDOFF',
            line.occurrenceId,
            line.catalog.ownerRevision,
            line.catalog.completeness.scope.predicateRef,
            line.catalog.completeness,
          ),
        ) &&
        proofHasMaterialBinding(
          proof,
          materialBinding(
            'CATALOG_HIERARCHY',
            line.occurrenceId,
            line.catalog.hierarchyRevision,
            line.catalog.completeness.scope.predicateRef,
            line.catalog.completeness,
          ),
        ) &&
        (lookup.status === 'RESOLVED'
          ? proofBindsResolvedLookup(proof, lookup.lookup)
          : proofBindsAbsentLookup(proof, lookup.lookup))
      );
    })
      ? undefined
      : 'No-price proof must cover every exact candidate lookup at the Decision instant',
  ),
);
export type PricingNoApplicablePrice = typeof PricingNoApplicablePriceSchema.Type;

const PricingConfigurationReasonSchema = Schema.Literals([
  'INVALID_DECISION_INPUT',
  'MISSING_EXACT_VARIANT',
  'MISSING_COMMERCIAL_SCOPE',
  'MISSING_PURCHASING_SUBJECT',
  'ACTOR_SUBJECT_MISMATCH',
  'PURCHASING_CONTEXT_INVALID',
  'UNSUPPORTED_CURRENCY',
  'CURRENCY_SUPPORT_NOT_INITIALIZED',
  'UNSUPPORTED_PRICING_BASIS',
  'INVALID_CONTRIBUTION_EFFECT',
  'INVALID_SIGN_OR_RANGE',
  'INVALID_CANONICAL_CONFIGURATION',
  'UNAUTHORIZED_RAW_NEGATIVE_RESULT',
  'ZERO_FLOOR_SCOPE_MISMATCH',
  'ZERO_FLOOR_ECONOMIC_ENVELOPE_MISMATCH',
  'GROSS_ONLY_PRICE_UNUSABLE',
]);

export const PricingConfigurationErrorSchema = Schema.Struct({
  candidate: PricingCandidateIdentitySchema,
  outcome: Schema.Literal('PRICING_CONFIGURATION_ERROR'),
  reasonCode: PricingConfigurationReasonSchema,
  retryable: Schema.Literal(false),
});

const PricingConflictReasonSchema = Schema.Literals([
  'COMPETING_CURRENT_EXACT_PRICES',
  'COMPETING_CURRENT_CURRENCY_SUPPORT',
  'OVERLAPPING_CONTRACTUAL_DISCOUNT_REVISIONS',
  'CANONICAL_STATE_CONFLICT',
]);

export const PricingConflictSchema = Schema.Struct({
  candidate: PricingCandidateIdentitySchema,
  currentTruthRefs: Schema.Array(stableReference).check(
    Schema.isMinLength(2),
    Schema.makeFilter((refs) =>
      new Set(refs).size === refs.length ? undefined : 'Conflicting truths must be distinct',
    ),
  ),
  outcome: Schema.Literal('PRICING_CONFLICT'),
  reasonCode: PricingConflictReasonSchema,
  retryable: Schema.Literal(false),
});

const PricingStaleReasonSchema = Schema.Literals([
  'INPUT_REVISION_STALE',
  'PRICE_REVISION_STALE',
  'PROOF_STALE',
  'APPLICABILITY_BOUNDARY_CROSSED',
  'AUTHORIZATION_STALE',
  'PURCHASING_CONTEXT_STALE',
  'SUBJECT_ACCESS_STALE',
  'MATERIAL_INPUT_CHANGED',
]);

export const PricingStaleSchema = Schema.Struct({
  candidate: PricingCandidateIdentitySchema,
  outcome: Schema.Literal('PRICING_STALE'),
  reasonCode: PricingStaleReasonSchema,
  retryable: Schema.Literal(true),
  staleEvidence: Schema.Struct({
    assessedAt: PricingInstantSchema,
    invalidatedAt: PricingInstantSchema,
    invalidatedRevision: stableReference,
  }),
}).check(
  Schema.makeFilter(({ staleEvidence }) =>
    staleEvidence.invalidatedAt > staleEvidence.assessedAt
      ? undefined
      : 'Stale evidence requires a material invalidation after the prior assessment',
  ),
);

const PricingIndeterminateReasonSchema = Schema.Literals([
  'OWNER_STATE_UNAVAILABLE',
  'CURRENTNESS_UNVERIFIABLE',
  'SET_COMPLETENESS_UNVERIFIABLE',
  'EXACT_LOOKUP_UNVERIFIABLE',
  'CURRENCY_SUPPORT_UNAVAILABLE',
  'CURRENCY_SUPPORT_UNVERIFIABLE',
  'PURCHASING_CONTEXT_UNVERIFIABLE',
  'SUBJECT_ACCESS_UNVERIFIABLE',
  'COMMERCIAL_SETTINGS_UNVERIFIABLE',
  'ALLOCATION_UNVERIFIABLE',
  'RETRY_EXHAUSTED',
  'GROSS_ONLY_SOURCE_HELD',
]);

export const PricingIndeterminateSchema = Schema.Struct({
  candidate: PricingCandidateIdentitySchema,
  inabilityEvidence: Schema.Struct({
    attempts: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    requiredOwnerRefs: Schema.Array(stableReference).check(Schema.isMinLength(1)),
  }),
  outcome: Schema.Literal('PRICING_INDETERMINATE'),
  reasonCode: PricingIndeterminateReasonSchema,
  retryable: Schema.Literal(true),
});

/** The closed public vocabulary for a whole-candidate Pricing Decision. */
export const PricingDecisionOutcomeKindSchema = Schema.Literals([
  'PRICE_RESOLVED',
  'NO_APPLICABLE_PRICE',
  'PRICING_CONFIGURATION_ERROR',
  'PRICING_CONFLICT',
  'PRICING_STALE',
  'PRICING_INDETERMINATE',
]);
export type PricingDecisionOutcomeKind = typeof PricingDecisionOutcomeKindSchema.Type;

export const PricingDecisionOutcomeSchema = Schema.Union([
  PricingPriceResolvedSchema,
  PricingNoApplicablePriceSchema,
  PricingConfigurationErrorSchema,
  PricingConflictSchema,
  PricingStaleSchema,
  PricingIndeterminateSchema,
]);
export type PricingDecisionOutcome = typeof PricingDecisionOutcomeSchema.Type;
