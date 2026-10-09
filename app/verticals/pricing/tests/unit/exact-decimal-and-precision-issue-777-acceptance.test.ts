import type {
  PricingAllocationPrecision,
  PricingWholePurchaseContractualAllocationRequest,
} from '@app/pricing-contracts/domain/discount-fee-allocation';
import {
  addPricingExactDecimals,
  comparePricingExactDecimals,
  ensurePricingDecimalSign,
  ensurePricingMoneyCurrencyCompatibility,
  formatPricingExactDecimal,
  multiplyPricingExactDecimals,
  parsePricingExactDecimal,
  PRICING_ALLOCATION_PROFILE_VERSION,
  PRICING_ARITHMETIC_PROFILE_VERSION,
  PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  PricingCurrencyMismatchFailure,
  PricingDecimalFormatFailure,
  PricingDecimalOverflowFailure,
  PricingDecimalRangeFailure,
  PricingDecimalScaleFailure,
  PricingDecimalSignFailure,
  PricingExactMoneySchema,
  PricingUnsupportedProfileFailure,
  resolvePricingAllocationProfile,
  resolvePricingArithmeticProfile,
  resolvePricingPublicationProfile,
  subtractPricingExactDecimals,
} from '@app/pricing-contracts/domain/exact-decimal';
import { PricingDiscountEffectSchema } from '@app/pricing-contracts/domain/discount';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { allocatePricingDiscountsAndFees } from '../../src/services/discount-fee-allocation.service.ts';
import {
  executePricingExactMoneyOperation,
  validatePricingArithmeticContext,
} from '../../src/services/exact-decimal-profile.service.ts';

const PricingExactMoneyJsonSchema = Schema.fromJsonString(PricingExactMoneySchema);

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-09-28T08:00:00.000Z';
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const selection = { productRef, variantRef };
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
        { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
        { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 2 } },
        {
          provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
          role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
          source: { resourceRef: productRef, revision: 1 },
        },
      ],
      membership: {
        attestationId: '66666666-6666-4666-8666-666666666666',
        observedAt: operationTime,
        productRef,
        source: 'CATALOG_OWNER_CURRENT_READ' as const,
        variant: { resourceRef: variantRef, revision: 2 },
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
  currencyCode: 'CZK',
  lines: [line('line-a'), line('line-b')],
  monetaryBoundary: 'PRE_TAX',
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:777',
      decisionRevision: 'purchase-access-decision-r777',
    },
    actor: { kind: 'PRINCIPAL', principalId: 'pricing-principal:777' },
    commercialSettingsDecision: {
      decisionRef: 'purchase-commercial-settings:777',
      decisionRevision: 'purchase-commercial-settings-r777',
    },
    contextRef: 'purchase-1',
    contextRevision: 'purchase-r1',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:777',
      resolutionRevision: 'purchase-currency-resolution-r777',
    },
    subject: {
      authorizationSubject: { kind: 'RETAIL' },
      kind: 'PROFILE',
      profileRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'pricing-profile:777',
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId,
      },
    },
  },
  tenantId,
});

const precision = {
  allocationScale: 18,
  amountPrecision: 76,
  contractVersion: PRICING_ALLOCATION_PROFILE_VERSION,
  remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC',
} satisfies PricingAllocationPrecision;
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const wholePurchaseRequest: PricingWholePurchaseContractualAllocationRequest = {
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
  source: {
    allocationAuthority: 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
    logicalFactRef: 'discount-1',
    ownerModuleId: 'commerce.pricing',
    revisionRef: 'discount-r1',
    sourceKind: 'PRICING_DISCOUNT',
  },
};

describe('Pricing exact decimal and precision owner acceptance (#777)', () => {
  it.effect('adds, subtracts, multiplies, compares, and wire-round-trips canonical decimals exactly', () =>
    Effect.gen(function* exactArithmetic() {
      const sum = yield* addPricingExactDecimals('0.1', '0.2');
      const difference = yield* subtractPricingExactDecimals('100.0072', '100');
      const product = yield* multiplyPricingExactDecimals('33.335', '3');
      const lineValue = yield* executePricingExactMoneyOperation({
        currencyCode: 'CZK',
        operation: 'MULTIPLY_AMOUNT_BY_QUANTITY',
        quantity: '3',
        sourceAmount: money('33.335'),
      });

      expect(sum).toBe('0.3');
      expect(difference).toBe('0.0072');
      expect(product).toBe('100.005');
      expect(lineValue).toEqual(money('100.005'));
      expect(comparePricingExactDecimals('9.7097', '9.71')).toBe(-1);
      expect(formatPricingExactDecimal(sum)).toBe('0.3');

      const moneyValue = yield* Schema.decodeEffect(PricingExactMoneySchema)({ amount: product, currencyCode: 'CZK' });
      const wire = yield* Schema.encodeEffect(PricingExactMoneyJsonSchema)(moneyValue);
      expect(yield* Schema.decodeEffect(PricingExactMoneyJsonSchema)(wire)).toEqual(moneyValue);
      expect(wire).toContain('100.005');
    }),
  );

  it.effect('keeps configured percentage/fixed levels distinct from signed contributions and preserves zero', () =>
    Effect.gen(function* validatesSigns() {
      const decodeEffect = Schema.decodeEffect(PricingDiscountEffectSchema);

      expect(yield* decodeEffect({ kind: 'PERCENTAGE', level: '0' })).toEqual({ kind: 'PERCENTAGE', level: '0' });
      expect(yield* decodeEffect({ kind: 'PERCENTAGE', level: '100' })).toEqual({ kind: 'PERCENTAGE', level: '100' });
      expect(yield* decodeEffect({ kind: 'FIXED_MONETARY_AMOUNT', level: money('0') })).toEqual({
        kind: 'FIXED_MONETARY_AMOUNT',
        level: money('0'),
      });
      expect(Schema.is(PricingDiscountEffectSchema)({ kind: 'PERCENTAGE', level: '100.0001' })).toBe(false);
      expect(Schema.is(PricingDiscountEffectSchema)({ kind: 'PERCENTAGE', level: '-1' })).toBe(false);
      expect(Schema.is(PricingDiscountEffectSchema)({ kind: 'FIXED_MONETARY_AMOUNT', level: money('-0.01') })).toBe(
        false,
      );

      expect(yield* ensurePricingDecimalSign('0', 'NON_NEGATIVE')).toBe('0');
      expect(yield* ensurePricingDecimalSign('0', 'NON_POSITIVE')).toBe('0');
      expect(yield* ensurePricingDecimalSign('-0.01', 'NON_POSITIVE')).toBe('-0.01');
      expect(
        Schema.is(PricingDecimalSignFailure)(yield* ensurePricingDecimalSign('0.01', 'NON_POSITIVE').pipe(Effect.flip)),
      ).toBe(true);
    }),
  );

  it.effect('types non-canonical, scale, range, overflow, currency, and unsupported-profile failures', () =>
    Effect.gen(function* typesFailures() {
      const nonCanonical = yield* parsePricingExactDecimal('0.10').pipe(Effect.flip);
      const excessiveScale = yield* parsePricingExactDecimal('0.1234567890123456789').pipe(Effect.flip);
      const excessiveRange = yield* parsePricingExactDecimal(`1${'0'.repeat(58)}`).pipe(Effect.flip);
      const overflow = yield* multiplyPricingExactDecimals(`1${'0'.repeat(57)}`, '10').pipe(Effect.flip);
      const unsupported = yield* resolvePricingArithmeticProfile('pricing-arithmetic-v999').pipe(Effect.flip);
      const currencyMismatch = yield* ensurePricingMoneyCurrencyCompatibility(
        { amount: '1', currencyCode: 'CZK' },
        { amount: '1', currencyCode: 'EUR' },
      ).pipe(Effect.flip);

      expect(Schema.is(PricingDecimalFormatFailure)(nonCanonical)).toBe(true);
      expect(Schema.is(PricingDecimalScaleFailure)(excessiveScale)).toBe(true);
      expect(Schema.is(PricingDecimalRangeFailure)(excessiveRange)).toBe(true);
      expect(Schema.is(PricingDecimalOverflowFailure)(overflow)).toBe(true);
      expect(Schema.is(PricingUnsupportedProfileFailure)(unsupported)).toBe(true);
      expect(Schema.is(PricingCurrencyMismatchFailure)(currencyMismatch)).toBe(true);
    }),
  );

  it.effect('keeps EUR-bearing contracts representable while activating only the CZK Launch publication profile', () =>
    Effect.gen(function* preservesGeneralizedCurrency() {
      expect(yield* Schema.decodeEffect(PricingExactMoneySchema)({ amount: '12.34', currencyCode: 'EUR' })).toEqual({
        amount: '12.34',
        currencyCode: 'EUR',
      });
      expect((yield* resolvePricingArithmeticProfile(PRICING_ARITHMETIC_PROFILE_VERSION)).profileKind).toBe(
        'ARITHMETIC',
      );
      expect((yield* resolvePricingAllocationProfile(PRICING_ALLOCATION_PROFILE_VERSION)).maximumScale).toBe(18);
      expect(yield* resolvePricingPublicationProfile(PRICING_CZK_PUBLICATION_PROFILE_VERSION)).toEqual({
        currencyCode: 'CZK',
        profileKind: 'PUBLICATION',
        profileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
        publishedScale: 2,
        quantum: '0.01',
        roundingMode: 'HALF_UP',
      });
      expect(
        Schema.is(PricingUnsupportedProfileFailure)(
          yield* resolvePricingPublicationProfile('pricing-eur-publication-v1').pipe(Effect.flip),
        ),
      ).toBe(true);
    }),
  );

  it.effect('validates the complete CZK context and fails closed for unactivated EUR publication', () =>
    Effect.gen(function* validatesContext() {
      const ready = yield* validatePricingArithmeticContext({
        currencyCode: 'CZK',
        intermediateAmounts: [money('100.005')],
        profileVersions: {
          allocation: PRICING_ALLOCATION_PROFILE_VERSION,
          arithmetic: PRICING_ARITHMETIC_PROFILE_VERSION,
          publication: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
        },
        quantities: ['3'],
        sourceAmounts: [money('33.335')],
      });

      expect(ready.outcome).toBe('ARITHMETIC_CONTEXT_READY');
      expect(ready.sourceAmounts).toEqual([money('33.335')]);
      expect(ready.intermediateAmounts).toEqual([money('100.005')]);
      expect(ready.quantities).toEqual(['3']);

      const unsupportedEur = yield* validatePricingArithmeticContext({
        currencyCode: 'EUR',
        intermediateAmounts: [{ amount: '100.005', currencyCode: 'EUR' }],
        profileVersions: {
          allocation: PRICING_ALLOCATION_PROFILE_VERSION,
          arithmetic: PRICING_ARITHMETIC_PROFILE_VERSION,
          publication: 'pricing-eur-publication-v1',
        },
        quantities: ['3'],
        sourceAmounts: [{ amount: '33.335', currencyCode: 'EUR' }],
      }).pipe(Effect.flip);
      expect(Schema.is(PricingUnsupportedProfileFailure)(unsupportedEur)).toBe(true);

      const noRelabel = yield* validatePricingArithmeticContext({
        currencyCode: 'EUR',
        intermediateAmounts: [{ amount: '100.005', currencyCode: 'EUR' }],
        profileVersions: {
          allocation: PRICING_ALLOCATION_PROFILE_VERSION,
          arithmetic: PRICING_ARITHMETIC_PROFILE_VERSION,
          publication: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
        },
        quantities: ['3'],
        sourceAmounts: [{ amount: '33.335', currencyCode: 'EUR' }],
      }).pipe(Effect.flip);
      expect(Schema.is(PricingCurrencyMismatchFailure)(noRelabel)).toBe(true);
    }),
  );

  it.effect('preserves the complete sub-cent contribution and every recipient capacity deterministically', () =>
    Effect.gen(function* allocationCapacity() {
      const first = yield* allocatePricingDiscountsAndFees(wholePurchaseRequest);
      const second = yield* allocatePricingDiscountsAndFees({
        ...wholePurchaseRequest,
        eligibleBasis: {
          ...wholePurchaseRequest.eligibleBasis,
          recipients: wholePurchaseRequest.eligibleBasis.recipients.toReversed(),
        },
      });

      expect(first.outcome).toBe('ALLOCATION_APPLIED');
      expect(second.outcome).toBe('ALLOCATION_APPLIED');
      if (first.outcome === 'ALLOCATION_APPLIED' && second.outcome === 'ALLOCATION_APPLIED') {
        expect(first.allocations).toEqual([
          { amount: money('-9.709000951931460935'), occurrenceId: 'line-a', recipientKind: 'MERCHANDISE' },
          { amount: money('-90.290999048068539065'), occurrenceId: 'line-b', recipientKind: 'MERCHANDISE' },
        ]);
        expect(second.allocations).toEqual(first.allocations);
        expect(first.sumInvariant).toBe('ALLOCATIONS_SUM_TO_ORIGINAL_CONTRIBUTION');
        expect(first.capacityInvariant).toBe('EVERY_ALLOCATION_WITHIN_ELIGIBLE_INTERMEDIATE');
        expect(first.allocations).not.toContainEqual({
          amount: money('-9.71'),
          occurrenceId: 'line-a',
          recipientKind: 'MERCHANDISE',
        });
      }
    }),
  );
});
