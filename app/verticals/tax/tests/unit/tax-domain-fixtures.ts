import { Option, Schema } from 'effect';

import { TaxPurchaseBindingSchema } from '../../src/domain/purchase-binding.ts';
import { TaxDecisionSchema, TaxDecisionUnitSchema } from '../../src/domain/tax-decision.ts';
import type { TaxDecision } from '../../src/domain/tax-decision.ts';
import { taxExactRationalFromDecimal } from '../../src/domain/tax-exact-rational.ts';
import type { TaxExactRational } from '../../src/domain/tax-exact-rational.ts';
import { composeTaxResult } from '../../src/domain/tax-result.ts';
import type { TaxResult } from '../../src/domain/tax-result.ts';
import type { TaxRoundingPolicy } from '../../src/domain/tax-rounding.ts';

export const decodePurchaseBinding = Schema.decodeUnknownSync(TaxPurchaseBindingSchema);
export const decodeTaxDecisionUnit = Schema.decodeUnknownSync(TaxDecisionUnitSchema);
export const decodeTaxDecision = Schema.decodeUnknownSync(TaxDecisionSchema);
export const encodeTaxDecision = Schema.encodeSync(TaxDecisionSchema);

export const roundingPolicy: TaxRoundingPolicy = {
  currency: 'CZK',
  mode: 'ROUND_HALF_UP',
  precision: '0.01',
  revision: 1,
};

/** Tax Result of a Decision under the Launch rounding policy. */
export const composeResult = (decision: TaxDecision): TaxResult => composeTaxResult(decision, roundingPolicy);

export const shippingSourceRefInput = { revision: 1, shippingAmountId: 'shipping-1' } as const;

export const exactDecimal = (value: string): TaxExactRational => Option.getOrThrow(taxExactRationalFromDecimal(value));

type PurchaseBindingInput = typeof TaxPurchaseBindingSchema.Encoded;
type TaxDecisionUnitInput = typeof TaxDecisionUnitSchema.Encoded;
type TaxDecisionInput = typeof TaxDecisionSchema.Encoded;

type CatalogSelectionInput = PurchaseBindingInput['purchaseDemandOccurrences'][number]['catalogSelection'];

export const catalogSelectionInput = (variantRef = 'variant-1'): CatalogSelectionInput => ({
  productRef: 'product-1',
  variantRef,
});

export const occurrenceInput = (occurrenceId: string): PurchaseBindingInput['purchaseDemandOccurrences'][number] => ({
  catalogSelection: catalogSelectionInput(),
  occurrenceId,
  quantity: { amount: '1', unitRef: 'piece' },
});

export const purchaseBindingInput = (
  occurrenceIds: readonly [string, ...string[]],
  overrides: Partial<PurchaseBindingInput> = {},
): PurchaseBindingInput => ({
  currency: 'CZK',
  pricingResultRef: { pricingResultId: 'pricing-result-1', revision: 1 },
  purchaseCandidateRef: 'purchase-a',
  purchaseDemandOccurrences: [occurrenceInput(occurrenceIds[0]), ...occurrenceIds.slice(1).map(occurrenceInput)],
  purchasingSubject: { _tag: 'RETAIL_CUSTOMER', purchasingSubjectRef: 'retail-customer-1' },
  sellingLegalEntityRef: 'selling-legal-entity-1',
  tenantId: 'tenant-1',
  traceabilityContext: { channel: 'B2C', storefrontRef: 'storefront-1' },
  ...overrides,
});

export const decisionUnitInput = (
  occurrenceId: string,
  lineValue = '100.00',
  ratePercent = '21',
): TaxDecisionUnitInput => ({
  applicability: 'APPLICABLE',
  governingTaxRuleRevisionRef: { revision: 1, taxRuleId: 'cz-domestic-standard' },
  jurisdiction: {
    jurisdiction: 'CZ_DOMESTIC',
    placeEvidenceRefs: { deliveryDestination: 'delivery-destination-evidence-1' },
  },
  taxableBasisInterpretation: {
    components: [
      {
        _tag: 'LINE_COMMERCIAL_VALUE',
        amount: exactDecimal(lineValue),
        occurrenceId,
        pricingLineRef: `pricing-line-${occurrenceId}`,
      },
    ],
  },
  taxableSupplyUnit: {
    mapping: { _tag: 'ORDINARY_OCCURRENCE', catalogSelection: catalogSelectionInput(), occurrenceId },
    unitId: `taxable-supply-unit:${occurrenceId}`,
  },
  taxClassification: {
    catalogSelection: catalogSelectionInput(),
    classificationCode: 'cz-standard-goods',
    completenessEvidenceRef: 'completeness-1',
    materialCatalogEvidence: [
      {
        _tag: 'CURRENT',
        catalogFactRef: 'variant-1:tax-category',
        catalogFactRevisionRef: 'r1',
        ownerEvidenceRef: 'owner-evidence-1',
      },
    ],
  },
  treatment: { _tag: 'TAXABLE', ratePercent },
});

export const taxDecisionInput = (
  occurrenceIds: readonly [string, ...string[]],
  overrides: Partial<TaxDecisionInput> = {},
): TaxDecisionInput => ({
  decisionId: 'tax-decision-1',
  purchaseBinding: purchaseBindingInput(occurrenceIds),
  taxEvaluationTime: '2026-10-08T10:00:02.000Z',
  taxRelevantTime: '2026-10-08T10:00:00.000Z',
  units: [
    decisionUnitInput(occurrenceIds[0]),
    ...occurrenceIds.slice(1).map((occurrenceId) => decisionUnitInput(occurrenceId)),
  ],
  ...overrides,
});
