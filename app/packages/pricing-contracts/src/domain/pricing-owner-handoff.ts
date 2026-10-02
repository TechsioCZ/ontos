import { Schema } from 'effect';

import { PricingCurrencyCodeSchema, PricingTenantIdSchema } from '../apis/current-supported-currencies.ts';
import {
  PricingCommercialTotalBreakdownSchema,
  PricingCommercialTotalSafeProjectionSchema,
} from './commercial-total.ts';
import type { PricingCommercialTotalBreakdown, PricingCommercialTotalSafeProjection } from './commercial-total.ts';
import {
  PricingChannelIdSchema,
  PricingMarketIdSchema,
  PricingSellingLegalEntityIdSchema,
} from './pricing-commercial-scope.ts';
import { PricingPurchaseDemandOccurrenceIdSchema } from './pricing-decision.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (value: string): DecimalParts => {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
};

const decimalSumEquals = (expected: string, values: readonly string[]): boolean => {
  const parts = [decimalParts(expected), ...values.map(decimalParts)];
  const scale = Math.max(...parts.map((part) => part.scale));
  const align = (part: DecimalParts): bigint => part.coefficient * 10n ** BigInt(scale - part.scale);
  const [expectedPart, ...valueParts] = parts;
  return expectedPart !== undefined && align(expectedPart) === valueParts.reduce((sum, part) => sum + align(part), 0n);
};

const breakdownMoney = (breakdown: PricingCommercialTotalBreakdown) => [
  breakdown.baseLineTotal,
  breakdown.commercialFeeTotal,
  breakdown.pricingOwnedDiscountTotal,
  breakdown.promotionAllocationTotal,
  breakdown.zeroFloorAdjustmentTotal,
  breakdown.pricingLineRoundingAdjustmentTotal,
];

export const PricingOwnerExactPurchaseLineBindingSchema = Schema.Struct({
  catalogSelectionRef: stableReference,
  occurrenceId: PricingPurchaseDemandOccurrenceIdSchema,
  quantityAndUnitRef: stableReference,
});
export type PricingOwnerExactPurchaseLineBinding = typeof PricingOwnerExactPurchaseLineBindingSchema.Type;

export const PricingOwnerExactPurchaseBindingSchema = Schema.Struct({
  channelId: PricingChannelIdSchema,
  commerceMarketId: PricingMarketIdSchema,
  lines: Schema.Array(PricingOwnerExactPurchaseLineBindingSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  resolvedCurrencyCode: PricingCurrencyCodeSchema,
  sellingLegalEntityId: PricingSellingLegalEntityIdSchema,
  subjectOrGuestEvidenceRef: stableReference,
  tenantId: PricingTenantIdSchema,
});
export type PricingOwnerExactPurchaseBinding = typeof PricingOwnerExactPurchaseBindingSchema.Type;

const handoffBase = {
  breakdown: PricingCommercialTotalBreakdownSchema,
  exactPurchase: PricingOwnerExactPurchaseBindingSchema,
  ownerVerifiableEvidenceRef: stableReference,
  pricing: PricingCommercialTotalSafeProjectionSchema,
};

const handoffIsCoherent = ({
  breakdown,
  exactPurchase,
  pricing,
}: {
  readonly breakdown: PricingCommercialTotalBreakdown;
  readonly exactPurchase: PricingOwnerExactPurchaseBinding;
  readonly pricing: PricingCommercialTotalSafeProjection;
}): boolean => {
  const money = breakdownMoney(breakdown);
  return (
    exactPurchase.resolvedCurrencyCode === pricing.currencyCode &&
    money.every(({ currencyCode }) => currencyCode === pricing.currencyCode) &&
    exactPurchase.lines.length === pricing.lines.length &&
    exactPurchase.lines.every(({ occurrenceId }, index) => occurrenceId === pricing.lines[index]?.occurrenceId) &&
    decimalSumEquals(
      pricing.pricingNetCommercialTotal.amount,
      money.map(({ amount }) => amount),
    )
  );
};

export const PricingPurchasingLimitsContributionSchema = Schema.Struct({
  ...handoffBase,
  contractVersion: Schema.Literal('PRICING_PURCHASE_VALUE_CONTRIBUTION_V1'),
  excludedComponents: Schema.Tuple([Schema.Literal('DELIVERY'), Schema.Literal('TAX')]),
  includedComponents: Schema.Tuple([
    Schema.Literal('BASE_LINE_VALUE'),
    Schema.Literal('PRICING_FEES'),
    Schema.Literal('PRICING_OWNED_DISCOUNTS'),
    Schema.Literal('PROMOTION_ALLOCATIONS'),
    Schema.Literal('ZERO_FLOOR_ADJUSTMENTS'),
    Schema.Literal('PRICING_LINE_ROUNDING_ADJUSTMENTS'),
  ]),
  kind: Schema.Literal('PRICING_PURCHASE_VALUE_CONTRIBUTION'),
}).check(
  Schema.makeFilter((handoff) =>
    handoffIsCoherent(handoff)
      ? undefined
      : 'Purchasing Limits contribution must preserve one exact Pricing total, breakdown, purchase binding, and currency',
  ),
);
export type PricingPurchasingLimitsContribution = typeof PricingPurchasingLimitsContributionSchema.Type;

export const PricingTaxHandoffSchema = Schema.Struct({
  ...handoffBase,
  contractVersion: Schema.Literal('PRICING_PRE_TAX_HANDOFF_V1'),
  kind: Schema.Literal('PRICING_PRE_TAX_HANDOFF'),
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  taxDependency: Schema.Literal('NONE'),
}).check(
  Schema.makeFilter((handoff) =>
    handoffIsCoherent(handoff)
      ? undefined
      : 'Tax handoff must preserve one exact canonical pre-Tax Pricing result and its owner-verifiable evidence',
  ),
);
export type PricingTaxHandoff = typeof PricingTaxHandoffSchema.Type;
