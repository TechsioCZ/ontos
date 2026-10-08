import { Match, Schema } from 'effect';

import {
  BoundedIdentifierSchema,
  PositiveDecimalStringSchema,
  RevisionSchema,
  distinctBy,
} from './tax-domain-primitives.ts';
import { TaxCurrencySchema } from './tax-monetary-amount.ts';

/** Commerce-owned independent-demand identity carried into TAX unchanged (#937 F11-F12, #920 F5-F6). */
export const PurchaseDemandOccurrenceIdSchema = BoundedIdentifierSchema.pipe(
  Schema.brand('PurchaseDemandOccurrenceId'),
);
export type PurchaseDemandOccurrenceId = typeof PurchaseDemandOccurrenceIdSchema.Type;

/** Exact pinned Set Composition Revision used for a Set's Tax meaning (#934 F3, F23; #937 F17). */
export const SetCompositionIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('SetCompositionId'));

export const SetCompositionRevisionRefSchema = Schema.Struct({
  revision: RevisionSchema,
  setCompositionId: SetCompositionIdSchema,
});

/**
 * Exact Catalog Selection, the one representation used from the purchase binding through Taxable Supply Units to
 * Tax Classification. The exact Variant is always part of it; Product Configuration, Package Option with its pinned
 * content revision and Set Composition Revision are part of it when selected. SKU and display name are not inputs
 * (#926 F3-F5, F7; #937 F13-F14; #907 F44-F46, F48).
 */
export const CatalogSelectionSchema = Schema.Struct({
  packageOption: Schema.optionalKey(
    Schema.Struct({ packageOptionRef: BoundedIdentifierSchema, pinnedContentRevisionRef: BoundedIdentifierSchema }),
  ),
  productConfigurationRef: Schema.optionalKey(BoundedIdentifierSchema),
  productRef: BoundedIdentifierSchema,
  setCompositionRevisionRef: Schema.optionalKey(SetCompositionRevisionRefSchema),
  variantRef: BoundedIdentifierSchema,
});
export type CatalogSelection = typeof CatalogSelectionSchema.Type;

/** Same exact Catalog Selection; SKU and display name are never compared (#926 F9-F11, #937 F13-F14). */
export const isSameCatalogSelection = (left: CatalogSelection, right: CatalogSelection): boolean =>
  left.productRef === right.productRef &&
  left.variantRef === right.variantRef &&
  left.productConfigurationRef === right.productConfigurationRef &&
  left.packageOption?.packageOptionRef === right.packageOption?.packageOptionRef &&
  left.packageOption?.pinnedContentRevisionRef === right.packageOption?.pinnedContentRevisionRef &&
  left.setCompositionRevisionRef?.setCompositionId === right.setCompositionRevisionRef?.setCompositionId &&
  left.setCompositionRevisionRef?.revision === right.setCompositionRevisionRef?.revision;

/** Exact Purchase Demand Occurrence with its Catalog Selection and Quantity + Unit (#937 F12-F14). */
export const PurchaseDemandOccurrenceSchema = Schema.Struct({
  catalogSelection: CatalogSelectionSchema,
  occurrenceId: PurchaseDemandOccurrenceIdSchema,
  quantity: Schema.Struct({
    amount: PositiveDecimalStringSchema,
    unitRef: BoundedIdentifierSchema,
  }),
});
export type PurchaseDemandOccurrence = typeof PurchaseDemandOccurrenceSchema.Type;

/** B2C Retail Customer has no Tax VAT payer model; B2B subject is a Counterparty (#918 F4-F5, #923 F1-F4). */
export const PurchasingSubjectSchema = Schema.Union([
  Schema.TaggedStruct('RETAIL_CUSTOMER', { purchasingSubjectRef: BoundedIdentifierSchema }),
  Schema.TaggedStruct('COUNTERPARTY', { counterpartyRef: BoundedIdentifierSchema }),
]);
export type PurchasingSubject = typeof PurchasingSubjectSchema.Type;

export const TaxTenantIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('TaxTenantId'));
export const PricingResultIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('PricingResultId'));
export const ShippingAmountIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('ShippingAmountId'));

/** Exact authoritative Pricing Result used by TAX (#937 F26-F28). */
export const PricingResultRefSchema = Schema.Struct({
  pricingResultId: PricingResultIdSchema,
  revision: RevisionSchema,
});
/** Exact separately-owned Shipping/Delivery amount source used by TAX (#937 F29-F30). */
export const ShippingSourceRefSchema = Schema.Struct({
  revision: RevisionSchema,
  shippingAmountId: ShippingAmountIdSchema,
});
export type ShippingSourceRef = typeof ShippingSourceRefSchema.Type;

/** Context retained for traceability only; none of these fields selects Tax treatment (#937 F21, F38, F46-F51). */
export const TaxTraceabilityContextSchema = Schema.Struct({
  actingPrincipalRef: Schema.optionalKey(BoundedIdentifierSchema),
  channel: Schema.optionalKey(BoundedIdentifierSchema),
  locale: Schema.optionalKey(BoundedIdentifierSchema),
  storefrontRef: Schema.optionalKey(BoundedIdentifierSchema),
});

const distinctOccurrences = distinctBy(
  ({ occurrenceId }: PurchaseDemandOccurrence) => occurrenceId,
  'Purchase Demand Occurrences must stay distinct',
);

/**
 * Exact purchase identity binding of one Tax Decision/Result (#937 F1-F37). Exact identities, not equal
 * visible values, bind a Tax outcome to its purchase.
 */
export const TaxPurchaseBindingSchema = Schema.Struct({
  currency: TaxCurrencySchema,
  pricingResultRef: PricingResultRefSchema,
  purchaseCandidateRef: BoundedIdentifierSchema,
  purchaseDemandOccurrences: Schema.NonEmptyArray(PurchaseDemandOccurrenceSchema).check(distinctOccurrences),
  purchasingSubject: PurchasingSubjectSchema,
  sellingLegalEntityRef: BoundedIdentifierSchema,
  shippingSourceRef: Schema.optionalKey(ShippingSourceRefSchema),
  tenantId: TaxTenantIdSchema,
  traceabilityContext: TaxTraceabilityContextSchema,
});
export type TaxPurchaseBinding = typeof TaxPurchaseBindingSchema.Type;

const sameOccurrence = (left: PurchaseDemandOccurrence, right: PurchaseDemandOccurrence) =>
  left.occurrenceId === right.occurrenceId &&
  isSameCatalogSelection(left.catalogSelection, right.catalogSelection) &&
  left.quantity.amount === right.quantity.amount &&
  left.quantity.unitRef === right.quantity.unitRef;

const sameOccurrenceSet = (left: readonly PurchaseDemandOccurrence[], right: readonly PurchaseDemandOccurrence[]) => {
  const rightById = new Map(right.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  return (
    left.length === right.length &&
    left.every((occurrence) => {
      const counterpart = rightById.get(occurrence.occurrenceId);
      return counterpart !== undefined && sameOccurrence(occurrence, counterpart);
    })
  );
};

const purchasingSubjectIdentity = (subject: PurchasingSubject) =>
  Match.value(subject).pipe(
    Match.tag('RETAIL_CUSTOMER', ({ purchasingSubjectRef }) => ({
      kind: 'RETAIL_CUSTOMER',
      ref: purchasingSubjectRef,
    })),
    Match.tag('COUNTERPARTY', ({ counterpartyRef }) => ({ kind: 'COUNTERPARTY', ref: counterpartyRef })),
    Match.exhaustive,
  );

const sameSubject = (left: PurchasingSubject, right: PurchasingSubject) => {
  const leftIdentity = purchasingSubjectIdentity(left);
  const rightIdentity = purchasingSubjectIdentity(right);
  return leftIdentity.kind === rightIdentity.kind && leftIdentity.ref === rightIdentity.ref;
};

/** Same exact Shipping amount source and revision (#937 F29-F30); an absent source equals only an absent one. */
export const isSameShippingSourceRef = (left: ShippingSourceRef | undefined, right: ShippingSourceRef | undefined) =>
  left === undefined || right === undefined
    ? left === right
    : left.shippingAmountId === right.shippingAmountId && left.revision === right.revision;

/**
 * True only when both bindings name the same exact purchase and the same exact source revisions. Equal totals,
 * rates or Variants never establish it (#937 F1-F10, F25, F28), array order is not identity (#937 F7), and
 * traceability-only context is not compared (#937 F38). `false` claims no materiality; equivalence across
 * changed sources is a separate owner-attested Tax meaning (#937 F59-F62).
 */
export const isSameExactTaxPurchaseBinding = (left: TaxPurchaseBinding, right: TaxPurchaseBinding): boolean =>
  left.tenantId === right.tenantId &&
  left.purchaseCandidateRef === right.purchaseCandidateRef &&
  left.sellingLegalEntityRef === right.sellingLegalEntityRef &&
  left.currency === right.currency &&
  sameSubject(left.purchasingSubject, right.purchasingSubject) &&
  left.pricingResultRef.pricingResultId === right.pricingResultRef.pricingResultId &&
  left.pricingResultRef.revision === right.pricingResultRef.revision &&
  isSameShippingSourceRef(left.shippingSourceRef, right.shippingSourceRef) &&
  sameOccurrenceSet(left.purchaseDemandOccurrences, right.purchaseDemandOccurrences);
