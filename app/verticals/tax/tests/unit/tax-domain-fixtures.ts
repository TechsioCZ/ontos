import { Option, Schema } from 'effect';

import { TaxPurchaseBindingSchema } from '../../shared/domain/tax-kernel/purchase-binding.ts';
import {
  TaxDecisionSchema,
  TaxDecisionUnitSchema,
  TaxableDecisionUnitSchema,
} from '../../shared/domain/tax-kernel/tax-decision.ts';
import type { TaxDecision } from '../../shared/domain/tax-kernel/tax-decision.ts';
import { taxExactRationalFromDecimal } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { TaxExactRational } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import { composeTaxResult } from '../../src/domain/tax-result.ts';
import type { TaxResult } from '../../src/domain/tax-result.ts';
import { LAUNCH_CZK_TAX_ROUNDING_POLICY } from '../../src/domain/tax-rounding.ts';
import type { TaxRoundingPolicy } from '../../src/domain/tax-rounding.ts';

export const decodePurchaseBinding = Schema.decodeUnknownSync(TaxPurchaseBindingSchema);
export const decodeTaxDecisionUnit = Schema.decodeUnknownSync(TaxDecisionUnitSchema);
export const decodeTaxableDecisionUnit = Schema.decodeUnknownSync(TaxableDecisionUnitSchema);
export const decodeTaxDecision = Schema.decodeUnknownSync(TaxDecisionSchema);
export const encodeTaxDecision = Schema.encodeSync(TaxDecisionSchema);

export const roundingPolicy: TaxRoundingPolicy = LAUNCH_CZK_TAX_ROUNDING_POLICY;

/** Tax Result of a Decision under the Launch rounding policy. */
export const composeResult = (decision: TaxDecision): TaxResult => composeTaxResult(decision, roundingPolicy);

export const shippingSourceRefInput = { revision: 1, shippingAmountId: 'shipping-1' } as const;

export const exactDecimal = (value: string): TaxExactRational => Option.getOrThrow(taxExactRationalFromDecimal(value));

type PurchaseBindingInput = typeof TaxPurchaseBindingSchema.Encoded;
type TaxDecisionUnitInput = typeof TaxableDecisionUnitSchema.Encoded;
type TaxDecisionInput = typeof TaxDecisionSchema.Encoded;

type CatalogSelectionInput = PurchaseBindingInput['purchaseDemandOccurrences'][number]['catalogSelection'];

export const catalogSelectionInput = (variantRef = 'variant-1'): CatalogSelectionInput => ({
  productRef: 'product-1',
  variantRef,
});

export const occurrenceInput = (
  occurrenceId: string,
  quantity = '1',
): PurchaseBindingInput['purchaseDemandOccurrences'][number] => ({
  catalogSelection: catalogSelectionInput(),
  occurrenceId,
  quantity: { amount: quantity, unitRef: 'piece' },
});

export const purchaseBindingInput = (
  occurrenceIds: readonly [string, ...string[]],
  overrides: Partial<PurchaseBindingInput> = {},
): PurchaseBindingInput => ({
  currency: 'CZK',
  pricingResultRef: { pricingResultId: 'pricing-result-1', revision: 1 },
  purchaseCandidateRef: 'purchase-a',
  purchaseDemandOccurrences: [
    occurrenceInput(occurrenceIds[0]),
    ...occurrenceIds.slice(1).map((occurrenceId) => occurrenceInput(occurrenceId)),
  ],
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
  amountBasis: 'GROSS' | 'NET' = 'NET',
): TaxDecisionUnitInput => ({
  applicability: 'APPLICABLE',
  governingTaxRuleRevisionRef: { revision: 1, taxRuleId: 'cz-domestic-standard' },
  jurisdiction: {
    jurisdiction: 'CZ_DOMESTIC',
    placeEvidenceRefs: {
      deliveryDestination: 'delivery-destination-evidence-1',
      sellingLegalEntity: 'selling-legal-entity-evidence-1',
    },
  },
  taxableBasisInterpretation: {
    components: [
      {
        _tag: 'LINE_COMMERCIAL_VALUE',
        amount: exactDecimal(lineValue),
        amountBasis,
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
        factKind: 'TAX_CATEGORY',
        factValue: 'cz-standard-goods',
        ownerEvidenceRef: 'owner-evidence-1',
      },
    ],
  },
  treatment: { _tag: 'TAXABLE', ratePercent },
});

type SellerNotVatPayerDecisionUnitInput = Exclude<typeof TaxDecisionUnitSchema.Encoded, TaxDecisionUnitInput>;

export const nonPayerDecisionUnitInput = (
  occurrenceId: string,
  lineValue = '100.00',
  amountBasis: 'GROSS' | 'NET' = 'NET',
): SellerNotVatPayerDecisionUnitInput => ({
  applicability: 'APPLICABLE',
  governingReference: {
    declarationRevisionRef: { revision: 1 },
    legalBasis: { reference: 'ZDPH § 50 odst. 1 (461/2024 Sb., účinnost 1. 1. 2025)', revision: 1 },
  },
  jurisdiction: {
    jurisdiction: 'CZ_DOMESTIC',
    placeEvidenceRefs: {
      deliveryDestination: 'delivery-destination-evidence-1',
      sellingLegalEntity: 'selling-legal-entity-evidence-1',
    },
  },
  taxableBasisInterpretation: {
    components: [
      {
        _tag: 'LINE_COMMERCIAL_VALUE',
        amount: exactDecimal(lineValue),
        amountBasis,
        occurrenceId,
        pricingLineRef: `pricing-line-${occurrenceId}`,
      },
    ],
  },
  taxableSupplyUnit: {
    mapping: { _tag: 'ORDINARY_OCCURRENCE', catalogSelection: catalogSelectionInput(), occurrenceId },
    unitId: `taxable-supply-unit:${occurrenceId}`,
  },
  treatment: { _tag: 'SELLER_NOT_VAT_PAYER' },
});

export const taxDecisionInput = (
  occurrenceIds: readonly [string, ...string[]],
  overrides: Partial<TaxDecisionInput> = {},
): TaxDecisionInput => ({
  decisionId: 'tax-decision-1',
  declarationRevisionRef: { revision: 1 },
  purchaseBinding: purchaseBindingInput(occurrenceIds),
  sellerVatRegime: 'VAT_PAYER',
  taxEvaluationTime: '2026-10-08T10:00:02.000Z',
  taxRelevantTime: '2026-10-08T10:00:00.000Z',
  units: [
    decisionUnitInput(occurrenceIds[0]),
    ...occurrenceIds.slice(1).map((occurrenceId) => decisionUnitInput(occurrenceId)),
  ],
  ...overrides,
});

export const nonPayerTaxDecisionInput = (
  occurrenceIds: readonly [string, ...string[]],
  overrides: Partial<TaxDecisionInput> = {},
): TaxDecisionInput => ({
  decisionId: 'tax-decision-1',
  declarationRevisionRef: { revision: 1 },
  purchaseBinding: purchaseBindingInput(occurrenceIds),
  sellerVatRegime: 'NON_PAYER',
  taxEvaluationTime: '2026-10-08T10:00:02.000Z',
  taxRelevantTime: '2026-10-08T10:00:00.000Z',
  units: [
    nonPayerDecisionUnitInput(occurrenceIds[0]),
    ...occurrenceIds.slice(1).map((occurrenceId) => nonPayerDecisionUnitInput(occurrenceId)),
  ],
  ...overrides,
});
