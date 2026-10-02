import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PRICING_ALLOCATION_CONTRACT_VERSION,
  PricingAllocationFailureSchema,
  PricingAllocationNotApplicableSchema,
  PricingAllocationResultSchema,
  PricingGenericAllocationRequestSchema,
  PricingOwnerExactAllocationRequestSchema,
  PricingWholePurchaseContractualAllocationRequestSchema,
  PricingWholePurchaseContractualNotApplicableRequestSchema,
} from '../../src/domain/discount-fee-allocation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const selection = { productRef, variantRef };
const catalogEvidence = {
  assessedAt: '2026-09-28T07:59:59.000Z',
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
    { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 2 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: productRef, revision: 1 },
    },
  ],
  membership: {
    attestationId: '12121212-1212-4212-8212-121212121212',
    observedAt: '2026-09-28T07:59:59.000Z',
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection,
  status: 'VALID' as const,
};
const catalog = (quantity: string) => ({
  completeness: {
    observedAt: '2026-09-28T07:59:59.000Z',
    ownerRevision: 'catalog-quantity:17',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
  },
  divisible: false,
  equivalentSelectionKey: 'catalog-selection:exact',
  evidence: catalogEvidence,
  hierarchyRevision: 'catalog-hierarchy:9',
  ownerRevision: 'catalog-quantity:17',
  quantity: {
    changed: false,
    notice: null,
    requested: quantity,
    resulting: quantity,
    rounding: 'HALF_UP' as const,
    status: 'VALID' as const,
    step: '1',
    targetId: variantRef.resourceId,
    tenantId,
    unitId: unitRef.resourceId,
    unitRuleRevision: 7,
  },
  quantityBasis: {
    targetDivisibilityRevision: 3,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 7,
  },
  selection,
  status: 'READY' as const,
  unitRef,
});
const line = (occurrenceId: string) => ({
  catalog: catalog('1'),
  occurrenceId,
  pricingBasis: { quantity: '1', unitRef },
});
const decision = {
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
      kind: 'GUEST' as const,
    },
    commercialSettingsDecision: {
      decisionRef: 'purchase-commercial-settings:1',
      decisionRevision: 'purchase-commercial-settings-revision:1',
    },
    contextRef: 'purchase-1',
    contextRevision: 'purchase-r1',
    currencyResolution: {
      currencyCode: 'CZK' as const,
      resolutionRef: 'purchase-currency-resolution:1',
      resolutionRevision: 'purchase-currency-resolution-revision:1',
    },
    subject: {
      guestEvidenceRef: 'guest-evidence:1',
      guestSessionRef: 'guest-session:1',
      kind: 'GUEST' as const,
    },
  },
  tenantId,
};
const precision = {
  allocationScale: 18,
  amountPrecision: 76,
  contractVersion: PRICING_ALLOCATION_CONTRACT_VERSION,
  remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC' as const,
};
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
const basis = (occurrenceId: string, amount: string) => ({
  baseLineValue: money(amount),
  occurrenceId,
  recipientKind: 'MERCHANDISE' as const,
});
const allocation = (occurrenceId: string, amount: string) => ({
  amount: money(amount),
  occurrenceId,
  recipientKind: 'MERCHANDISE' as const,
});
const decodeOwner = Schema.decodeUnknownSync(PricingOwnerExactAllocationRequestSchema);
const decodeGeneric = Schema.decodeUnknownSync(PricingGenericAllocationRequestSchema);
const decodeWhole = Schema.decodeUnknownSync(PricingWholePurchaseContractualAllocationRequestSchema);
const decodeNotApplicableRequest = Schema.decodeUnknownSync(PricingWholePurchaseContractualNotApplicableRequestSchema);
const decodeResult = Schema.decodeUnknownSync(PricingAllocationResultSchema);
const decodeFailure = Schema.decodeUnknownSync(PricingAllocationFailureSchema);

describe('Pricing Discount and Fee allocation contracts (#774)', () => {
  it('preserves line-native and owner-issued exact allocations without redistribution', () => {
    const lineNative = {
      allocationKind: 'OWNER_EXACT' as const,
      decision,
      originalContribution: money('-3.25'),
      ownerAllocations: [allocation('line-a', '-3.25')],
      ownerScope: 'LINE_NATIVE' as const,
      precision,
      source: source('LINE_NATIVE'),
    };
    expect(decodeOwner(lineNative)).toEqual(lineNative);

    const ownerExact = {
      ...lineNative,
      originalContribution: money('-5'),
      ownerAllocations: [allocation('line-a', '-2'), allocation('line-b', '-3')],
      ownerScope: 'MULTI_LINE' as const,
      source: source('OWNER_EXACT'),
    };
    expect(decodeOwner(ownerExact)).toEqual(ownerExact);
    expect(() => decodeOwner({ ...ownerExact, ownerAllocations: [allocation('line-a', '-2')] })).toThrow();
  });

  it('allows generic allocation only through an explicit owner permission and types zero basis', () => {
    const request = {
      allocationKind: 'GENERIC_PROPORTIONAL' as const,
      basisKind: 'ELIGIBLE_BASE_LINE_VALUE' as const,
      decision,
      eligibleRecipients: [basis('line-b', '0'), basis('line-a', '0')],
      originalContribution: money('-10'),
      precision,
      source: source('GENERIC_SUPPORTED'),
    };
    expect(decodeGeneric(request)).toEqual(request);
    expect(
      decodeFailure({
        outcome: 'ALLOCATION_FAILED',
        reason: 'GENERIC_ZERO_BASIS',
        request,
      }),
    ).toEqual({ outcome: 'ALLOCATION_FAILED', reason: 'GENERIC_ZERO_BASIS', request });
    expect(() =>
      decodeGeneric({ ...request, source: { ...request.source, allocationAuthority: 'OWNER_EXACT' } }),
    ).toThrow();
  });

  it('breaks equal remainders by locale-independent UTF-16 recipient identity order', () => {
    const unicodeDecision = {
      ...decision,
      lines: [line('line-ä'), line('line-z')],
    };
    const request = {
      allocationKind: 'GENERIC_PROPORTIONAL' as const,
      basisKind: 'ELIGIBLE_BASE_LINE_VALUE' as const,
      decision: unicodeDecision,
      eligibleRecipients: [basis('line-ä', '1'), basis('line-z', '1')],
      originalContribution: money('-0.000000000000000001'),
      precision,
      source: source('GENERIC_SUPPORTED'),
    };
    const applied = {
      allocations: [allocation('line-ä', '0'), allocation('line-z', '-0.000000000000000001')],
      outcome: 'ALLOCATION_APPLIED' as const,
      request,
      sumInvariant: 'ALLOCATIONS_SUM_TO_ORIGINAL_CONTRIBUTION' as const,
    };

    expect(decodeResult(applied)).toEqual(applied);
    expect(() =>
      decodeResult({
        ...applied,
        allocations: [allocation('line-ä', '-0.000000000000000001'), allocation('line-z', '0')],
      }),
    ).toThrow();
  });

  it('accepts B>D whole-purchase allocation with exact sum and every recipient within capacity', () => {
    const request = {
      allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL' as const,
      decision,
      eligibleBasis: {
        currencyCode: 'CZK' as const,
        eligibleAmount: '100.0072',
        recipients: [
          { intermediateValue: money('9.7097'), occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' as const },
          { intermediateValue: money('90.2975'), occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' as const },
        ],
      },
      originalContribution: money('-100'),
      precision,
      source: source('PRICING_WHOLE_PURCHASE_CONTRACTUAL'),
    };
    expect(decodeWhole(request)).toEqual(request);

    const applied = {
      allocations: [allocation('line-b', '-90.290999048068539065'), allocation('line-a', '-9.709000951931460935')],
      capacityInvariant: 'EVERY_ALLOCATION_WITHIN_ELIGIBLE_INTERMEDIATE' as const,
      outcome: 'ALLOCATION_APPLIED' as const,
      request,
      sumInvariant: 'ALLOCATIONS_SUM_TO_ORIGINAL_CONTRIBUTION' as const,
    };
    expect(decodeResult(applied)).toEqual(applied);
    expect(() =>
      decodeResult({
        ...applied,
        allocations: [allocation('line-a', '-9.71'), allocation('line-b', '-90.29')],
      }),
    ).toThrow();
  });

  it('models B<D and B=D as known non-applicability without a contribution or allocation', () => {
    for (const configuredDiscount of ['101', '100.0072']) {
      const request = {
        allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL_NOT_APPLICABLE' as const,
        configuredDiscount: money(configuredDiscount),
        decision,
        eligibleBasis: {
          currencyCode: 'CZK' as const,
          eligibleAmount: '100.0072',
          recipients: [
            { intermediateValue: money('9.7097'), occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' as const },
            { intermediateValue: money('90.2975'), occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' as const },
          ],
        },
        reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT' as const,
        source: source('PRICING_WHOLE_PURCHASE_CONTRACTUAL'),
      };
      expect(decodeNotApplicableRequest(request)).toEqual(request);
      expect(
        Schema.decodeUnknownSync(PricingAllocationNotApplicableSchema)({
          outcome: 'ALLOCATION_NOT_APPLICABLE',
          request,
        }),
      ).toEqual({
        outcome: 'ALLOCATION_NOT_APPLICABLE',
        request,
      });
    }
  });

  it('uses typed precision and overflow failures instead of a fabricated applied result', () => {
    const request = {
      allocationKind: 'GENERIC_PROPORTIONAL' as const,
      basisKind: 'ELIGIBLE_BASE_LINE_VALUE' as const,
      decision,
      eligibleRecipients: [basis('line-a', '1'), basis('line-b', '1')],
      originalContribution: money('-1.0000000000000000001'),
      precision,
      source: source('GENERIC_SUPPORTED'),
    };
    for (const reason of ['PRECISION_UNSUPPORTED', 'ARITHMETIC_OVERFLOW'] as const) {
      expect(decodeFailure({ outcome: 'ALLOCATION_FAILED', reason, request })).toEqual({
        outcome: 'ALLOCATION_FAILED',
        reason,
        request,
      });
    }
  });
});
