import { DateTime, Predicate } from 'effect';
import type { PrepareOrderCommitmentInput } from '../../shared/domain/order-commitment.ts';

/** The trusted buyer, Legal Entity and Tenant that own one preparation. */
export interface PreparationParty {
  readonly buyerPrincipalId: string;
  readonly legalEntityId: string;
  readonly tenantId: string;
}
/** Only the approved proposal facts these admission rules read. */
export interface PreparationProposalFacts {
  readonly context: { readonly channelId: string; readonly locale: string };
  readonly currency: string;
  readonly identity: { readonly counterpartyRef: { readonly resourceId: string } };
  readonly payment: string;
  readonly purchaseValue: { readonly monetaryAmount: { readonly currency: string } };
  readonly reservation: string;
  readonly totals: { readonly shipping: { readonly amount: string }; readonly total: { readonly currency: string } };
}

type TaxCandidate = PrepareOrderCommitmentInput['taxCandidate'];
type TaxPurchase = TaxCandidate['purchase'];
type CatalogSelection = TaxPurchase['purchaseDemandOccurrences'][number]['catalogSelection'];
const unsupportedTaxRegimes = new Set([
  'OSS',
  'REVERSE_CHARGE',
  'EXPORT',
  'INTRA_EU_SPECIAL_REGIME',
  'FOREIGN_VAT_REGIME',
]);

// Tax's published exact-identity meaning for a catalog selection and purchase binding:
// array order is not identity and traceability-only context is not compared.
const sameCatalogSelection = (left: CatalogSelection, right: CatalogSelection) =>
  left.productRef === right.productRef &&
  left.variantRef === right.variantRef &&
  left.productConfigurationRef === right.productConfigurationRef &&
  left.packageOption?.packageOptionRef === right.packageOption?.packageOptionRef &&
  left.packageOption?.pinnedContentRevisionRef === right.packageOption?.pinnedContentRevisionRef &&
  left.setCompositionRevisionRef?.setCompositionId === right.setCompositionRevisionRef?.setCompositionId &&
  left.setCompositionRevisionRef?.revision === right.setCompositionRevisionRef?.revision;
const subjectIdentity = (subject: TaxPurchase['purchasingSubject']) =>
  Predicate.isTagged(subject, 'COUNTERPARTY')
    ? `COUNTERPARTY:${subject.counterpartyRef}`
    : `RETAIL:${subject.purchasingSubjectRef}`;
const sameTaxPurchase = (left: TaxPurchase, right: TaxPurchase) => {
  const rightById = new Map(right.purchaseDemandOccurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  return (
    left.tenantId === right.tenantId &&
    left.purchaseCandidateRef === right.purchaseCandidateRef &&
    left.sellingLegalEntityRef === right.sellingLegalEntityRef &&
    left.currency === right.currency &&
    subjectIdentity(left.purchasingSubject) === subjectIdentity(right.purchasingSubject) &&
    left.pricingResultRef.pricingResultId === right.pricingResultRef.pricingResultId &&
    left.pricingResultRef.revision === right.pricingResultRef.revision &&
    left.shippingSourceRef === undefined &&
    right.shippingSourceRef === undefined &&
    left.purchaseDemandOccurrences.length === right.purchaseDemandOccurrences.length &&
    left.purchaseDemandOccurrences.every((occurrence) => {
      const counterpart = rightById.get(occurrence.occurrenceId);
      return (
        counterpart !== undefined &&
        sameCatalogSelection(occurrence.catalogSelection, counterpart.catalogSelection) &&
        occurrence.quantity.amount === counterpart.quantity.amount &&
        occurrence.quantity.unitRef === counterpart.quantity.unitRef
      );
    })
  );
};
// Tax refuses a supported case unless its scoped eligibility is current, complete, Launch-covered
// and names this exact purchase (Tax `establishSupportedTaxCase` and Launch coverage).
const eligibilityConflicts = (candidate: TaxCandidate) => {
  const { eligibility } = candidate;
  return (
    eligibility === undefined ||
    !Predicate.isTagged(eligibility, 'CURRENT') ||
    !Predicate.isTagged(eligibility.materialEvidenceCompleteness, 'OWNER_QUALIFIED_COMPLETE') ||
    eligibility.requiredTaxRegimes.some((regime) => unsupportedTaxRegimes.has(regime)) ||
    eligibility.requiredTaxTreatments.some((treatment) => treatment !== 'TAXABLE') ||
    !sameTaxPurchase(eligibility.purchase, candidate.purchase)
  );
};
// Owner-resolved places only, all Czech; an unestablished material place is never a CZ fallback.
const placeConflicts = ({ places }: TaxCandidate) =>
  [places.sellingLegalEntity, places.deliveryDestination, places.invoiceRecipient].some(
    (place) =>
      Predicate.isTagged(place, 'NOT_ESTABLISHED') ||
      (Predicate.isTagged(place, 'OWNER_RESOLVED') && place.countryCode !== 'CZ'),
  ) || !Predicate.isTagged(places.sellingLegalEntity, 'OWNER_RESOLVED');
// Tax's structural binding, set-meaning and published-line rules: each bound occurrence has exactly
// one CZK line of one amount basis, catalog evidence names bound selections, and Sets declare a
// whole-treatment meaning.
const occurrenceConflicts = ({ catalog, pricing, purchase, setSupplyMeanings }: TaxCandidate) => {
  const occurrences = new Map<string, TaxPurchase['purchaseDemandOccurrences'][number]>(
    purchase.purchaseDemandOccurrences.map((entry) => [entry.occurrenceId, entry]),
  );
  const lineOwners = new Map<string, string>();
  const reusedLine = pricing.publishedLines.some(({ occurrenceId, pricingLineRef }) => {
    const owner = lineOwners.get(pricingLineRef);
    lineOwners.set(pricingLineRef, occurrenceId);
    return owner !== undefined && owner !== occurrenceId;
  });
  const declared = new Map<string, string>(
    (setSupplyMeanings ?? []).map(({ meaning, occurrenceId }) => [occurrenceId, meaning]),
  );
  const isSet = (occurrenceId: string) =>
    occurrences.get(occurrenceId)?.catalogSelection.setCompositionRevisionRef !== undefined;
  return (
    reusedLine ||
    new Set(pricing.publishedLines.map(({ lineCommercialValue }) => lineCommercialValue.amountBasis)).size > 1 ||
    pricing.publishedLines.some(
      ({ lineCommercialValue, occurrenceId }) =>
        !occurrences.has(occurrenceId) || lineCommercialValue.currency !== 'CZK',
    ) ||
    [...occurrences.keys()].some(
      (occurrenceId) => pricing.publishedLines.filter((line) => line.occurrenceId === occurrenceId).length !== 1,
    ) ||
    (catalog ?? []).some(({ classificationInput, occurrenceId }) => {
      const occurrence = occurrences.get(occurrenceId);
      return (
        occurrence === undefined ||
        !sameCatalogSelection(classificationInput.catalogSelection, occurrence.catalogSelection)
      );
    }) ||
    [...declared.keys()].some((occurrenceId) => !isSet(occurrenceId)) ||
    [...occurrences.keys()].some((occurrenceId) => isSet(occurrenceId) && !declared.has(occurrenceId)) ||
    [...declared.values()].some((meaning) => meaning === 'MULTI_SUPPLY_SET')
  );
};
/**
 * Tax candidate facts Tax refuses (NOT_FINALIZED or FINALIZATION_REJECTED) whatever its own state.
 * Tax keeps nothing for those outcomes and its spent finalization key cannot be retried, so they
 * are refused before an intent exists. Owner-state outcomes remain Tax's decision.
 */
export const taxCandidateInputConflicts = (candidate: TaxCandidate): boolean =>
  candidate.purchase.currency !== 'CZK' ||
  eligibilityConflicts(candidate) ||
  placeConflicts(candidate) ||
  occurrenceConflicts(candidate);

/** Tax evaluates the frozen candidate at exactly T; its eligibility must name that instant. */
export const taxRelevantTimeConflicts = (candidate: TaxCandidate, orderCommitmentTime: DateTime.Utc): boolean =>
  candidate.eligibility === undefined ||
  DateTime.toEpochMillis(candidate.eligibility.taxRelevantTime) !== DateTime.toEpochMillis(orderCommitmentTime);

/**
 * Relationships the worker would refuse on every delivery, decided from the buyer input and its
 * trusted scope alone. A worker conflict is never retryable in substance, so these are refused
 * before an intent or its completion-debt delivery exists.
 */
export const preparationInputConflicts = (input: PrepareOrderCommitmentInput, party: PreparationParty): boolean => {
  const { pricing, purchase, shipping } = input.taxCandidate;
  const { traceabilityContext } = purchase;
  return (
    taxCandidateInputConflicts(input.taxCandidate) ||
    shipping !== undefined ||
    purchase.shippingSourceRef !== undefined ||
    purchase.tenantId !== party.tenantId ||
    purchase.sellingLegalEntityRef !== party.legalEntityId ||
    purchase.purchaseCandidateRef !== input.candidateRef.resourceId ||
    // Pricing publishes an immutable Quotation as its own revision-1 result.
    purchase.pricingResultRef.pricingResultId !== input.quotationRef ||
    purchase.pricingResultRef.revision !== 1 ||
    pricing.pricingResultRef.pricingResultId !== input.quotationRef ||
    pricing.pricingResultRef.revision !== 1 ||
    (traceabilityContext.actingPrincipalRef !== undefined &&
      traceabilityContext.actingPrincipalRef !== party.buyerPrincipalId) ||
    (traceabilityContext.storefrontRef !== undefined && traceabilityContext.storefrontRef !== input.storefrontId) ||
    !Predicate.isTagged(purchase.purchasingSubject, 'COUNTERPARTY') ||
    purchase.purchasingSubject.counterpartyRef !== input.counterpartyRef.resourceId
  );
};

/** Relationships decided once the approval owner has returned the exact approved proposal. */
export const preparationProposalConflicts = (
  input: PrepareOrderCommitmentInput,
  proposal: PreparationProposalFacts,
): boolean => {
  const { purchase } = input.taxCandidate;
  return (
    proposal.payment !== 'NONE' ||
    proposal.reservation !== 'NONE' ||
    proposal.totals.shipping.amount !== '0' ||
    proposal.totals.total.currency !== proposal.currency ||
    // Both must equal the Quotation currency, so they must equal each other.
    purchase.currency !== proposal.purchaseValue.monetaryAmount.currency ||
    (purchase.traceabilityContext.channel !== undefined &&
      purchase.traceabilityContext.channel !== proposal.context.channelId) ||
    (purchase.traceabilityContext.locale !== undefined &&
      purchase.traceabilityContext.locale !== proposal.context.locale) ||
    proposal.identity.counterpartyRef.resourceId !== input.counterpartyRef.resourceId
  );
};
