import { Match, Schema } from 'effect';

import type { PricingCommercialTotalSafeProjection } from './commercial-total.ts';
import { PricingCommercialTotalSafeProjectionSchema } from './commercial-total.ts';
import { PricingInstantSchema } from './currency-support.ts';
import { PricingMaterialChangeClassificationSchema, PricingMaterialSnapshotIdSchema } from './material-change.ts';
import { PricingPurchaseDemandOccurrenceIdSchema } from './pricing-decision.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

const PricingCurrentTermsAuthoritySchema = Schema.Struct({ kind: Schema.Literal('ORDINARY_CURRENT') });
const PricingQuotationTermsAuthoritySchema = Schema.Struct({
  kind: Schema.Literal('VALID_QUOTATION'),
  quotationRef: stableReference,
  quotationValidationRef: stableReference,
  validUntil: PricingInstantSchema,
});

export const PricingProposedTermsSnapshotSchema = Schema.Struct({
  authority: Schema.Union([PricingCurrentTermsAuthoritySchema, PricingQuotationTermsAuthoritySchema]),
  materialSnapshotId: PricingMaterialSnapshotIdSchema,
  result: PricingCommercialTotalSafeProjectionSchema,
  termsRef: stableReference,
});
export type PricingProposedTermsSnapshot = typeof PricingProposedTermsSnapshotSchema.Type;

export const PricingProposedTermsComparisonRequestSchema = Schema.Struct({
  assessedAt: PricingInstantSchema,
  current: PricingProposedTermsSnapshotSchema,
  materialChange: PricingMaterialChangeClassificationSchema,
  previous: PricingProposedTermsSnapshotSchema,
}).check(
  Schema.makeFilter(({ assessedAt, current, materialChange, previous }) => {
    if (
      materialChange.previousSnapshotId !== previous.materialSnapshotId ||
      materialChange.currentSnapshotId !== current.materialSnapshotId
    ) {
      return 'Price reconfirmation must bind the exact previous and current material snapshots';
    }
    return [previous, current].some(
      (terms) => terms.authority.kind === 'VALID_QUOTATION' && assessedAt > terms.authority.validUntil,
    )
      ? 'Only a valid Quotation may remain authoritative proposed Pricing terms'
      : undefined;
  }),
);
export type PricingProposedTermsComparisonRequest = typeof PricingProposedTermsComparisonRequestSchema.Type;

const comparisonBase = {
  currentTermsRef: stableReference,
  previousTermsRef: stableReference,
};

export const PricingReconfirmationNotRequiredSchema = Schema.Struct({
  ...comparisonBase,
  kind: Schema.Literal('PRICING_TERMS_UNCHANGED'),
  reconfirmationRequired: Schema.Literal(false),
});
export const PricingGuaranteedTermsRetainedSchema = Schema.Struct({
  ...comparisonBase,
  authoritativeQuotationRef: stableReference,
  kind: Schema.Literal('GUARANTEED_TERMS_RETAINED'),
  reconfirmationRequired: Schema.Literal(false),
});
export const PricingReconfirmationRequiredSchema = Schema.Struct({
  ...comparisonBase,
  changedOccurrenceIds: Schema.Array(PricingPurchaseDemandOccurrenceIdSchema),
  direction: Schema.Literals(['INCREASED', 'DECREASED', 'MIXED', 'BINDING_CHANGED']),
  kind: Schema.Literal('PRICING_RECONFIRMATION_REQUIRED'),
  reconfirmationRequired: Schema.Literal(true),
});
export const PricingReconfirmationUnverifiableSchema = Schema.Struct({
  ...comparisonBase,
  kind: Schema.Literal('PRICING_RECONFIRMATION_UNVERIFIABLE'),
  reconfirmationRequired: Schema.Literal(false),
  retryable: Schema.Literal(true),
});
export const PricingProposedTermsComparisonSchema = Schema.Union([
  PricingReconfirmationNotRequiredSchema,
  PricingGuaranteedTermsRetainedSchema,
  PricingReconfirmationRequiredSchema,
  PricingReconfirmationUnverifiableSchema,
]);
export type PricingProposedTermsComparison = typeof PricingProposedTermsComparisonSchema.Type;

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (value: string): DecimalParts => {
  const [integer = '0', fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
};

const compareDecimal = (left: string, right: string): number => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftCoefficient = leftParts.coefficient * 10n ** BigInt(scale - leftParts.scale);
  const rightCoefficient = rightParts.coefficient * 10n ** BigInt(scale - rightParts.scale);
  if (leftCoefficient === rightCoefficient) {
    return 0;
  }
  return leftCoefficient > rightCoefficient ? 1 : -1;
};

const linesByOccurrence = (result: PricingCommercialTotalSafeProjection) =>
  new Map(result.lines.map((line) => [line.occurrenceId, line.publishedLineValue.amount] as const));

/** Pricing-owned comparison only; Cart, Approval, Checkout, and Order perform their own PARK-gated adoption. */
export const comparePricingProposedTerms = (
  request: PricingProposedTermsComparisonRequest,
): PricingProposedTermsComparison => {
  const base = { currentTermsRef: request.current.termsRef, previousTermsRef: request.previous.termsRef };
  if (request.previous.authority.kind === 'VALID_QUOTATION' && request.current.authority.kind === 'ORDINARY_CURRENT') {
    return {
      ...base,
      authoritativeQuotationRef: request.previous.authority.quotationRef,
      kind: 'GUARANTEED_TERMS_RETAINED',
      reconfirmationRequired: false,
    };
  }
  const materialChangeIsUnverifiable = Match.value(request.materialChange).pipe(
    Match.tag('UNVERIFIABLE', () => true),
    Match.orElse(() => false),
  );
  if (materialChangeIsUnverifiable) {
    return {
      ...base,
      kind: 'PRICING_RECONFIRMATION_UNVERIFIABLE',
      reconfirmationRequired: false,
      retryable: true,
    };
  }
  const previous = linesByOccurrence(request.previous.result);
  const current = linesByOccurrence(request.current.result);
  const previousOccurrenceIds = [...previous.keys()];
  const currentOccurrenceIds = [...current.keys()];
  const allOccurrenceIds = [...new Set([...previousOccurrenceIds, ...currentOccurrenceIds])];
  const changedOccurrenceIds = allOccurrenceIds.filter(
    (occurrenceId) => previous.get(occurrenceId) !== current.get(occurrenceId),
  );
  const comparisons = changedOccurrenceIds.flatMap((occurrenceId) => {
    const before = previous.get(occurrenceId);
    const after = current.get(occurrenceId);
    return before === undefined || after === undefined ? [] : [compareDecimal(after, before)];
  });
  const bindingChanged =
    Match.value(request.materialChange).pipe(
      Match.tag('MATERIAL_CHANGED', () => true),
      Match.orElse(() => false),
    ) ||
    request.previous.result.currencyCode !== request.current.result.currencyCode ||
    previous.size !== current.size ||
    previousOccurrenceIds.some((occurrenceId, index) => occurrenceId !== currentOccurrenceIds[index]);
  if (changedOccurrenceIds.length === 0 && !bindingChanged) {
    return { ...base, kind: 'PRICING_TERMS_UNCHANGED', reconfirmationRequired: false };
  }
  const hasIncrease = comparisons.some((comparison) => comparison > 0);
  const hasDecrease = comparisons.some((comparison) => comparison < 0);
  let direction: 'BINDING_CHANGED' | 'DECREASED' | 'INCREASED' | 'MIXED' = 'BINDING_CHANGED';
  if (hasIncrease && hasDecrease) {
    direction = 'MIXED';
  } else if (hasIncrease) {
    direction = 'INCREASED';
  } else if (hasDecrease) {
    direction = 'DECREASED';
  }
  return {
    ...base,
    changedOccurrenceIds,
    direction,
    kind: 'PRICING_RECONFIRMATION_REQUIRED',
    reconfirmationRequired: true,
  };
};
