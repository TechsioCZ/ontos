import { Match } from 'effect';

import { isSameCatalogSelection } from '../../shared/domain/tax-kernel/purchase-binding.ts';
import type {
  TaxEvaluationRequest,
  TaxEvaluationRequestRejectionReason,
} from '../../shared/domain/tax-evaluation-contracts.ts';

export { TaxEvaluationRequestSchema } from '../../shared/domain/tax-evaluation-contracts.ts';
export type {
  TaxEvaluationRequest,
  TaxEvaluationRequestRejectionReason,
} from '../../shared/domain/tax-evaluation-contracts.ts';

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
 * source revision, and the affected occurrences name only bound occurrences (#937 F29-F30, #933 F12-F17). TAX
 * derives the gross line-value weights itself; there is no caller weights set to bound here (PO decision D3 on
 * #907).
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
  return sourceBound && subsetOf(shipping.affectedOccurrenceIds, occurrenceIds);
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
