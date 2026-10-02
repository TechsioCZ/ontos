import type {
  PricingAllocationApplied,
  PricingAllocationRequest,
  PricingAllocationResult,
  PricingGenericAllocationRequest,
  PricingOwnerExactAllocationRequest,
  PricingWholePurchaseContractualAllocationRequest,
  PricingWholePurchaseContractualNotApplicableRequest,
} from '@app/pricing-contracts/domain/discount-fee-allocation';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PricingDiscountFeeAllocationCompositionInput } from '../../src/services/discount-fee-allocation-composition.service.ts';
import { allocatePricingDiscountsAndFees } from '../../src/services/discount-fee-allocation.service.ts';
import { composePricingDiscountFeeAllocations } from '../../src/services/discount-fee-allocation-composition.service.ts';

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
      ownerRevision: 'catalog-quantity:774',
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
    hierarchyRevision: 'catalog-hierarchy:774',
    ownerRevision: 'catalog-quantity:774',
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
const decisionFor = (occurrenceIds: readonly string[]) =>
  Schema.decodeSync(PricingDecisionSchema)({
    commercialScope: {
      channelId: 'B2C',
      marketId: 'market-cz',
      sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
    },
    currencyCode: 'CZK',
    lines: occurrenceIds.map(line),
    monetaryBoundary: 'PRE_TAX',
    operationTime,
    purchasingContext: {
      accessDecision: {
        decisionRef: 'purchase-access-decision:774',
        decisionRevision: 'purchase-access-decision-revision:774',
      },
      actor: {
        guestEvidenceRef: 'guest-evidence:774',
        guestSessionRef: 'guest-session:774',
        kind: 'GUEST',
      },
      commercialSettingsDecision: {
        decisionRef: 'purchase-commercial-settings:774',
        decisionRevision: 'purchase-commercial-settings-revision:774',
      },
      contextRef: 'purchase-774',
      contextRevision: 'purchase-r774',
      currencyResolution: {
        currencyCode: 'CZK',
        resolutionRef: 'purchase-currency-resolution:774',
        resolutionRevision: 'purchase-currency-resolution-revision:774',
      },
      subject: {
        guestEvidenceRef: 'guest-evidence:774',
        guestSessionRef: 'guest-session:774',
        kind: 'GUEST',
      },
    },
    tenantId,
  });
const precision = {
  allocationScale: 18,
  amountPrecision: 76,
  contractVersion: 'pricing-allocation-v1' as const,
  remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC' as const,
} as const;
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const foreignMoney = (amount: string) => ({ amount, currencyCode: 'EUR' });
const allocation = (occurrenceId: string, amount: string) => ({
  amount: money(amount),
  occurrenceId,
  recipientKind: 'MERCHANDISE' as const,
});
const source = (
  allocationAuthority: 'GENERIC_SUPPORTED' | 'LINE_NATIVE' | 'OWNER_EXACT' | 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
  sourceKind: 'PRICING_DISCOUNT' | 'PRICING_FEE' | 'PROMOTION' | 'OTHER_OWNER' = 'PRICING_DISCOUNT',
) => ({
  allocationAuthority,
  logicalFactRef: 'discount-774',
  ownerModuleId: 'commerce.pricing',
  revisionRef: 'discount-r774',
  sourceKind,
});
const genericRequest = (
  weights: readonly (readonly [occurrenceId: string, amount: string])[],
  originalContribution: string,
): PricingGenericAllocationRequest => ({
  allocationKind: 'GENERIC_PROPORTIONAL',
  basisKind: 'ELIGIBLE_BASE_LINE_VALUE',
  decision: decisionFor(weights.map(([occurrenceId]) => occurrenceId)),
  eligibleRecipients: weights.map(([occurrenceId, amount]) => ({
    baseLineValue: money(amount),
    occurrenceId,
    recipientKind: 'MERCHANDISE',
  })),
  originalContribution: money(originalContribution),
  precision,
  source: source('GENERIC_SUPPORTED', 'OTHER_OWNER'),
});
const wholeRequest = (): PricingWholePurchaseContractualAllocationRequest => ({
  allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL',
  decision: decisionFor(['line-a', 'line-b']),
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
const scaled = (value: string): bigint => {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const coefficient = BigInt(`${whole}${fraction.padEnd(18, '0')}`);
  return negative ? -coefficient : coefficient;
};
const applied = (result: PricingAllocationResult): PricingAllocationApplied => {
  if (result.outcome !== 'ALLOCATION_APPLIED') {
    throw new Error('Expected an applied allocation');
  }
  return result;
};

const feeResult = (decision: ReturnType<typeof decisionFor>, occurrenceId: string, amount: string) => ({
  contributions: [],
  contributionTotal: money('0'),
  discountableLineBasis: money(amount),
  input: { baseLineValue: money(amount), decision, occurrenceId },
  outcome: 'COMMERCIAL_FEES_APPLIED' as const,
});
const feeContribution = (occurrenceId: string, amount: string) => ({
  amount: money(amount),
  fee: {
    definition: {
      feeRef: { moduleId: 'commerce.pricing', resourceId: `fee-${occurrenceId}` },
      revision: { revisionId: `fee-${occurrenceId}-r774` },
    },
  },
  occurrenceId,
});

const wholePurchaseComposition = () => {
  const decision = decisionFor(['line-a', 'line-b', 'line-zero', 'line-shipping']);
  const eligibleBasis = {
    currencyCode: 'CZK' as const,
    eligibleAmount: '100.0072',
    recipients: [
      { intermediateValue: money('9.7097'), occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' as const },
      { intermediateValue: money('90.2975'), occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' as const },
    ],
  };
  const discountComposition = {
    lineContributions: [],
    outcome: 'DISCOUNT_COMPOSITION_READY',
    request: {
      decision,
      lineBases: [
        {
          amount: money('9.7097'),
          applicablePricingFeeTotal: money('0'),
          baseLineValue: money('9.7097'),
          occurrenceId: 'line-a',
        },
        {
          amount: money('90.2975'),
          applicablePricingFeeTotal: money('0'),
          baseLineValue: money('90.2975'),
          occurrenceId: 'line-b',
        },
        {
          amount: money('0'),
          applicablePricingFeeTotal: money('0'),
          baseLineValue: money('0'),
          occurrenceId: 'line-zero',
        },
        {
          amount: money('50'),
          applicablePricingFeeTotal: money('0'),
          baseLineValue: money('50'),
          occurrenceId: 'line-shipping',
        },
      ],
    },
    wholePurchaseContribution: {
      amount: money('-100'),
      applicationCount: 'ONCE_PER_PRICING_DECISION',
      candidate: {
        applicability: { basis: eligibleBasis },
        definition: {
          discountId: 'discount-whole-774',
          revision: { revisionId: 'discount-whole-r774' },
        },
      },
    },
  } as const;
  return {
    decision,
    discountComposition,
    eligibleBasis,
    feeResults: [
      feeResult(decision, 'line-a', '9.7097'),
      feeResult(decision, 'line-b', '90.2975'),
      feeResult(decision, 'line-zero', '0'),
      feeResult(decision, 'line-shipping', '50'),
    ],
    recipientClassifications: [
      { occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' as const },
      { occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' as const },
      { occurrenceId: 'line-zero', recipientKind: 'MERCHANDISE' as const },
      { occurrenceId: 'line-shipping', recipientKind: 'SHIPPING' as const },
    ],
  };
};
const withoutWholePurchase = (fixture: ReturnType<typeof wholePurchaseComposition>) => ({
  lineContributions: fixture.discountComposition.lineContributions,
  outcome: fixture.discountComposition.outcome,
  request: fixture.discountComposition.request,
});
const integrityComposition = () => {
  const decision = decisionFor(['line-a', 'line-b']);
  const lineContribution = {
    amount: money('-3'),
    basis: { amount: money('12'), occurrenceId: 'line-a' },
    candidate: {
      definition: { discountId: 'discount-line-a', revision: { revisionId: 'discount-line-a-r774' } },
      occurrenceId: 'line-a',
    },
  };
  const discountComposition = {
    lineContributions: [lineContribution],
    outcome: 'DISCOUNT_COMPOSITION_READY' as const,
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
  };
  const lineAFee = {
    ...feeResult(decision, 'line-a', '10'),
    contributions: [feeContribution('line-a', '2')],
    contributionTotal: money('2'),
    discountableLineBasis: money('12'),
  };
  const lineBFee = {
    ...feeResult(decision, 'line-b', '5'),
    contributions: [feeContribution('line-b', '1')],
    contributionTotal: money('1'),
    discountableLineBasis: money('6'),
  };
  return {
    decision,
    discountComposition,
    feeResults: [lineAFee, lineBFee],
    lineAFee,
    lineBFee,
    lineContribution,
    recipientClassifications: [
      { occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' as const },
      { occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' as const },
    ],
  };
};
const expectCompositionRejection = (
  input: PricingDiscountFeeAllocationCompositionInput,
  code:
    | 'COMPOSITION_BASIS_UNVERIFIABLE'
    | 'COMPOSITION_INPUT_INVALID'
    | 'COMPOSITION_OWNER_IDENTITY_CONFLICT' = 'COMPOSITION_BASIS_UNVERIFIABLE',
) =>
  Effect.flip(composePricingDiscountFeeAllocations(input)).pipe(
    Effect.map((failure) => expect(failure).toMatchObject({ code })),
  );

describe('Issue #774 Pricing Discount and Fee allocation acceptance', () => {
  it.effect('preserves line-native and owner-issued exact allocations without recomputation', () =>
    Effect.gen(function* preservesOwnerAllocations() {
      const lineNative: PricingOwnerExactAllocationRequest = {
        allocationKind: 'OWNER_EXACT',
        decision: decisionFor(['line-a']),
        originalContribution: money('2.25'),
        ownerAllocations: [allocation('line-a', '2.25')],
        ownerScope: 'LINE_NATIVE',
        precision,
        source: source('LINE_NATIVE', 'PRICING_FEE'),
      };
      const ownerExact: PricingOwnerExactAllocationRequest = {
        allocationKind: 'OWNER_EXACT',
        decision: decisionFor(['line-a', 'line-b']),
        originalContribution: money('-5'),
        ownerAllocations: [allocation('line-b', '-3'), allocation('line-a', '-2')],
        ownerScope: 'MULTI_LINE',
        precision,
        source: source('OWNER_EXACT', 'PROMOTION'),
      };

      const lineResult = applied(yield* allocatePricingDiscountsAndFees(lineNative));
      const exactResult = applied(yield* allocatePricingDiscountsAndFees(ownerExact));

      expect(lineResult.allocations).toEqual(lineNative.ownerAllocations);
      expect(exactResult.allocations).toEqual(ownerExact.ownerAllocations);
      expect(exactResult.request.source).toEqual(ownerExact.source);
      expect(exactResult.request.originalContribution).toEqual(ownerExact.originalContribution);
    }),
  );

  it.effect('fails generic zero basis instead of equal splitting, absolute weighting, or clamping', () =>
    Effect.gen(function* rejectsZeroGenericBasis() {
      const request = genericRequest(
        [
          ['line-a', '0'],
          ['line-b', '0.000'],
        ],
        '-10',
      );

      expect(yield* allocatePricingDiscountsAndFees(request)).toEqual({
        outcome: 'ALLOCATION_FAILED',
        reason: 'GENERIC_ZERO_BASIS',
        request,
      });
    }),
  );

  it.effect('models B<D and B=D as known non-applicability, while B>D applies the full D', () =>
    Effect.gen(function* enforcesStrictThreshold() {
      const applicable = applied(yield* allocatePricingDiscountsAndFees(wholeRequest()));
      expect(applicable.allocations).toEqual([
        allocation('line-a', '-9.709000951931460935'),
        allocation('line-b', '-90.290999048068539065'),
      ]);

      for (const configuredDiscount of ['100.0072', '101']) {
        const request: PricingWholePurchaseContractualNotApplicableRequest = {
          allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL_NOT_APPLICABLE',
          configuredDiscount: money(configuredDiscount),
          decision: wholeRequest().decision,
          eligibleBasis: wholeRequest().eligibleBasis,
          reason: 'BASIS_NOT_GREATER_THAN_DISCOUNT',
          source: source('PRICING_WHOLE_PURCHASE_CONTRACTUAL'),
        };
        expect(yield* allocatePricingDiscountsAndFees(request)).toEqual({
          outcome: 'ALLOCATION_NOT_APPLICABLE',
          request,
        });
      }
    }),
  );

  it.effect('proves the mandatory sub-cent fixture preserves full D and every recipient capacity', () =>
    Effect.gen(function* provesSubCentInvariant() {
      const request = wholeRequest();
      const result = applied(yield* allocatePricingDiscountsAndFees(request));
      const amounts = new Map(result.allocations.map((entry) => [entry.occurrenceId, entry.amount.amount]));

      expect(result.sumInvariant).toBe('ALLOCATIONS_SUM_TO_ORIGINAL_CONTRIBUTION');
      expect(result.capacityInvariant).toBe('EVERY_ALLOCATION_WITHIN_ELIGIBLE_INTERMEDIATE');
      expect(result.allocations.reduce((sum, entry) => sum + scaled(entry.amount.amount), 0n)).toBe(scaled('-100'));
      expect(-scaled(amounts.get('line-a') ?? '0')).toBeLessThanOrEqual(scaled('9.7097'));
      expect(-scaled(amounts.get('line-b') ?? '0')).toBeLessThanOrEqual(scaled('90.2975'));
      expect(scaled('9.7097') + scaled(amounts.get('line-a') ?? '0')).toBeGreaterThanOrEqual(0n);
      expect(scaled('90.2975') + scaled(amounts.get('line-b') ?? '0')).toBeGreaterThanOrEqual(0n);
      expect(yield* encodeUnknownJson(result)).not.toMatch(/ZERO_FLOOR|clamp/iu);
    }),
  );

  it.effect('is independent of input order and uses stable occurrence IDs for tied remainders', () =>
    Effect.gen(function* provesStableOrder() {
      const forward = genericRequest(
        [
          ['line-c', '1'],
          ['line-a', '1'],
          ['line-b', '1'],
        ],
        '-1',
      );
      const reverse = genericRequest(
        forward.eligibleRecipients
          .toReversed()
          .map(({ baseLineValue, occurrenceId }) => [occurrenceId, baseLineValue.amount]),
        '-1',
      );
      const forwardResult = applied(yield* allocatePricingDiscountsAndFees(forward));
      const reverseResult = applied(yield* allocatePricingDiscountsAndFees(reverse));

      expect(forwardResult.allocations).toEqual(reverseResult.allocations);
      expect(forwardResult.allocations.map(({ occurrenceId }) => occurrenceId)).toEqual(['line-a', 'line-b', 'line-c']);
      expect(forwardResult.allocations).toEqual([
        allocation('line-a', '-0.333333333333333334'),
        allocation('line-b', '-0.333333333333333333'),
        allocation('line-c', '-0.333333333333333333'),
      ]);
    }),
  );

  it.effect('preserves exact sums and deterministic results across bounded proportional cases', () =>
    Effect.gen(function* checksBoundedCases() {
      let state = 1908;
      const randomUint = (): number => {
        state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
        return state;
      };

      for (let caseIndex = 0; caseIndex < 48; caseIndex += 1) {
        const recipientCount = 2 + (randomUint() % 5);
        const weights: (readonly [string, string])[] = [];
        for (let index = 0; index < recipientCount; index += 1) {
          weights.push([
            `case-${caseIndex.toString().padStart(2, '0')}-line-${index.toString().padStart(2, '0')}`,
            String(1 + (randomUint() % 10_000)),
          ]);
        }
        const contribution = `-${String(1 + (randomUint() % 1_000_000))}`;
        const request = genericRequest(weights, contribution);
        const reversed = genericRequest(weights.toReversed(), contribution);
        const result = applied(yield* allocatePricingDiscountsAndFees(request));
        const reversedResult = applied(yield* allocatePricingDiscountsAndFees(reversed));

        expect(result.allocations).toEqual(reversedResult.allocations);
        expect(result.allocations.reduce((sum, entry) => sum + scaled(entry.amount.amount), 0n)).toBe(
          scaled(contribution),
        );
        expect(new Set(result.allocations.map(({ occurrenceId }) => occurrenceId)).size).toBe(recipientCount);
      }
    }),
  );

  it.effect(
    'keeps evidence, currency, contribution, and allocations in one result without duplicate total application',
    () =>
      Effect.gen(function* preservesEvidence() {
        const request: PricingAllocationRequest = wholeRequest();
        const result = applied(yield* allocatePricingDiscountsAndFees(request));
        const serialized = yield* encodeUnknownJson(result);

        expect(result.request).toEqual(request);
        expect(result.request.source).toEqual(source('PRICING_WHOLE_PURCHASE_CONTRACTUAL'));
        expect(result.allocations.every(({ amount }) => amount.currencyCode === request.decision.currencyCode)).toBe(
          true,
        );
        expect(serialized.match(/"originalContribution"/gu)).toHaveLength(1);
        expect(serialized).not.toMatch(/EUR|exchangeRate|fxRate/iu);
      }),
  );

  it.effect('composes one whole-purchase fixed effect once while excluding zero and Shipping recipients', () =>
    Effect.gen(function* composesWholePurchaseOnce() {
      const fixture = wholePurchaseComposition();
      const result = yield* composePricingDiscountFeeAllocations({
        discountComposition: fixture.discountComposition,
        feeResults: fixture.feeResults,
        precision,
        recipientClassifications: fixture.recipientClassifications,
      });

      expect(result.outcome).toBe('ALLOCATION_COMPOSITION_READY');
      if (result.outcome !== 'ALLOCATION_COMPOSITION_READY') {
        throw new Error('Expected whole-purchase allocation composition to succeed');
      }
      const wholeResults = result.allocationResults.filter(
        (entry) =>
          entry.outcome === 'ALLOCATION_APPLIED' && entry.request.allocationKind === 'WHOLE_PURCHASE_CONTRACTUAL',
      );
      expect(wholeResults).toHaveLength(1);
      expect(wholeResults[0]?.request.source).toEqual({
        allocationAuthority: 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
        logicalFactRef: 'discount-whole-774',
        ownerModuleId: 'commerce.pricing',
        revisionRef: 'discount-whole-r774',
        sourceKind: 'PRICING_DISCOUNT',
      });
      expect(result.composedLines).toMatchObject([
        {
          multiLineAllocations: [allocation('line-a', '-9.709000951931460935')],
          occurrenceId: 'line-a',
          preAllocationIntermediateValue: money('9.7097'),
          rawPostAllocationValue: money('0.000699048068539065'),
        },
        {
          multiLineAllocations: [allocation('line-b', '-90.290999048068539065')],
          occurrenceId: 'line-b',
          preAllocationIntermediateValue: money('90.2975'),
          rawPostAllocationValue: money('0.006500951931460935'),
        },
        {
          multiLineAllocations: [],
          occurrenceId: 'line-zero',
          rawPostAllocationValue: money('0'),
        },
        {
          multiLineAllocations: [],
          occurrenceId: 'line-shipping',
          rawPostAllocationValue: money('50'),
        },
      ]);
      expect(
        result.composedLines.every(({ rawPostAllocationValue }) => scaled(rawPostAllocationValue.amount) >= 0n),
      ).toBe(true);
      expect(
        result.composedLines.reduce(
          (sum, { rawPostAllocationValue }) => sum + scaled(rawPostAllocationValue.amount),
          0n,
        ),
      ).toBe(scaled('50.0072'));
      expect(yield* encodeUnknownJson(result)).not.toMatch(/ZERO_FLOOR|clamp/iu);
    }),
  );

  it.effect('fails closed when a generic owner set names an unknown or Shipping recipient', () =>
    Effect.gen(function* rejectsSilentlyChangedEligibleSets() {
      const fixture = wholePurchaseComposition();
      const genericSource = source('GENERIC_SUPPORTED', 'OTHER_OWNER');

      for (const eligibleOccurrenceIds of [
        ['line-a', 'missing-line'],
        ['line-a', 'line-shipping'],
      ] as const) {
        const failure = yield* Effect.flip(
          composePricingDiscountFeeAllocations({
            discountComposition: withoutWholePurchase(fixture),
            feeResults: fixture.feeResults,
            genericContributions: [{ eligibleOccurrenceIds, originalContribution: money('-1'), source: genericSource }],
            precision,
            recipientClassifications: fixture.recipientClassifications,
          }),
        );
        expect(failure).toMatchObject({ code: 'COMPOSITION_BASIS_UNVERIFIABLE' });
      }
    }),
  );

  it.effect('retains zero-valued eligible merchandise in generic evidence and types an all-zero basis', () =>
    Effect.gen(function* retainsZeroWeightEvidence() {
      const fixture = wholePurchaseComposition();
      const result = yield* composePricingDiscountFeeAllocations({
        discountComposition: withoutWholePurchase(fixture),
        feeResults: fixture.feeResults,
        genericContributions: [
          {
            eligibleOccurrenceIds: ['line-zero'],
            originalContribution: money('-1'),
            source: source('GENERIC_SUPPORTED', 'OTHER_OWNER'),
          },
        ],
        precision,
        recipientClassifications: fixture.recipientClassifications,
      });

      expect(result).toMatchObject({
        allocationResults: [
          {
            outcome: 'ALLOCATION_FAILED',
            reason: 'GENERIC_ZERO_BASIS',
            request: {
              eligibleRecipients: [
                { baseLineValue: money('0'), occurrenceId: 'line-zero', recipientKind: 'MERCHANDISE' },
              ],
            },
          },
        ],
        outcome: 'ALLOCATION_COMPOSITION_FAILED',
      });
    }),
  );

  it.effect('requires line bases to be the exact distinct Decision line set', () =>
    Effect.gen(function* rejectsInexactLineBasisSets() {
      const fixture = integrityComposition();
      const [firstBasis] = fixture.discountComposition.request.lineBases;
      if (firstBasis === undefined) {
        throw new Error('Integrity fixture requires a first line basis');
      }
      const variants = [
        fixture.discountComposition.request.lineBases.slice(1),
        [...fixture.discountComposition.request.lineBases, firstBasis],
        [...fixture.discountComposition.request.lineBases, { ...firstBasis, occurrenceId: 'unknown-line' }],
      ];

      for (const lineBases of variants) {
        yield* expectCompositionRejection({
          discountComposition: {
            ...fixture.discountComposition,
            request: { ...fixture.discountComposition.request, lineBases },
          },
          feeResults: fixture.feeResults,
          precision,
          recipientClassifications: fixture.recipientClassifications,
        });
      }
    }),
  );

  it.effect('rejects unknown, replayed, absent, or cross-line Discount contribution bindings', () =>
    Effect.gen(function* rejectsInvalidDiscountBindings() {
      const fixture = integrityComposition();
      const variants = [
        [
          {
            ...fixture.lineContribution,
            basis: { ...fixture.lineContribution.basis, occurrenceId: 'unknown-line' },
            candidate: { ...fixture.lineContribution.candidate, occurrenceId: 'unknown-line' },
          },
        ],
        [
          {
            ...fixture.lineContribution,
            candidate: { ...fixture.lineContribution.candidate, occurrenceId: '' },
          },
        ],
        [
          {
            ...fixture.lineContribution,
            basis: { ...fixture.lineContribution.basis, occurrenceId: 'line-b' },
          },
        ],
      ];

      yield* expectCompositionRejection(
        {
          discountComposition: {
            ...fixture.discountComposition,
            lineContributions: [fixture.lineContribution, fixture.lineContribution],
          },
          feeResults: fixture.feeResults,
          precision,
          recipientClassifications: fixture.recipientClassifications,
        },
        'COMPOSITION_OWNER_IDENTITY_CONFLICT',
      );

      for (const lineContributions of variants) {
        yield* expectCompositionRejection({
          discountComposition: { ...fixture.discountComposition, lineContributions },
          feeResults: fixture.feeResults,
          precision,
          recipientClassifications: fixture.recipientClassifications,
        });
      }
    }),
  );

  it.effect('rejects cross-line Fee evidence, wrong totals, and a discountable basis not equal to base plus Fees', () =>
    Effect.gen(function* rejectsInvalidFeeArithmetic() {
      const fixture = integrityComposition();
      const [firstLineBasis, secondLineBasis] = fixture.discountComposition.request.lineBases;
      if (firstLineBasis === undefined || secondLineBasis === undefined) {
        throw new Error('Integrity fixture requires both line bases');
      }
      const crossLineFee = {
        ...fixture.lineAFee,
        contributions: [feeContribution('line-b', '2')],
      };
      yield* expectCompositionRejection({
        discountComposition: fixture.discountComposition,
        feeResults: [crossLineFee, fixture.lineBFee],
        precision,
        recipientClassifications: fixture.recipientClassifications,
      });

      const wrongTotalFee = {
        ...fixture.lineAFee,
        contributionTotal: money('1'),
        discountableLineBasis: money('11'),
      };
      const totalLineBasis = {
        ...firstLineBasis,
        amount: money('11'),
        applicablePricingFeeTotal: money('1'),
      };
      yield* expectCompositionRejection({
        discountComposition: {
          ...fixture.discountComposition,
          lineContributions: [
            { ...fixture.lineContribution, basis: { ...fixture.lineContribution.basis, amount: money('11') } },
          ],
          request: {
            ...fixture.discountComposition.request,
            lineBases: [totalLineBasis, secondLineBasis],
          },
        },
        feeResults: [wrongTotalFee, fixture.lineBFee],
        precision,
        recipientClassifications: fixture.recipientClassifications,
      });

      const wrongBasisFee = { ...fixture.lineAFee, discountableLineBasis: money('11') };
      const arithmeticLineBasis = {
        ...firstLineBasis,
        amount: money('11'),
      };
      yield* expectCompositionRejection({
        discountComposition: {
          ...fixture.discountComposition,
          lineContributions: [
            { ...fixture.lineContribution, basis: { ...fixture.lineContribution.basis, amount: money('11') } },
          ],
          request: {
            ...fixture.discountComposition.request,
            lineBases: [arithmeticLineBasis, secondLineBasis],
          },
        },
        feeResults: [wrongBasisFee, fixture.lineBFee],
        precision,
        recipientClassifications: fixture.recipientClassifications,
      });
    }),
  );

  it.effect('rejects every nested foreign currency under one CZK Decision', () =>
    Effect.gen(function* rejectsNestedForeignCurrencies() {
      const fixture = integrityComposition();
      const [firstLineBasis, secondLineBasis] = fixture.discountComposition.request.lineBases;
      const [firstFeeContribution] = fixture.lineAFee.contributions;
      if (firstLineBasis === undefined || secondLineBasis === undefined || firstFeeContribution === undefined) {
        throw new Error('Integrity fixture requires both line bases and the first Fee contribution');
      }
      const baseInput = {
        discountComposition: fixture.discountComposition,
        feeResults: fixture.feeResults,
        precision,
        recipientClassifications: fixture.recipientClassifications,
      };
      const variants: PricingDiscountFeeAllocationCompositionInput[] = [
        {
          ...baseInput,
          discountComposition: {
            ...fixture.discountComposition,
            request: {
              ...fixture.discountComposition.request,
              lineBases: [{ ...firstLineBasis, baseLineValue: foreignMoney('10') }, secondLineBasis],
            },
          },
        },
        {
          ...baseInput,
          feeResults: [
            {
              ...fixture.lineAFee,
              contributions: [{ ...firstFeeContribution, amount: foreignMoney('2') }],
            },
            fixture.lineBFee,
          ],
        },
        {
          ...baseInput,
          feeResults: [{ ...fixture.lineAFee, contributionTotal: foreignMoney('2') }, fixture.lineBFee],
        },
        {
          ...baseInput,
          discountComposition: {
            ...fixture.discountComposition,
            request: {
              ...fixture.discountComposition.request,
              lineBases: [{ ...firstLineBasis, applicablePricingFeeTotal: foreignMoney('2') }, secondLineBasis],
            },
          },
        },
        {
          ...baseInput,
          discountComposition: {
            ...fixture.discountComposition,
            lineContributions: [
              {
                ...fixture.lineContribution,
                basis: { ...fixture.lineContribution.basis, amount: foreignMoney('12') },
              },
            ],
          },
        },
        {
          ...baseInput,
          discountComposition: {
            ...fixture.discountComposition,
            lineContributions: [{ ...fixture.lineContribution, amount: foreignMoney('-3') }],
          },
        },
      ];

      for (const input of variants) {
        yield* expectCompositionRejection(input);
      }
    }),
  );

  it.effect('rejects owner-exact allocations whose merchandise recipient is classified as Shipping', () =>
    Effect.gen(function* rejectsOwnerExactShippingMismatch() {
      const fixture = integrityComposition();
      const [firstClassification] = fixture.recipientClassifications;
      if (firstClassification === undefined) {
        throw new Error('Integrity fixture requires its first recipient classification');
      }
      yield* expectCompositionRejection({
        discountComposition: fixture.discountComposition,
        feeResults: fixture.feeResults,
        ownerExactContributions: [
          {
            originalContribution: money('-1'),
            ownerAllocations: [allocation('line-b', '-1')],
            source: source('OWNER_EXACT', 'PROMOTION'),
          },
        ],
        precision,
        recipientClassifications: [firstClassification, { occurrenceId: 'line-b', recipientKind: 'SHIPPING' }],
      });
    }),
  );

  it.effect('rejects line-native Fee or Discount evidence on a non-merchandise line instead of dropping it', () =>
    Effect.gen(function* rejectsDroppedLineNativeEvidence() {
      const fixture = integrityComposition();
      const [firstClassification] = fixture.recipientClassifications;
      if (firstClassification === undefined) {
        throw new Error('Integrity fixture requires its first recipient classification');
      }
      const classifications = [firstClassification, { occurrenceId: 'line-b', recipientKind: 'SHIPPING' as const }];
      yield* expectCompositionRejection({
        discountComposition: fixture.discountComposition,
        feeResults: fixture.feeResults,
        precision,
        recipientClassifications: classifications,
      });

      const lineBDiscount = {
        ...fixture.lineContribution,
        basis: { amount: money('6'), occurrenceId: 'line-b' },
        candidate: {
          ...fixture.lineContribution.candidate,
          definition: {
            discountId: 'discount-line-b',
            revision: { revisionId: 'discount-line-b-r774' },
          },
          occurrenceId: 'line-b',
        },
      };
      yield* expectCompositionRejection({
        discountComposition: { ...fixture.discountComposition, lineContributions: [lineBDiscount] },
        feeResults: [fixture.lineAFee, feeResult(fixture.decision, 'line-b', '5')],
        precision,
        recipientClassifications: classifications,
      });
    }),
  );

  it.effect('rejects a duplicated Fee identity even when its doubled total and basis are arithmetically coherent', () =>
    Effect.gen(function* rejectsDuplicatedFeeIdentity() {
      const fixture = integrityComposition();
      const [firstContribution] = fixture.lineAFee.contributions;
      const [firstLineBasis, secondLineBasis] = fixture.discountComposition.request.lineBases;
      if (firstContribution === undefined || firstLineBasis === undefined || secondLineBasis === undefined) {
        throw new Error('Integrity fixture requires Fee evidence and both line bases');
      }
      const duplicatedFee = {
        ...fixture.lineAFee,
        contributions: [firstContribution, firstContribution],
        contributionTotal: money('4'),
        discountableLineBasis: money('14'),
      };
      const coherentLineBasis = {
        ...firstLineBasis,
        amount: money('14'),
        applicablePricingFeeTotal: money('4'),
      };
      yield* expectCompositionRejection(
        {
          discountComposition: {
            ...fixture.discountComposition,
            lineContributions: [
              { ...fixture.lineContribution, basis: { ...fixture.lineContribution.basis, amount: money('14') } },
            ],
            request: {
              ...fixture.discountComposition.request,
              lineBases: [coherentLineBasis, secondLineBasis],
            },
          },
          feeResults: [duplicatedFee, fixture.lineBFee],
          precision,
          recipientClassifications: fixture.recipientClassifications,
        },
        'COMPOSITION_OWNER_IDENTITY_CONFLICT',
      );
    }),
  );

  it.effect('rejects competing revisions of one logical Fee on the same stable line', () =>
    Effect.gen(function* rejectsCompetingFeeRevisions() {
      const fixture = integrityComposition();
      const [firstContribution] = fixture.lineAFee.contributions;
      const [firstLineBasis, secondLineBasis] = fixture.discountComposition.request.lineBases;
      if (firstContribution === undefined || firstLineBasis === undefined || secondLineBasis === undefined) {
        throw new Error('Integrity fixture requires Fee evidence and both line bases');
      }
      const competingRevision = {
        ...firstContribution,
        fee: {
          ...firstContribution.fee,
          definition: {
            ...firstContribution.fee.definition,
            revision: { revisionId: 'fee-line-a-r775' },
          },
        },
      };
      const competingFee = {
        ...fixture.lineAFee,
        contributions: [firstContribution, competingRevision],
        contributionTotal: money('4'),
        discountableLineBasis: money('14'),
      };
      yield* expectCompositionRejection(
        {
          discountComposition: {
            ...fixture.discountComposition,
            lineContributions: [
              { ...fixture.lineContribution, basis: { ...fixture.lineContribution.basis, amount: money('14') } },
            ],
            request: {
              ...fixture.discountComposition.request,
              lineBases: [
                { ...firstLineBasis, amount: money('14'), applicablePricingFeeTotal: money('4') },
                secondLineBasis,
              ],
            },
          },
          feeResults: [competingFee, fixture.lineBFee],
          precision,
          recipientClassifications: fixture.recipientClassifications,
        },
        'COMPOSITION_OWNER_IDENTITY_CONFLICT',
      );
    }),
  );

  it.effect('rejects two revisions of one logical Discount on the same occurrence and path', () =>
    Effect.gen(function* rejectsCompetingDiscountRevisions() {
      const fixture = integrityComposition();
      const competingRevision = {
        ...fixture.lineContribution,
        amount: money('-2'),
        candidate: {
          ...fixture.lineContribution.candidate,
          definition: {
            ...fixture.lineContribution.candidate.definition,
            revision: { revisionId: 'discount-line-a-r775' },
          },
        },
      };
      yield* expectCompositionRejection(
        {
          discountComposition: {
            ...fixture.discountComposition,
            lineContributions: [fixture.lineContribution, competingRevision],
          },
          feeResults: fixture.feeResults,
          precision,
          recipientClassifications: fixture.recipientClassifications,
        },
        'COMPOSITION_OWNER_IDENTITY_CONFLICT',
      );
    }),
  );

  it.effect('keeps distinct logical Discounts independently applicable on one occurrence', () =>
    Effect.gen(function* preservesDistinctDiscounts() {
      const fixture = integrityComposition();
      const distinctDiscount = {
        ...fixture.lineContribution,
        amount: money('-2'),
        candidate: {
          ...fixture.lineContribution.candidate,
          definition: {
            discountId: 'discount-line-a-second',
            revision: { revisionId: 'discount-line-a-second-r774' },
          },
        },
      };
      const result = yield* composePricingDiscountFeeAllocations({
        discountComposition: {
          ...fixture.discountComposition,
          lineContributions: [fixture.lineContribution, distinctDiscount],
        },
        feeResults: fixture.feeResults,
        precision,
        recipientClassifications: fixture.recipientClassifications,
      });

      expect(result.outcome).toBe('ALLOCATION_COMPOSITION_READY');
      expect(
        result.allocationResults.filter(
          (entry) => entry.outcome === 'ALLOCATION_APPLIED' && entry.request.source.sourceKind === 'PRICING_DISCOUNT',
        ),
      ).toHaveLength(2);
      if (result.outcome !== 'ALLOCATION_COMPOSITION_READY') {
        throw new Error('Distinct logical Discounts must remain independently applicable');
      }
      expect(result.composedLines[0]?.preAllocationIntermediateValue).toEqual(money('7'));
    }),
  );
});
