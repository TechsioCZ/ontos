import type {
  PricingGenericAllocationRequest,
  PricingAllocationPrecision,
  PricingOwnerExactAllocationRequest,
  PricingWholePurchaseContractualAllocationRequest,
  PricingWholePurchaseContractualNotApplicableRequest,
} from '@app/pricing-contracts/domain/discount-fee-allocation';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { allocatePricingDiscountsAndFees } from '../../src/services/discount-fee-allocation.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-09-28T08:00:00.000Z';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const selection = {
  productRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'commerce.catalog.product' as const,
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
};
const line = (occurrenceId: string) => ({
  catalog: {
    completeness: {
      observedAt: operationTime,
      ownerRevision: 'catalog-quantity:17',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
    },
    divisible: false,
    equivalentSelectionKey: 'catalog-selection:exact',
    evidence: {
      assessedAt: operationTime,
      basis: [
        { role: 'PRODUCT' as const, source: { resourceRef: selection.productRef, revision: 1 } },
        { role: 'VARIANT' as const, source: { resourceRef: selection.variantRef, revision: 2 } },
        {
          provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
          role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
          source: { resourceRef: selection.productRef, revision: 1 },
        },
      ],
      membership: {
        attestationId: '66666666-6666-4666-8666-666666666666',
        observedAt: operationTime,
        productRef: selection.productRef,
        source: 'CATALOG_OWNER_CURRENT_READ' as const,
        variant: { resourceRef: selection.variantRef, revision: 2 },
      },
      purpose: 'PRICING' as const,
      selection,
      status: 'VALID' as const,
    },
    hierarchyRevision: 'catalog-hierarchy:9',
    ownerRevision: 'catalog-quantity:17',
    quantity: {
      changed: false,
      notice: null,
      requested: '1',
      resulting: '1',
      rounding: 'HALF_UP' as const,
      status: 'VALID' as const,
      step: '1',
      targetId: selection.variantRef.resourceId,
      tenantId,
      unitId: unitRef.resourceId,
      unitRuleRevision: 7,
    },
    quantityBasis: {
      targetDivisibilityRevision: 3,
      targetRef: selection.variantRef,
      unitRef,
      unitRuleRevision: 7,
    },
    selection,
    status: 'READY' as const,
    unitRef,
  },
  occurrenceId,
  pricingBasis: { quantity: '1', unitRef },
});
const decision = Schema.decodeSync(PricingDecisionSchema)({
  commercialScope: {
    channelId: 'B2C' as const,
    marketId: 'market-cz',
    sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
  },
  currencyCode: 'CZK' as const,
  lines: [line('line-a'), line('line-b')],
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:1',
      decisionRevision: 'purchase-access-decision-revision:1',
    },
    actor: {
      guestEvidenceRef: 'guest-evidence:1',
      guestSessionRef: 'guest-session:1',
      kind: 'GUEST',
    },
    commercialSettingsDecision: {
      decisionRef: 'purchase-commercial-settings:1',
      decisionRevision: 'purchase-commercial-settings-revision:1',
    },
    contextRef: 'purchase-1',
    contextRevision: 'purchase-r1',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:1',
      resolutionRevision: 'purchase-currency-resolution-revision:1',
    },
    subject: {
      guestEvidenceRef: 'guest-evidence:1',
      guestSessionRef: 'guest-session:1',
      kind: 'GUEST',
    },
  },
  tenantId,
});
const unicodeDecision = Schema.decodeSync(PricingDecisionSchema)({
  ...decision,
  lines: [line('line-ä'), line('line-z')],
});
const precision = {
  allocationScale: 18,
  amountPrecision: 76,
  contractVersion: 'pricing-allocation-v1' as const,
  remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC' as const,
} satisfies PricingAllocationPrecision;
const source = (
  allocationAuthority: 'GENERIC_SUPPORTED' | 'LINE_NATIVE' | 'OWNER_EXACT' | 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
) => ({
  allocationAuthority,
  logicalFactRef: 'discount-1',
  ownerModuleId: 'commerce.pricing',
  revisionRef: 'discount-r1',
  sourceKind: 'PRICING_DISCOUNT' as const,
});
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const allocation = (occurrenceId: string, amount: string) => ({
  amount: money(amount),
  occurrenceId,
  recipientKind: 'MERCHANDISE' as const,
});
const basis = (occurrenceId: string, amount: string) => ({
  baseLineValue: money(amount),
  occurrenceId,
  recipientKind: 'MERCHANDISE' as const,
});
const genericRequest = (
  recipients: PricingGenericAllocationRequest['eligibleRecipients'],
  originalContribution = '-10',
): PricingGenericAllocationRequest => ({
  allocationKind: 'GENERIC_PROPORTIONAL',
  basisKind: 'ELIGIBLE_BASE_LINE_VALUE',
  decision,
  eligibleRecipients: recipients,
  originalContribution: money(originalContribution),
  precision,
  source: source('GENERIC_SUPPORTED'),
});
const wholeRequest = (): PricingWholePurchaseContractualAllocationRequest => ({
  allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL',
  decision,
  eligibleBasis: {
    currencyCode: 'CZK',
    eligibleAmount: '100.0072',
    recipients: [
      { intermediateValue: money('9.7097'), occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' },
      { intermediateValue: money('90.2975'), occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' },
    ],
  },
  originalContribution: money('-100'),
  precision,
  source: source('PRICING_WHOLE_PURCHASE_CONTRACTUAL'),
});

describe('Pricing Discount and Fee allocation service', () => {
  it.effect('preserves an authoritative exact allocation without redistributing it', () =>
    Effect.gen(function* preservesOwnerAllocation() {
      const request: PricingOwnerExactAllocationRequest = {
        allocationKind: 'OWNER_EXACT',
        decision,
        originalContribution: money('-5'),
        ownerAllocations: [allocation('line-b', '-3'), allocation('line-a', '-2')],
        ownerScope: 'MULTI_LINE',
        precision,
        source: source('OWNER_EXACT'),
      };

      const result = yield* allocatePricingDiscountsAndFees(request);

      expect(result).toEqual({
        allocations: request.ownerAllocations,
        outcome: 'ALLOCATION_APPLIED',
        request,
        sumInvariant: 'ALLOCATIONS_SUM_TO_ORIGINAL_CONTRIBUTION',
      });
    }),
  );

  it.effect('allocates generic contributions proportionally in stable recipient order', () =>
    Effect.gen(function* allocatesGenericContribution() {
      const reversed = genericRequest([basis('line-b', '3'), basis('line-a', '1')]);
      const ordered = genericRequest([basis('line-a', '1'), basis('line-b', '3')]);

      const first = yield* allocatePricingDiscountsAndFees(reversed);
      const second = yield* allocatePricingDiscountsAndFees(ordered);

      expect(first.outcome).toBe('ALLOCATION_APPLIED');
      expect(second.outcome).toBe('ALLOCATION_APPLIED');
      if (first.outcome === 'ALLOCATION_APPLIED' && second.outcome === 'ALLOCATION_APPLIED') {
        expect(first.allocations).toEqual([allocation('line-a', '-2.5'), allocation('line-b', '-7.5')]);
        expect(second.allocations).toEqual(first.allocations);
      }
    }),
  );

  it.effect('uses locale-independent code-unit order for a tied non-ASCII remainder', () =>
    Effect.gen(function* allocatesTiedUnicodeRecipients() {
      const first: PricingGenericAllocationRequest = {
        ...genericRequest([basis('line-ä', '1'), basis('line-z', '1')], '-0.000000000000000001'),
        decision: unicodeDecision,
      };
      const second: PricingGenericAllocationRequest = {
        ...genericRequest([basis('line-z', '1'), basis('line-ä', '1')], '-0.000000000000000001'),
        decision: unicodeDecision,
      };

      const firstResult = yield* allocatePricingDiscountsAndFees(first);
      const secondResult = yield* allocatePricingDiscountsAndFees(second);

      expect(firstResult.outcome).toBe('ALLOCATION_APPLIED');
      expect(secondResult.outcome).toBe('ALLOCATION_APPLIED');
      if (firstResult.outcome === 'ALLOCATION_APPLIED' && secondResult.outcome === 'ALLOCATION_APPLIED') {
        expect(firstResult.allocations).toEqual([
          allocation('line-z', '-0.000000000000000001'),
          allocation('line-ä', '0'),
        ]);
        expect(secondResult.allocations).toEqual(firstResult.allocations);
      }
    }),
  );

  it.effect('returns a typed failure instead of guessing an equal split for zero generic basis', () =>
    Effect.gen(function* rejectsZeroBasis() {
      const request = genericRequest([basis('line-a', '0'), basis('line-b', '0')]);

      expect(yield* allocatePricingDiscountsAndFees(request)).toEqual({
        outcome: 'ALLOCATION_FAILED',
        reason: 'GENERIC_ZERO_BASIS',
        request,
      });
    }),
  );

  it.effect('preserves the full contractual contribution and every recipient capacity for the sub-cent fixture', () =>
    Effect.gen(function* preservesSubCentCapacity() {
      const request = wholeRequest();

      const result = yield* allocatePricingDiscountsAndFees(request);

      expect(result.outcome).toBe('ALLOCATION_APPLIED');
      if (result.outcome === 'ALLOCATION_APPLIED') {
        expect(result.capacityInvariant).toBe('EVERY_ALLOCATION_WITHIN_ELIGIBLE_INTERMEDIATE');
        expect(result.allocations).toEqual([
          allocation('line-a', '-9.709000951931460935'),
          allocation('line-b', '-90.290999048068539065'),
        ]);
      }
    }),
  );

  it.effect('preserves B <= D as known non-applicability', () =>
    Effect.gen(function* preservesKnownNonApplicability() {
      const request: PricingWholePurchaseContractualNotApplicableRequest = {
        allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL_NOT_APPLICABLE',
        configuredDiscount: money('100.0072'),
        decision,
        eligibleBasis: {
          currencyCode: 'CZK',
          eligibleAmount: '100.0072',
          recipients: [
            { intermediateValue: money('9.7097'), occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' },
            { intermediateValue: money('90.2975'), occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' },
          ],
        },
        reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT',
        source: source('PRICING_WHOLE_PURCHASE_CONTRACTUAL'),
      };

      expect(yield* allocatePricingDiscountsAndFees(request)).toEqual({
        outcome: 'ALLOCATION_NOT_APPLICABLE',
        request,
      });
    }),
  );

  it.effect('types output-grid precision loss and amount overflow separately', () =>
    Effect.gen(function* typesNumericFailures() {
      const unsupported = genericRequest([basis('line-a', '1'), basis('line-b', '1')], '-1.0000000000000000001');
      const overflow = genericRequest(
        [basis('line-a', '1'), basis('line-b', '1')],
        '-10000000000000000000000000000000000000000000000000000000000',
      );
      const aggregateOverflow = genericRequest([
        basis('line-a', '9999999999999999999999999999999999999999999999999999999999'),
        basis('line-b', '9999999999999999999999999999999999999999999999999999999999'),
      ]);

      expect(yield* allocatePricingDiscountsAndFees(unsupported)).toEqual({
        outcome: 'ALLOCATION_FAILED',
        reason: 'PRECISION_UNSUPPORTED',
        request: unsupported,
      });
      expect(yield* allocatePricingDiscountsAndFees(overflow)).toEqual({
        outcome: 'ALLOCATION_FAILED',
        reason: 'ARITHMETIC_OVERFLOW',
        request: overflow,
      });
      expect(yield* allocatePricingDiscountsAndFees(aggregateOverflow)).toEqual({
        outcome: 'ALLOCATION_FAILED',
        reason: 'ARITHMETIC_OVERFLOW',
        request: aggregateOverflow,
      });
    }),
  );
});
