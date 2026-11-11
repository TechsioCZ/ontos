import {
  addPricingExactDecimals,
  comparePricingExactDecimals,
  subtractPricingExactDecimals,
} from '@app/pricing-contracts/domain/exact-decimal';
import { roundPricingExactDecimalHalfUp } from '@app/pricing-contracts/domain/rounding-boundary';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PromotionMonetaryEffect } from '../../shared/resources/promotion.ts';
import {
  PromotionBasisResolutionRequestSchema,
  PromotionMonetaryInvalid,
  PromotionMonetaryUnavailable,
  PromotionMonetaryUnverifiable,
  PromotionMonetaryPrecisionUnsupported,
  allocatePromotionCartBenefit,
  applyPromotionMonetaryEffect,
  resolvePromotionMonetaryBasis,
} from '../../src/services/monetary.service.ts';
import type {
  PromotionAllocationRecipient,
  PromotionBasisAgreement,
  PromotionBasisAuthority,
  PromotionBasisResolutionRequest,
  PromotionBasisRule,
} from '../../src/services/monetary.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellingLegalEntityId = '22222222-2222-4222-8222-222222222222';
const at = DateTime.makeUnsafe('2026-11-06T10:00:00Z');
const period = { from: DateTime.makeUnsafe('2026-11-01T00:00:00Z'), to: DateTime.makeUnsafe('2026-12-01T00:00:00Z') };
const fixed = (amount: string): PromotionMonetaryEffect => ({
  amount,
  currencyCode: 'CZK',
  kind: 'FIXED_MONETARY_AMOUNT',
});
const percentage = (value: string): PromotionMonetaryEffect => ({ kind: 'PERCENTAGE', percentage: value });
const recipient = (occurrenceId: string, remainingCapacity: string, eligible = true): PromotionAllocationRecipient => ({
  eligible,
  occurrenceId,
  remainingCapacity,
});
const tenantRule: PromotionBasisRule = {
  buyerVatStatus: 'REGISTERED',
  effectivePeriod: period,
  mode: 'NET_TAX_EXCLUSIVE',
  revision: 'rule-v1',
  ruleId: 'rule-net',
  sellerVatStatus: 'REGISTERED',
};
const agreement: PromotionBasisAgreement = {
  agreementId: 'agreement-gross',
  effectivePeriod: period,
  mode: 'GROSS_TAX_INCLUSIVE',
  revision: 'agreement-v1',
  subjectRef: 'counterparty-1',
};
type CurrentBasisFacts = Extract<PromotionBasisAuthority, { kind: 'CURRENT' }>;
const currentFacts = (overrides: Partial<CurrentBasisFacts> = {}): CurrentBasisFacts => ({
  agreements: [],
  agreementsComplete: true,
  businessKind: 'B2B',
  buyerVatStatus: 'REGISTERED',
  evidenceRef: 'basis-facts-1',
  kind: 'CURRENT',
  observedAt: DateTime.makeUnsafe('2026-11-06T09:59:00Z'),
  purchaseRef: 'purchase-1',
  sellerVatStatus: 'REGISTERED',
  sellingLegalEntityId,
  subjectRef: 'counterparty-1',
  tenantId,
  tenantRules: [tenantRule],
  tenantRulesComplete: true,
  validUntil: DateTime.makeUnsafe('2026-11-06T10:01:00Z'),
  ...overrides,
});
const request = (authority: PromotionBasisAuthority = currentFacts()): PromotionBasisResolutionRequest => ({
  at,
  authority,
  purchaseRef: 'purchase-1',
  sellingLegalEntityId,
  subjectRef: 'counterparty-1',
  tenantId,
});

describe('purchase-wide monetary basis authority', () => {
  it.effect('preserves the encoded ISO and decoded native UTC request contracts', () =>
    Effect.gen(function* test() {
      const decoded = request();
      const encoded = yield* Schema.encodeEffect(PromotionBasisResolutionRequestSchema)(decoded);
      expect(encoded.at).toBe('2026-11-06T10:00:00.000Z');
      const result = yield* resolvePromotionMonetaryBasis(encoded);
      expect(result.mode).toBe('NET_TAX_EXCLUSIVE');
    }),
  );

  it.effect('uses authoritative B2C classification to resolve GROSS without consulting B2B rules', () =>
    Effect.gen(function* test() {
      const result = yield* resolvePromotionMonetaryBasis(
        request(
          currentFacts({
            agreementsComplete: false,
            businessKind: 'B2C',
            tenantRules: [],
            tenantRulesComplete: false,
          }),
        ),
      );
      expect(result.mode).toBe('GROSS_TAX_INCLUSIVE');
      expect(result.source).toEqual({ kind: 'B2C_LAUNCH', reference: 'basis-facts-1' });
      expect(result.purchaseRef).toBe('purchase-1');
    }),
  );

  it.effect('prefers the valid specific agreement over the matching tenant rule', () =>
    Effect.gen(function* test() {
      const result = yield* resolvePromotionMonetaryBasis(request(currentFacts({ agreements: [agreement] })));
      expect(result.mode).toBe('GROSS_TAX_INCLUSIVE');
      expect(result.source).toEqual({
        kind: 'SPECIFIC_AGREEMENT',
        reference: 'agreement-gross',
        revision: 'agreement-v1',
      });
      expect(result.evidenceRef).toBe('basis-facts-1');
    }),
  );

  it.effect('automatically selects the tenant rule matching authoritative party VAT facts', () =>
    Effect.gen(function* test() {
      const grossRule: PromotionBasisRule = {
        ...tenantRule,
        buyerVatStatus: 'NOT_REGISTERED',
        mode: 'GROSS_TAX_INCLUSIVE',
        ruleId: 'rule-gross',
      };
      const net = yield* resolvePromotionMonetaryBasis(request(currentFacts({ tenantRules: [tenantRule, grossRule] })));
      const gross = yield* resolvePromotionMonetaryBasis(
        request(
          currentFacts({
            buyerVatStatus: 'NOT_REGISTERED',
            tenantRules: [tenantRule, grossRule],
          }),
        ),
      );
      expect(net.mode).toBe('NET_TAX_EXCLUSIVE');
      expect(net.source.reference).toBe('rule-net');
      expect(gross.mode).toBe('GROSS_TAX_INCLUSIVE');
      expect(gross.source.reference).toBe('rule-gross');
    }),
  );

  it.effect('evaluates half-open agreement periods and ignores agreements for another subject', () =>
    Effect.gen(function* test() {
      const ended = { ...agreement, effectivePeriod: { ...period, to: at } };
      const otherSubject = { ...agreement, subjectRef: 'counterparty-2' };
      const result = yield* resolvePromotionMonetaryBasis(request(currentFacts({ agreements: [ended, otherSubject] })));
      expect(result.mode).toBe('NET_TAX_EXCLUSIVE');
      const startsNow = { ...agreement, effectivePeriod: { from: at } };
      const current = yield* resolvePromotionMonetaryBasis(request(currentFacts({ agreements: [startsNow] })));
      expect(current.mode).toBe('GROSS_TAX_INCLUSIVE');
    }),
  );

  it.effect('never treats missing, ambiguous, stale or incomplete authority as a default basis', () =>
    Effect.gen(function* test() {
      const failures: readonly PromotionBasisAuthority[] = [
        { kind: 'UNVERIFIABLE' },
        currentFacts({ agreementsComplete: false }),
        currentFacts({ agreements: [agreement, { ...agreement, agreementId: 'other' }] }),
        currentFacts({ tenantRules: [] }),
        currentFacts({ tenantRules: [tenantRule, { ...tenantRule, ruleId: 'other' }] }),
        currentFacts({ tenantRulesComplete: false }),
        currentFacts({ buyerVatStatus: 'UNKNOWN' }),
        currentFacts({ sellerVatStatus: 'UNKNOWN' }),
        currentFacts({ validUntil: at }),
        currentFacts({ observedAt: DateTime.makeUnsafe('2026-11-06T10:00:01Z') }),
      ];
      for (const facts of failures) {
        const error = yield* Effect.flip(resolvePromotionMonetaryBasis(request(facts)));
        expect(Schema.is(PromotionMonetaryUnverifiable)(error)).toBe(true);
      }
      const unavailable = yield* Effect.flip(resolvePromotionMonetaryBasis(request({ kind: 'UNAVAILABLE' })));
      expect(Schema.is(PromotionMonetaryUnavailable)(unavailable)).toBe(true);
    }),
  );

  it.effect('rejects evidence rebound to another purchase, seller, subject or Tenant', () =>
    Effect.gen(function* test() {
      const variants = [
        currentFacts({ purchaseRef: 'other' }),
        currentFacts({ subjectRef: 'other' }),
        currentFacts({ sellingLegalEntityId: '33333333-3333-4333-8333-333333333333' }),
        currentFacts({ tenantId: '33333333-3333-4333-8333-333333333333' }),
      ];
      for (const facts of variants) {
        const error = yield* Effect.flip(resolvePromotionMonetaryBasis(request(facts)));
        expect(Schema.is(PromotionMonetaryInvalid)(error)).toBe(true);
      }
      const injectedBuyerChoice = { ...request(), mode: 'NET_TAX_EXCLUSIVE' };
      const error = yield* Effect.flip(resolvePromotionMonetaryBasis(injectedBuyerChoice));
      expect(Schema.is(PromotionMonetaryInvalid)(error)).toBe(true);
    }),
  );
});

describe('exact monetary effect before Pricing publication', () => {
  it.effect('retains sub-cent percentage benefits rather than independently rounding savings', () =>
    Effect.gen(function* test() {
      const result = yield* applyPromotionMonetaryEffect({
        capacity: '1.05',
        currencyCode: 'CZK',
        effect: percentage('10'),
      });
      expect(result).toEqual({ benefit: '0.105', currencyCode: 'CZK', outcome: 'APPLIED', remainingCapacity: '0.945' });
      const halfCent = yield* applyPromotionMonetaryEffect({
        capacity: '1',
        currencyCode: 'CZK',
        effect: percentage('0.5'),
      });
      expect(halfCent).toEqual({
        benefit: '0.005',
        currencyCode: 'CZK',
        outcome: 'APPLIED',
        remainingCapacity: '0.995',
      });
    }),
  );

  it.effect('caps fixed benefits at exact positive capacity with no credit or floor repair', () =>
    Effect.gen(function* test() {
      const capped = yield* applyPromotionMonetaryEffect({
        capacity: '300',
        currencyCode: 'CZK',
        effect: fixed('500'),
      });
      expect(capped).toEqual({ benefit: '300', currencyCode: 'CZK', outcome: 'APPLIED', remainingCapacity: '0' });
      const gross = yield* applyPromotionMonetaryEffect({
        capacity: '1210',
        currencyCode: 'CZK',
        effect: fixed('100'),
      });
      expect(gross).toEqual({ benefit: '100', currencyCode: 'CZK', outcome: 'APPLIED', remainingCapacity: '1110' });
    }),
  );

  it.effect('produces no monetary application at zero capacity or zero configured benefit', () =>
    Effect.gen(function* test() {
      const zeroCapacity = yield* applyPromotionMonetaryEffect({
        capacity: '0',
        currencyCode: 'CZK',
        effect: fixed('500'),
      });
      expect(zeroCapacity).toEqual({ outcome: 'NOT_APPLICABLE', reason: 'NO_POSITIVE_ELIGIBLE_BASIS' });
      for (const effect of [fixed('0'), percentage('0')]) {
        const zeroBenefit = yield* applyPromotionMonetaryEffect({ capacity: '1', currencyCode: 'CZK', effect });
        expect(zeroBenefit).toEqual({ outcome: 'NOT_APPLICABLE', reason: 'ZERO_BENEFIT' });
      }
    }),
  );

  it.effect('rejects malformed values, excessive effects and unsupported exact precision', () =>
    Effect.gen(function* test() {
      for (const capacity of ['-1', '1.00', '0.0000000000000000001', '9'.repeat(59)]) {
        const error = yield* Effect.flip(
          applyPromotionMonetaryEffect({ capacity, currencyCode: 'CZK', effect: fixed('1') }),
        );
        expect(Schema.is(PromotionMonetaryInvalid)(error)).toBe(true);
      }
      const excessive = yield* Effect.flip(
        applyPromotionMonetaryEffect({ capacity: '10', currencyCode: 'CZK', effect: percentage('100.1') }),
      );
      expect(Schema.is(PromotionMonetaryInvalid)(excessive)).toBe(true);
      const unrepresentable = yield* Effect.flip(
        applyPromotionMonetaryEffect({
          capacity: '0.000000000000000001',
          currencyCode: 'CZK',
          effect: percentage('1'),
        }),
      );
      expect(Schema.is(PromotionMonetaryPrecisionUnsupported)(unrepresentable)).toBe(true);
    }),
  );

  it.effect('permits all four effect pairings in fixed product-before-cart order', () =>
    Effect.gen(function* test() {
      const cases = [
        { cart: fixed('100'), product: fixed('100'), remaining: '800' },
        { cart: percentage('10'), product: fixed('100'), remaining: '810' },
        { cart: fixed('100'), product: percentage('10'), remaining: '800' },
        { cart: percentage('10'), product: percentage('10'), remaining: '810' },
      ];
      for (const example of cases) {
        const product = yield* applyPromotionMonetaryEffect({
          capacity: '1000',
          currencyCode: 'CZK',
          effect: example.product,
        });
        expect(product.outcome).toBe('APPLIED');
        if (product.outcome !== 'APPLIED') {
          return;
        }
        const cart = yield* applyPromotionMonetaryEffect({
          capacity: product.remainingCapacity,
          currencyCode: 'CZK',
          effect: example.cart,
        });
        expect(cart.outcome).toBe('APPLIED');
        if (cart.outcome !== 'APPLIED') {
          return;
        }
        expect(cart.remainingCapacity).toBe(example.remaining);
      }
    }),
  );

  it.effect('preserves exact benefit while Pricing alone rounds final NET lines once', () =>
    Effect.gen(function* test() {
      const monetary = yield* applyPromotionMonetaryEffect({
        capacity: '1.05',
        currencyCode: 'CZK',
        effect: percentage('10'),
      });
      expect(monetary.outcome).toBe('APPLIED');
      if (monetary.outcome !== 'APPLIED') {
        return;
      }
      const published = roundPricingExactDecimalHalfUp(monetary.remainingCapacity, 2);
      expect(published).toBe('0.95');
      if (published === undefined) {
        return;
      }
      expect(yield* subtractPricingExactDecimals(published, monetary.remainingCapacity)).toBe('0.005');
      expect(monetary.benefit).toBe('0.105');
      const one = roundPricingExactDecimalHalfUp('1.005', 2);
      const two = roundPricingExactDecimalHalfUp('1.005', 2);
      expect(one).toBe('1.01');
      expect(two).toBe('1.01');
      if (one === undefined || two === undefined) {
        return;
      }
      expect(yield* addPricingExactDecimals(one, two)).toBe('2.02');
      expect(roundPricingExactDecimalHalfUp('1499.995', 2)).toBe('1500');
    }),
  );
});

describe('one cart benefit allocated after product reductions', () => {
  it.effect('allocates exact sub-cent capacities without cent-sized remainders', () =>
    Effect.gen(function* test() {
      const result = yield* allocatePromotionCartBenefit({
        currencyCode: 'CZK',
        effect: fixed('0.01'),
        recipients: [recipient('A', '0.005'), recipient('B', '0.005')],
      });
      expect(result.outcome).toBe('APPLIED');
      if (result.outcome !== 'APPLIED') {
        return;
      }
      expect(result.benefit).toBe('0.01');
      expect(result.allocations.map((allocation) => allocation.amount)).toEqual(['0.005', '0.005']);
      expect(result.allocationProfile.maximumScale).toBe(18);
    }),
  );

  it.effect('uses remaining product-adjusted weights and exact scale-18 largest remainders', () =>
    Effect.gen(function* test() {
      const recipients = [recipient('A', '800'), recipient('B', '3000')];
      const fixedResult = yield* allocatePromotionCartBenefit({
        currencyCode: 'CZK',
        effect: fixed('400'),
        recipients,
      });
      expect(fixedResult.outcome).toBe('APPLIED');
      if (fixedResult.outcome !== 'APPLIED') {
        return;
      }
      expect(fixedResult.allocations.map((allocation) => allocation.amount)).toEqual([
        '84.210526315789473684',
        '315.789473684210526316',
      ]);
      const percentResult = yield* allocatePromotionCartBenefit({
        currencyCode: 'CZK',
        effect: percentage('10'),
        recipients,
      });
      expect(percentResult.outcome).toBe('APPLIED');
      if (percentResult.outcome !== 'APPLIED') {
        return;
      }
      expect(percentResult.benefit).toBe('380');
      expect(percentResult.allocations.map((allocation) => allocation.amount)).toEqual(['80', '300']);
    }),
  );

  it.effect('ties by canonical occurrence ID independent of input order', () =>
    Effect.gen(function* test() {
      const a = recipient('A', '100');
      const b = recipient('B', '100');
      const c = recipient('C', '100');
      const permutations = [
        [a, b, c],
        [c, a, b],
        [b, c, a],
        [c, b, a],
      ];
      for (const recipients of permutations) {
        const result = yield* allocatePromotionCartBenefit({
          currencyCode: 'CZK',
          effect: fixed('100.01'),
          recipients,
        });
        expect(result.outcome).toBe('APPLIED');
        if (result.outcome !== 'APPLIED') {
          return;
        }
        expect(result.allocations).toEqual([
          { amount: '33.336666666666666667', eligibleBasis: '100', occurrenceId: 'A' },
          { amount: '33.336666666666666667', eligibleBasis: '100', occurrenceId: 'B' },
          { amount: '33.336666666666666666', eligibleBasis: '100', occurrenceId: 'C' },
        ]);
      }
    }),
  );

  it.effect('excludes ineligible and zero capacities and conserves sum and capacity at the cap', () =>
    Effect.gen(function* test() {
      const recipients = [
        recipient('A', '1000'),
        recipient('B', '3000'),
        recipient('C', '9000', false),
        recipient('D', '0'),
      ];
      for (const effect of [fixed('400'), fixed('9000'), percentage('100')]) {
        const result = yield* allocatePromotionCartBenefit({ currencyCode: 'CZK', effect, recipients });
        expect(result.outcome).toBe('APPLIED');
        if (result.outcome !== 'APPLIED') {
          return;
        }
        expect(result.allocations.map((allocation) => allocation.occurrenceId)).toEqual(['A', 'B']);
        let sum = '0';
        for (const allocation of result.allocations) {
          expect(comparePricingExactDecimals(allocation.amount, allocation.eligibleBasis)).toBeLessThanOrEqual(0);
          sum = yield* addPricingExactDecimals(sum, allocation.amount);
        }
        expect(sum).toBe(result.benefit);
      }
    }),
  );

  it.effect('rejects duplicate occurrence IDs and overflowing eligible totals', () =>
    Effect.gen(function* test() {
      const duplicate = yield* Effect.flip(
        allocatePromotionCartBenefit({
          currencyCode: 'CZK',
          effect: fixed('1'),
          recipients: [recipient('A', '1'), recipient('A', '2', false)],
        }),
      );
      expect(Schema.is(PromotionMonetaryInvalid)(duplicate)).toBe(true);
      const overflow = yield* Effect.flip(
        allocatePromotionCartBenefit({
          currencyCode: 'CZK',
          effect: fixed('1'),
          recipients: [recipient('A', '9'.repeat(58)), recipient('B', '9'.repeat(58))],
        }),
      );
      expect(Schema.is(PromotionMonetaryPrecisionUnsupported)(overflow)).toBe(true);
      const zero = yield* allocatePromotionCartBenefit({
        currencyCode: 'CZK',
        effect: fixed('1'),
        recipients: [recipient('A', '0'), recipient('B', '1', false)],
      });
      expect(zero).toEqual({ outcome: 'NOT_APPLICABLE', reason: 'NO_POSITIVE_ELIGIBLE_BASIS' });
    }),
  );
});
