import { Match, Schema } from 'effect';

import { CustomerSafeTaxDecompositionNeedSchema } from './customer-safe-tax-projection.ts';
import {
  PricingResultRefSchema,
  PurchaseDemandOccurrenceIdSchema,
  TaxPurchaseBindingSchema,
  isSameCatalogSelection,
} from './purchase-binding.ts';
import { ShippingSourceObservationSchema } from './shipping-allocation.ts';
import { TaxClassificationInputSchema } from './tax-classification.ts';
import { BoundedIdentifierSchema, distinctBy } from './tax-domain-primitives.ts';
import { NonNegativeTaxExactRationalSchema } from './tax-exact-rational.ts';
import { TaxJurisdictionInputSchema } from './tax-jurisdiction.ts';
import { TaxRelevantTimeSchema } from './tax-time.ts';
import { PublishedPricingLineSchema } from './taxable-basis.ts';

const distinctOccurrenceIds = distinctBy(
  ({ occurrenceId }: Readonly<{ occurrenceId: string }>) => occurrenceId,
  'Each Purchase Demand Occurrence appears once',
);

/** Owner-issued Catalog classification evidence of one exact occurrence (#926 F6, #937 F13). */
const OccurrenceCatalogEvidenceSchema = Schema.Struct({
  classificationInput: TaxClassificationInputSchema,
  occurrenceId: PurchaseDemandOccurrenceIdSchema,
});

/** Explicit Tax legal supply meaning of a Set occurrence; an ordinary occurrence declares none (#934, #920 F25-F30). */
const SetSupplyMeaningDeclarationSchema = Schema.Struct({
  meaning: Schema.Literals(['WHOLE_TREATMENT_SET', 'MULTI_SUPPLY_SET']),
  occurrenceId: PurchaseDemandOccurrenceIdSchema,
});

/**
 * Owner-issued Shipping of the exact purchase with the occurrences it relates to and, when several share it, the
 * explicit owner-approved weights keyed by occurrence; TAX maps them to its own Taxable Supply Units (#933 F12-F18,
 * PO decision D3 default, pending on #907).
 */
const ShippingEvaluationInputSchema = Schema.Struct({
  affectedOccurrenceIds: Schema.NonEmptyArray(PurchaseDemandOccurrenceIdSchema).check(
    distinctBy((occurrenceId: string) => occurrenceId, 'Each affected occurrence appears once'),
  ),
  allocationWeights: Schema.optionalKey(
    Schema.Struct({
      approvalEvidenceRef: BoundedIdentifierSchema,
      weights: Schema.NonEmptyArray(
        Schema.Struct({ occurrenceId: PurchaseDemandOccurrenceIdSchema, weight: NonNegativeTaxExactRationalSchema }),
      ).check(distinctOccurrenceIds),
    }),
  ),
  source: ShippingSourceObservationSchema,
});

/**
 * Prospective Tax evaluation request for one exact purchase at a caller-declared Tax-Relevant Time (#941 F6). Foreign
 * owner facts (Pricing, Catalog, Shipping, places) arrive as owner-issued evidence the server-side caller holds;
 * Tenant and Selling Legal Entity are checked against the trusted Operational Scope, never trusted from here.
 */
export const TaxEvaluationRequestSchema = Schema.Struct({
  catalog: Schema.NonEmptyArray(OccurrenceCatalogEvidenceSchema).check(distinctOccurrenceIds),
  decompositionNeed: CustomerSafeTaxDecompositionNeedSchema,
  places: TaxJurisdictionInputSchema,
  pricing: Schema.Struct({
    pricingResultRef: PricingResultRefSchema,
    publishedLines: Schema.Array(PublishedPricingLineSchema),
  }),
  purchase: TaxPurchaseBindingSchema,
  setSupplyMeanings: Schema.optionalKey(Schema.Array(SetSupplyMeaningDeclarationSchema).check(distinctOccurrenceIds)),
  shipping: Schema.optionalKey(ShippingEvaluationInputSchema),
  taxRelevantTime: TaxRelevantTimeSchema,
});
export type TaxEvaluationRequest = typeof TaxEvaluationRequestSchema.Type;

/**
 * Why a request is not one structurally bound purchase. These are request rejections, never Tax Outcomes: the closed
 * #938 outcome set describes evaluated purchases only.
 */
export const TaxEvaluationRequestRejectionReasonSchema = Schema.Literals([
  'STRUCTURAL_BINDING_INVALID',
  'SET_MEANING_UNDECLARED',
  'FUTURE_TAX_RELEVANT_TIME',
]);
export type TaxEvaluationRequestRejectionReason = typeof TaxEvaluationRequestRejectionReasonSchema.Type;

const subsetOf = (ids: readonly string[], known: ReadonlySet<string>) => ids.every((id) => known.has(id));

/** Catalog evidence covers every occurrence exactly once and is issued for that occurrence's exact selection. */
const catalogBound = (request: TaxEvaluationRequest): boolean => {
  const byOccurrence = new Map(request.catalog.map((entry) => [entry.occurrenceId, entry]));
  return (
    byOccurrence.size === request.purchase.purchaseDemandOccurrences.length &&
    request.purchase.purchaseDemandOccurrences.every((occurrence) => {
      const entry = byOccurrence.get(occurrence.occurrenceId);
      return (
        entry !== undefined &&
        isSameCatalogSelection(entry.classificationInput.catalogSelection, occurrence.catalogSelection)
      );
    })
  );
};

/**
 * Published lines come from the exact Pricing Result the binding names, name only bound occurrences, and one Pricing
 * Line never stands for two occurrences (#937 F26-F28). A missing line is not a rejection; the kernel gives it its
 * typed non-success (#931 F14).
 */
const pricingBound = (request: TaxEvaluationRequest, occurrenceIds: ReadonlySet<string>): boolean => {
  const { pricing, purchase } = request;
  const occurrenceByLine = new Map<string, string>();
  const linesBound = pricing.publishedLines.every(({ occurrenceId, pricingLineRef }) => {
    const bound = occurrenceByLine.get(pricingLineRef);
    occurrenceByLine.set(pricingLineRef, occurrenceId);
    return occurrenceIds.has(occurrenceId) && (bound === undefined || bound === occurrenceId);
  });
  return (
    linesBound &&
    pricing.pricingResultRef.pricingResultId === purchase.pricingResultRef.pricingResultId &&
    pricing.pricingResultRef.revision === purchase.pricingResultRef.revision
  );
};

/**
 * Shipping evidence is present exactly when the binding names a Shipping source, a Current amount is that exact
 * source revision, and affected occurrences and weights name only bound occurrences (#937 F29-F30, #933 F12-F17).
 */
const shippingBound = (request: TaxEvaluationRequest, occurrenceIds: ReadonlySet<string>): boolean => {
  const { shipping } = request;
  const { shippingSourceRef } = request.purchase;
  if (shipping === undefined || shippingSourceRef === undefined) {
    return shipping === undefined && shippingSourceRef === undefined;
  }
  const sourceBound = Match.value(shipping.source).pipe(
    Match.tag(
      'CURRENT',
      ({ shippingSourceRef: observed }) =>
        observed.shippingAmountId === shippingSourceRef.shippingAmountId &&
        observed.revision === shippingSourceRef.revision,
    ),
    Match.tag('NOT_ESTABLISHED', () => true),
    Match.exhaustive,
  );
  return (
    sourceBound &&
    subsetOf(shipping.affectedOccurrenceIds, occurrenceIds) &&
    subsetOf(
      (shipping.allocationWeights?.weights ?? []).map(({ occurrenceId }) => occurrenceId),
      occurrenceIds,
    )
  );
};

/**
 * Structural binding of the request to one exact purchase (#937 F11-F30). Missing or ambiguous published amounts and
 * weights that do not cover the affected units are not rejected here: the kernel gives them their typed non-success
 * meaning (#931 F14, #938 F27-F28). A Set occurrence without a declared supply meaning is rejected, never guessed as
 * ordinary (#934, #920 F25-F30).
 */
export const taxEvaluationRequestRejections = (
  request: TaxEvaluationRequest,
): readonly TaxEvaluationRequestRejectionReason[] => {
  const occurrences = request.purchase.purchaseDemandOccurrences;
  const occurrenceIds = new Set<string>(occurrences.map(({ occurrenceId }) => occurrenceId));
  const declared = new Map<string, string>(
    (request.setSupplyMeanings ?? []).map(({ meaning, occurrenceId }) => [occurrenceId, meaning]),
  );
  const setOccurrenceIds = new Set<string>(
    occurrences
      .filter(({ catalogSelection }) => catalogSelection.setCompositionRevisionRef !== undefined)
      .map(({ occurrenceId }) => occurrenceId),
  );
  const structurallyBound =
    catalogBound(request) &&
    pricingBound(request, occurrenceIds) &&
    shippingBound(request, occurrenceIds) &&
    subsetOf([...declared.keys()], setOccurrenceIds);
  const setMeaningsDeclared = [...setOccurrenceIds].every((occurrenceId) => declared.has(occurrenceId));
  return [
    ...(structurallyBound ? [] : (['STRUCTURAL_BINDING_INVALID'] as const)),
    ...(setMeaningsDeclared ? [] : (['SET_MEANING_UNDECLARED'] as const)),
  ];
};
