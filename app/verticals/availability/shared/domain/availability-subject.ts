import { CatalogSelectionWithQuantitySchema } from '@app/catalog/domain/catalog-selection-evidence';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import {
  PricingPurchaseContextVerificationEvidenceSchema,
  PricingPurchaseContextVerificationRequestSchema,
  PricingPurchaseContextVerificationResponseSchema,
} from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { Schema } from 'effect';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const isOwnerVerifiedContext = Schema.is(PricingPurchaseContextVerificationResponseSchema);

/** Reuses Commerce's published authority proof; decoding alone does not authenticate its issuer. */
export const AvailabilityVerifiedPurchasingContextSchema = Schema.Struct({
  evidence: PricingPurchaseContextVerificationEvidenceSchema,
  outcome: Schema.Literal('PURCHASE_CONTEXT_VERIFIED'),
  request: PricingPurchaseContextVerificationRequestSchema,
}).check(
  Schema.makeFilter((context) =>
    isOwnerVerifiedContext(context) ? undefined : 'Availability requires exact owner-verified Purchasing Context',
  ),
);

/** Additional material context comes from the trusted resolver, never client-selected authority. */
export const AvailabilityPurchasingContextSchema = Schema.Struct({
  contextVerification: AvailabilityVerifiedPurchasingContextSchema,
  dimensions: Schema.optionalKey(
    Schema.Struct({
      cartRef: Schema.optionalKey(stableReference),
      choicesEvidenceRef: Schema.optionalKey(stableReference),
      locale: Schema.optionalKey(stableReference),
      ownerRef: stableReference,
      ownerRevisionRef: stableReference,
      storefrontRef: Schema.optionalKey(stableReference),
    }),
  ),
}).check(
  Schema.makeFilter(({ contextVerification, dimensions }) =>
    dimensions === undefined ||
    (dimensions.ownerRef === contextVerification.evidence.ownerRef &&
      dimensions.ownerRevisionRef === contextVerification.evidence.ownerRevisionRef)
      ? undefined
      : 'Material context dimensions must bind the verified Purchasing Context owner and revision',
  ),
);

/**
 * Exact prospective purchase value. Catalog owns Selection structure and Unit identity;
 * Availability never substitutes a Product, Stock Item, quantity or Unit to obtain a promise.
 * A trusted owner gateway must supply Purchasing Context proof, not a public request decoder.
 */
export const AvailabilitySubjectSchema = Schema.Struct({
  purchasingContext: AvailabilityPurchasingContextSchema,
  quantity: Schema.Struct({
    ...CatalogSelectionWithQuantitySchema.fields.quantity.fields,
    unitRef: ProductUnitRefSchema,
  }),
  selection: CatalogSelectionWithQuantitySchema.fields.selection,
}).check(
  Schema.makeFilter(({ purchasingContext, quantity, selection }) =>
    quantity.unitRef.tenantId === selection.productRef.tenantId &&
    selection.productRef.tenantId === purchasingContext.contextVerification.request.tenantId
      ? undefined
      : 'Exact Selection, Quantity Unit and trusted Purchasing Context must share one Tenant',
  ),
  Schema.makeFilter(({ quantity }) =>
    /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(quantity.amount) && /[1-9]/u.test(quantity.amount)
      ? undefined
      : 'Requested Quantity must be a positive exact decimal in an explicit Catalog Unit',
  ),
);
export type AvailabilitySubject = typeof AvailabilitySubjectSchema.Type;

/** Requested use remains explicit; no recent evaluation is implicitly authority for a later use. */
export const AvailabilityUseBoundarySchema = Schema.Struct({
  kind: Schema.Literals(['INFORMATIONAL', 'CHECKOUT_SUBMISSION', 'ORDER_COMMITMENT']),
  requiredAt: PricingPurchaseContextVerificationRequestSchema.fields.operationTime,
});
export type AvailabilityUseBoundary = typeof AvailabilityUseBoundarySchema.Type;

/** Exact representation is material, including decimal text and context evidence lineage. */
export const sameAvailabilitySubject = Schema.toEquivalence(AvailabilitySubjectSchema);
