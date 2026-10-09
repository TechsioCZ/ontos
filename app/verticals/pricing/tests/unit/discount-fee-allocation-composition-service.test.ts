import type { PricingAllocationPrecision } from '@app/pricing-contracts/domain/discount-fee-allocation';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { composePricingDiscountFeeAllocations } from '../../src/services/discount-fee-allocation-composition.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
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
      observedAt: '2026-09-28T08:00:00.000Z',
      ownerRevision: 'catalog-quantity:17',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
    },
    divisible: false,
    equivalentSelectionKey: 'catalog-selection:exact',
    evidence: {
      assessedAt: '2026-09-28T08:00:00.000Z',
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
        observedAt: '2026-09-28T08:00:00.000Z',
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
    channelId: 'B2C',
    marketId: 'market-cz',
    sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
  },
  currencyCode: 'CZK' as const,
  lines: [line('line-a'), line('line-b')],
  monetaryBoundary: 'PRE_TAX' as const,
  operationTime: '2026-09-28T08:00:00.000Z',
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
const precision = {
  allocationScale: 18,
  amountPrecision: 76,
  contractVersion: 'pricing-allocation-v1',
  remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC',
} satisfies PricingAllocationPrecision;
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });

const feeResult = (occurrenceId: string, baseLineValue: string, feeAmount: string) => ({
  contributions: [
    {
      amount: money(feeAmount),
      fee: {
        definition: {
          feeRef: { moduleId: 'commerce.pricing', resourceId: `fee-${occurrenceId}` },
          revision: { revisionId: `fee-${occurrenceId}-r1` },
        },
      },
      occurrenceId,
    },
  ],
  contributionTotal: money(feeAmount),
  discountableLineBasis: money(String(Number(baseLineValue) + Number(feeAmount))),
  input: { baseLineValue: money(baseLineValue), decision, occurrenceId },
  outcome: 'COMMERCIAL_FEES_APPLIED' as const,
});

const discountComposition = {
  lineContributions: [
    {
      amount: money('-3'),
      basis: {
        amount: money('12'),
        applicablePricingFeeTotal: money('2'),
        baseLineValue: money('10'),
        occurrenceId: 'line-a',
      },
      candidate: {
        definition: {
          discountId: 'discount-line-a',
          revision: { revisionId: 'discount-line-a-r1' },
        },
        occurrenceId: 'line-a',
      },
    },
  ],
  outcome: 'DISCOUNT_COMPOSITION_READY',
  request: {
    decision,
    lineBases: [
      {
        amount: money('12'),
        applicablePricingFeeTotal: money('2'),
        baseLineValue: money('10'),
        occurrenceId: 'line-a',
      },
      {
        amount: money('6'),
        applicablePricingFeeTotal: money('1'),
        baseLineValue: money('5'),
        occurrenceId: 'line-b',
      },
    ],
  },
} as const;

describe('Pricing Discount/Fee allocation composition', () => {
  it.effect('preserves line-native Fee and Discount evidence without applying either contribution twice', () =>
    Effect.gen(function* preservesLineNativeEvidence() {
      const result = yield* composePricingDiscountFeeAllocations({
        discountComposition,
        feeResults: [feeResult('line-a', '10', '2'), feeResult('line-b', '5', '1')],
        precision,
        recipientClassifications: [
          { occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' },
          { occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' },
        ],
      });

      expect(result).toMatchObject({
        composedLines: [
          {
            occurrenceId: 'line-a',
            preAllocationIntermediateValue: money('9'),
            rawPostAllocationValue: money('9'),
          },
          {
            occurrenceId: 'line-b',
            preAllocationIntermediateValue: money('6'),
            rawPostAllocationValue: money('6'),
          },
        ],
        decision,
        lineIntermediates: [
          {
            feeContributions: [{ amount: money('2') }],
            lineDiscountContributions: [{ amount: money('-3') }],
            occurrenceId: 'line-a',
            value: money('9'),
          },
          {
            feeContributions: [{ amount: money('1') }],
            lineDiscountContributions: [],
            occurrenceId: 'line-b',
            value: money('6'),
          },
        ],
        outcome: 'ALLOCATION_COMPOSITION_READY',
      });
      expect(result.allocationResults).toHaveLength(3);
      expect(
        result.allocationResults.every(
          (allocationResult) =>
            allocationResult.outcome === 'ALLOCATION_APPLIED' &&
            allocationResult.request.allocationKind === 'OWNER_EXACT' &&
            allocationResult.request.ownerScope === 'LINE_NATIVE',
        ),
      ).toBe(true);
    }),
  );
});
