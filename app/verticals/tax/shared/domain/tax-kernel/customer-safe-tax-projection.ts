import { Schema } from 'effect';

import { PurchaseDemandOccurrenceIdSchema } from './purchase-binding.ts';
import { TaxMonetaryAmountSchema } from './tax-monetary-amount.ts';
import { TaxRatePercentSchema } from './tax-treatment.ts';

/** Customer-Safe Tax Projection contract version (#940 F44, glossary: versioned allowlist). */
export const CUSTOMER_SAFE_TAX_PROJECTION_VERSION = 1;

/** Whether the exact view needs several Tax components explained (#940 F23-F24). */
export const CustomerSafeTaxDecompositionNeedSchema = Schema.Literals(['NOT_NEEDED', 'PER_TAXABLE_SUPPLY_UNIT']);

export type CustomerSafeTaxDecompositionNeed = typeof CustomerSafeTaxDecompositionNeedSchema.Type;

/** Presentation-safe treatment/rate meaning; it never creates its own Tax decision (#940 F22, F31). */
const CustomerSafeTaxComponentSchema = Schema.Struct({
  /** Explicit allowlisted join key of this presentation decomposition component to its source occurrences (#940 F18, J). */
  purchaseDemandOccurrenceIds: Schema.NonEmptyArray(PurchaseDemandOccurrenceIdSchema),
  taxAmount: TaxMonetaryAmountSchema,
  treatment: Schema.Struct({ category: Schema.Literal('TAXABLE'), ratePercent: TaxRatePercentSchema }),
});

/**
 * Explicit allowlist: Tax amount with currency and, only when the view needs it, presentation-safe decomposition
 * (#940 F18-F24). No rule revision, source/provider, currentness, commitment or evidence identities (#940 F25-F30).
 */
export const CustomerSafeTaxAmountSchema = Schema.TaggedStruct('TAX_AMOUNT', {
  components: Schema.optionalKey(Schema.NonEmptyArray(CustomerSafeTaxComponentSchema)),
  contractVersion: Schema.Literal(CUSTOMER_SAFE_TAX_PROJECTION_VERSION),
  purchaseTaxTotal: TaxMonetaryAmountSchema,
});

/** A non-success outcome is projected without any Tax amount (#940 F38, #939 F34). */
export const CustomerSafeTaxNotDeterminedSchema = Schema.TaggedStruct('TAX_NOT_DETERMINED', {
  contractVersion: Schema.Literal(CUSTOMER_SAFE_TAX_PROJECTION_VERSION),
});

export const CustomerSafeTaxProjectionSchema = Schema.Union([
  CustomerSafeTaxAmountSchema,
  CustomerSafeTaxNotDeterminedSchema,
]);

export type CustomerSafeTaxProjection = typeof CustomerSafeTaxProjectionSchema.Type;

export type CustomerSafeTaxComponent = typeof CustomerSafeTaxComponentSchema.Type;
