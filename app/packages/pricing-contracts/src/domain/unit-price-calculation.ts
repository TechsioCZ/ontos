import { Match, Option, Schema } from 'effect';

import { PricingCurrencyCodeSchema } from '../apis/current-supported-currencies.ts';
import {
  PRICING_ARITHMETIC_PROFILE_VERSION,
  PricingCurrencyMismatchFailure,
  PricingDecimalFormatFailure,
  PricingDecimalOverflowFailure,
  PricingDecimalRangeFailure,
  PricingDecimalScaleFailure,
  PricingExactNonNegativeDecimalSchema,
  PricingUnsupportedProfileFailure,
} from './exact-decimal.ts';
import type { ExactPriceLookupFound } from './exact-price-lookup.ts';
import { ExactPriceFoundResolutionSchema, ExactPriceResolutionSchema } from './exact-price-resolution.ts';
import type { ExactPriceFoundResolution, ExactPriceResolution } from './exact-price-resolution.ts';
import { PriceIdentityKeySchema, PriceRevisionSchema, priceDecimalValuesEqual } from './price-definition.ts';
import { PricingLineSchema, PricingQuantitySchema } from './pricing-decision.ts';
import type { PricingLine } from './pricing-decision.ts';
import {
  QuantityTierNormalizedQuantitySchema,
  QuantityTierQuantityBasisSchema,
  QuantityTierSelectionResultSchema,
  QuantityTierSelectionSuccessSchema,
  quantityTierIdentityKeysEqual,
} from './quantity-tier.ts';
import type {
  QuantityTierNormalizedQuantity,
  QuantityTierSelectionResult,
  QuantityTierSelectionSuccess,
} from './quantity-tier.ts';
import {
  PricingQuantityBasisAssessmentSchema,
  PricingQuantityBasisCompatibleConversionAssessmentSchema,
  PricingQuantityBasisNoConversionAssessmentSchema,
} from './quantity-unit-package-basis.ts';
import type { PricingQuantityBasisAssessment } from './quantity-unit-package-basis.ts';

const sameCatalogHandoff = Schema.toEquivalence(PricingLineSchema.fields.catalog);
const samePriceIdentityKey = Schema.toEquivalence(PriceIdentityKeySchema);
const samePriceRevision = Schema.toEquivalence(PriceRevisionSchema);
const sameQuantityBasis = Schema.toEquivalence(QuantityTierQuantityBasisSchema);

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

export const PricingUnitPriceMoneySchema = Schema.Struct({
  amount: PricingExactNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});
export type PricingUnitPriceMoney = typeof PricingUnitPriceMoneySchema.Type;

const successfulQuantityBasisSchema = Schema.Union([
  PricingQuantityBasisNoConversionAssessmentSchema,
  PricingQuantityBasisCompatibleConversionAssessmentSchema,
]);

/**
 * Material facts available before the calculation gate. Failed owner reads remain representable so
 * callers can return a typed refusal instead of silently falling back to a base Price or another basis.
 */
export interface PricingUnitPriceCalculationAttempt {
  readonly exactPrice: ExactPriceResolution;
  readonly line: PricingLine;
  readonly lineQuantity?: QuantityTierNormalizedQuantity;
  readonly quantityBasis: PricingQuantityBasisAssessment;
  readonly tierSelection: QuantityTierSelectionResult;
}

export const PricingUnitPriceCalculationAttemptSchema: Schema.Codec<PricingUnitPriceCalculationAttempt, unknown> =
  Schema.Struct({
    exactPrice: ExactPriceResolutionSchema,
    line: PricingLineSchema,
    lineQuantity: Schema.optionalKey(QuantityTierNormalizedQuantitySchema),
    quantityBasis: PricingQuantityBasisAssessmentSchema,
    tierSelection: QuantityTierSelectionResultSchema,
  });

interface ReadyInput {
  readonly exactPrice: ExactPriceFoundResolution;
  readonly line: typeof PricingLineSchema.Type;
  readonly lineQuantity: QuantityTierNormalizedQuantity;
  readonly quantityBasis: typeof successfulQuantityBasisSchema.Type;
  readonly tierSelection: QuantityTierSelectionSuccess;
}

const lineQuantityMatchesOwnerEvidence = (input: ReadyInput): boolean => {
  const { evidence, resultingPurchaseQuantity } = input.quantityBasis;
  const directPurchaseToPrice =
    evidence.outcome === 'COMPATIBLE_CONVERSION'
      ? evidence.steps.find(({ from, to }) => from === 'PURCHASE' && to === 'PRICE')
      : undefined;
  const expectedAmount = directPurchaseToPrice?.toQuantity ?? resultingPurchaseQuantity.amount;
  return (
    priceDecimalValuesEqual(input.lineQuantity.quantity, expectedAmount) &&
    sameResourceRef(
      input.lineQuantity.quantityBasis.catalogQuantityBasis.targetRef,
      evidence.endpoints.price.quantityBasis.targetRef,
    ) &&
    sameResourceRef(
      input.lineQuantity.quantityBasis.catalogQuantityBasis.unitRef,
      evidence.endpoints.price.quantityBasis.unitRef,
    ) &&
    input.lineQuantity.quantityBasis.catalogQuantityBasis.targetDivisibilityRevision ===
      evidence.endpoints.price.quantityBasis.targetDivisibilityRevision &&
    input.lineQuantity.quantityBasis.catalogQuantityBasis.unitRuleRevision ===
      evidence.endpoints.price.quantityBasis.unitRuleRevision &&
    sameResourceRef(
      input.lineQuantity.quantityBasis.priceUnitBasis.unitRef,
      input.quantityBasis.attempt.price.identityKey.unitBasis.unitRef,
    ) &&
    priceDecimalValuesEqual(
      input.lineQuantity.quantityBasis.priceUnitBasis.quantity,
      input.quantityBasis.attempt.price.identityKey.unitBasis.quantity,
    )
  );
};

const foundLookupFrom = (input: ReadyInput['exactPrice']): Option.Option<ExactPriceLookupFound> => {
  const { path } = input;
  return Match.value(path).pipe(
    Match.when({ _tag: 'GROUP_PRICE' }, ({ usedPrice }) => Option.some(usedPrice)),
    Match.when({ _tag: 'NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE' }, ({ usedPrice }) => Option.some(usedPrice)),
    Match.when({ _tag: 'NO_GROUP_GUEST' }, ({ usedPrice }) => Option.some(usedPrice)),
    Match.when({ _tag: 'NO_GROUP_NONE' }, ({ usedPrice }) => Option.some(usedPrice)),
    Match.orElse(() => Option.none()),
  );
};

const lineIdentityIsPreserved = (input: ReadyInput): boolean =>
  input.quantityBasis.occurrenceId === input.line.occurrenceId &&
  sameCatalogHandoff(input.quantityBasis.attempt.catalog, input.line.catalog) &&
  priceDecimalValuesEqual(
    input.quantityBasis.resultingPurchaseQuantity.amount,
    input.line.catalog.quantity.resulting,
  ) &&
  sameResourceRef(input.quantityBasis.resultingPurchaseQuantity.unitRef, input.line.catalog.unitRef);

const exactPriceIsPreserved = (input: ReadyInput, usedPrice: ExactPriceLookupFound): boolean => {
  const selectedPrice = input.tierSelection.evidence.input.attempt.exactPrice;
  const quantityPrice = input.quantityBasis.attempt.price;
  return (
    samePriceIdentityKey(usedPrice.request.exactKey, selectedPrice.price.definition.identityKey) &&
    samePriceIdentityKey(usedPrice.request.exactKey, quantityPrice.identityKey) &&
    sameResourceRef(usedPrice.priceRef, selectedPrice.price.definition.priceRef) &&
    sameResourceRef(usedPrice.priceRef, quantityPrice.priceRef) &&
    samePriceRevision(usedPrice.priceRevision, selectedPrice.price.definition.revision) &&
    samePriceRevision(usedPrice.priceRevision, quantityPrice.revision)
  );
};

const tierEvidenceIsPreserved = (input: ReadyInput): boolean => {
  const selectedTier = input.quantityBasis.attempt.tier;
  if (input.tierSelection.outcome === 'BASE_PRICE_RETAINED') {
    return selectedTier === undefined;
  }
  const { decision } = input.tierSelection.evidence;
  if (decision.kind !== 'HIGHEST_REACHED_THRESHOLD') {
    return false;
  }
  const winningTier = decision.winningTier.definition;
  return (
    selectedTier !== undefined &&
    quantityTierIdentityKeysEqual(selectedTier.identityKey, winningTier.identityKey) &&
    selectedTier.revision.revisionId === winningTier.revision.revisionId &&
    selectedTier.revision.revision === winningTier.revision.revision &&
    selectedTier.revision.effectiveFrom === winningTier.revision.effectiveFrom &&
    selectedTier.revision.monetaryBoundary === winningTier.revision.monetaryBoundary &&
    selectedTier.revision.resultingUnitPrice.currencyCode === winningTier.revision.resultingUnitPrice.currencyCode &&
    priceDecimalValuesEqual(
      selectedTier.revision.resultingUnitPrice.amount,
      winningTier.revision.resultingUnitPrice.amount,
    )
  );
};

const readyInputIsCoherent = (input: ReadyInput): string | undefined => {
  const usedPrice = foundLookupFrom(input.exactPrice);
  if (Option.isNone(usedPrice) || !exactPriceIsPreserved(input, usedPrice.value)) {
    return 'Unit Price calculation must use one exact Price identity and Current Revision';
  }
  if (!lineIdentityIsPreserved(input)) {
    return 'Unit Price calculation must preserve the exact original line, occurrence, selection, and resulting purchase Quantity';
  }
  if (
    !sameQuantityBasis(input.lineQuantity.quantityBasis, input.tierSelection.appliesToQuantity.quantityBasis) ||
    !lineQuantityMatchesOwnerEvidence(input)
  ) {
    return 'Line Quantity must be owner-derived in the exact Price Unit basis used for Tier selection';
  }
  if (
    input.exactPrice.path.resolutionInput.effectiveAt !== input.quantityBasis.attempt.effectiveAt ||
    input.quantityBasis.attempt.effectiveAt !== input.tierSelection.evidence.input.attempt.evaluatedAt
  ) {
    return 'Price, Tier, Quantity, and Currency Support evidence must share one trusted evaluation instant';
  }
  return tierEvidenceIsPreserved(input)
    ? undefined
    : 'Tier evidence must preserve either proven no-threshold selection or the exact winning Tier identity, Revision, and threshold';
};

/** Successful owner facts narrowed and cross-bound before arithmetic is permitted. */
export const PricingUnitPriceCalculationReadyInputSchema = Schema.Struct({
  exactPrice: ExactPriceFoundResolutionSchema,
  line: PricingLineSchema,
  lineQuantity: QuantityTierNormalizedQuantitySchema,
  quantityBasis: successfulQuantityBasisSchema,
  tierSelection: QuantityTierSelectionSuccessSchema,
}).check(Schema.makeFilter(readyInputIsCoherent));
export type PricingUnitPriceCalculationReadyInput = typeof PricingUnitPriceCalculationReadyInputSchema.Type;

const decimalParts = (value: string): readonly [coefficient: bigint, scale: number] => {
  const [whole = '0', fraction = ''] = value.split('.');
  return [BigInt(`${whole}${fraction}`), fraction.length];
};

const multiplyForInvariant = (left: string, right: string): string => {
  const [leftCoefficient, leftScale] = decimalParts(left);
  const [rightCoefficient, rightScale] = decimalParts(right);
  const coefficient = leftCoefficient * rightCoefficient;
  let scale = leftScale + rightScale;
  let normalized = coefficient;
  while (scale > 0 && normalized % 10n === 0n) {
    normalized /= 10n;
    scale -= 1;
  }
  if (scale === 0) {
    return normalized.toString();
  }
  const digits = normalized.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
};

const successIsCoherent = (value: {
  readonly arithmeticProfileVersion: typeof PRICING_ARITHMETIC_PROFILE_VERSION;
  readonly baseLineValue: PricingUnitPriceMoney;
  readonly input: PricingUnitPriceCalculationReadyInput;
  readonly resultingQuantity: typeof PricingQuantitySchema.Type;
  readonly unitPrice: PricingUnitPriceMoney;
}): string | undefined => {
  const expectedUnitPrice = value.input.tierSelection.resultingUnitPrice;
  if (
    !priceDecimalValuesEqual(value.unitPrice.amount, expectedUnitPrice.amount) ||
    value.unitPrice.currencyCode !== expectedUnitPrice.currencyCode ||
    value.baseLineValue.currencyCode !== value.unitPrice.currencyCode
  ) {
    return 'Unit Price and Base Line Value must preserve the selected Price/Tier native currency';
  }
  if (
    !priceDecimalValuesEqual(
      value.resultingQuantity.amount,
      value.input.quantityBasis.resultingPurchaseQuantity.amount,
    ) ||
    !sameResourceRef(value.resultingQuantity.unitRef, value.input.quantityBasis.resultingPurchaseQuantity.unitRef)
  ) {
    return 'Unit Price result must preserve the exact owner-issued resulting purchase Quantity and Unit';
  }
  const product = multiplyForInvariant(value.unitPrice.amount, value.input.lineQuantity.quantity);
  return priceDecimalValuesEqual(value.baseLineValue.amount, product)
    ? undefined
    : 'Base Line Value must be the exact Unit Price multiplied by the owner-derived line Quantity without rounding';
};

export const PricingUnitPriceCalculationSuccessSchema = Schema.TaggedStruct('UNIT_PRICE_CALCULATED', {
  arithmeticProfileVersion: Schema.Literal(PRICING_ARITHMETIC_PROFILE_VERSION),
  baseLineValue: PricingUnitPriceMoneySchema,
  input: PricingUnitPriceCalculationReadyInputSchema,
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  resultingQuantity: PricingQuantitySchema,
  unitPrice: PricingUnitPriceMoneySchema,
}).check(Schema.makeFilter(successIsCoherent));
export type PricingUnitPriceCalculationSuccess = typeof PricingUnitPriceCalculationSuccessSchema.Type;

const occurrenceFailureFields = {
  occurrenceId: PricingLineSchema.fields.occurrenceId,
};

export const PricingUnitPriceInvalidReasonSchema = Schema.Literals([
  'NO_APPLICABLE_PRICE',
  'INVALID_EXACT_PRICE',
  'INVALID_TIER_SELECTION',
  'INVALID_QUANTITY_BASIS',
  'LINE_BINDING_INVALID',
]);
export type PricingUnitPriceInvalidReason = typeof PricingUnitPriceInvalidReasonSchema.Type;

export class PricingUnitPriceInvalidFailure extends Schema.TaggedError<PricingUnitPriceInvalidFailure>()(
  'PricingUnitPriceInvalidFailure',
  { ...occurrenceFailureFields, reason: PricingUnitPriceInvalidReasonSchema },
) {}

export class PricingUnitPriceConflictFailure extends Schema.TaggedError<PricingUnitPriceConflictFailure>()(
  'PricingUnitPriceConflictFailure',
  {
    ...occurrenceFailureFields,
    reason: Schema.Literals(['EXACT_PRICE_CONFLICT', 'QUANTITY_TIER_CONFLICT']),
  },
) {}

export class PricingUnitPriceUnavailableFailure extends Schema.TaggedError<PricingUnitPriceUnavailableFailure>()(
  'PricingUnitPriceUnavailableFailure',
  {
    ...occurrenceFailureFields,
    reason: Schema.Literals(['EXACT_PRICE_UNAVAILABLE', 'QUANTITY_TIER_UNAVAILABLE', 'QUANTITY_BASIS_UNAVAILABLE']),
    retryable: Schema.Boolean,
  },
) {}

export class PricingUnitPriceUnverifiableFailure extends Schema.TaggedError<PricingUnitPriceUnverifiableFailure>()(
  'PricingUnitPriceUnverifiableFailure',
  {
    ...occurrenceFailureFields,
    reason: Schema.Literals([
      'EXACT_PRICE_UNVERIFIABLE',
      'QUANTITY_TIER_UNVERIFIABLE',
      'QUANTITY_BASIS_UNVERIFIABLE',
      'CURRENTNESS_UNVERIFIABLE',
      'SET_COMPLETENESS_UNVERIFIABLE',
    ]),
  },
) {}

const PricingUnitPricePrecisionCauseSchema = Schema.Union([
  PricingDecimalFormatFailure,
  PricingDecimalScaleFailure,
  PricingDecimalRangeFailure,
  PricingDecimalOverflowFailure,
  PricingUnsupportedProfileFailure,
]);

export class PricingUnitPricePrecisionFailure extends Schema.TaggedError<PricingUnitPricePrecisionFailure>()(
  'PricingUnitPricePrecisionFailure',
  { ...occurrenceFailureFields, cause: PricingUnitPricePrecisionCauseSchema },
) {}

export class PricingUnitPriceCurrencyFailure extends Schema.TaggedError<PricingUnitPriceCurrencyFailure>()(
  'PricingUnitPriceCurrencyFailure',
  { ...occurrenceFailureFields, cause: PricingCurrencyMismatchFailure },
) {}

export class PricingUnitPriceBasisFailure extends Schema.TaggedError<PricingUnitPriceBasisFailure>()(
  'PricingUnitPriceBasisFailure',
  {
    ...occurrenceFailureFields,
    reason: Schema.Literals([
      'INCOMPATIBLE_QUANTITY_BASIS',
      'PRICE_UNIT_BINDING_MISMATCH',
      'TIER_UNIT_BINDING_MISMATCH',
      'OWNER_CONVERSION_EVIDENCE_MISMATCH',
    ]),
  },
) {}

export const PricingUnitPriceCalculationFailureSchema = Schema.Union([
  PricingUnitPriceInvalidFailure,
  PricingUnitPriceConflictFailure,
  PricingUnitPriceUnavailableFailure,
  PricingUnitPriceUnverifiableFailure,
  PricingUnitPricePrecisionFailure,
  PricingUnitPriceCurrencyFailure,
  PricingUnitPriceBasisFailure,
]);
export type PricingUnitPriceCalculationFailure = typeof PricingUnitPriceCalculationFailureSchema.Type;

export const PricingUnitPriceCalculationResultSchema = Schema.Union([
  PricingUnitPriceCalculationSuccessSchema,
  PricingUnitPriceCalculationFailureSchema,
]);
export type PricingUnitPriceCalculationResult = typeof PricingUnitPriceCalculationResultSchema.Type;
