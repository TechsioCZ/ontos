import { expect, it } from 'effect-rstest';
import { Option, Predicate, Schema } from 'effect';

import { PrepareOrderCommitmentPayloadSchema } from '../../shared/actions/prepare-order-commitment.ts';
import { orderPreparationInput } from '../support/order-preparation-input.ts';
import {
  OrderPurchaseValueUnresolvable,
  frozenPurchaseValueAccessAmount,
  purchaseValueAccessAmount,
} from '../../src/services/purchase-value-amount.ts';

const governedAmount = (input = orderPreparationInput()) => purchaseValueAccessAmount(input.taxCandidate);

const publishedLines = (input: ReturnType<typeof orderPreparationInput>) => input.taxCandidate.pricing.publishedLines;

const lineValue = (input: ReturnType<typeof orderPreparationInput>, index: number) => {
  const line = publishedLines(input)[index];
  if (line === undefined) {
    throw new Error(`The fixture has no published Pricing line ${index}`);
  }
  return line.lineCommercialValue;
};

it('derives the governed purchase value from the published net Pricing line values', () => {
  expect(governedAmount()).toEqual({ currency: 'CZK', minor: 100_000 });
});

it('sums every published net line exactly, including sub-unit fractional line values', () => {
  const input = orderPreparationInput({}, (candidate) => ({
    ...candidate,
    pricing: {
      ...candidate.pricing,
      publishedLines: [
        {
          ...publishedLines(orderPreparationInput())[0],
          lineCommercialValue: {
            amount: { denominator: '1', numerator: '1000' },
            amountBasis: 'NET',
            currency: 'CZK',
          },
        },
        {
          ...publishedLines(orderPreparationInput())[0],
          lineCommercialValue: {
            amount: { denominator: '2', numerator: '1' },
            amountBasis: 'NET',
            currency: 'CZK',
          },
          occurrenceId: 'o2',
          pricingLineRef: 'pricing-line-o2',
        },
      ],
    },
  }));
  expect(governedAmount(input)).toEqual({ currency: 'CZK', minor: 100_050 });
});

it('refuses a purchase whose published lines do not state one net value in one currency', () => {
  const mixedCurrency = orderPreparationInput({}, (candidate) => ({
    ...candidate,
    pricing: {
      ...candidate.pricing,
      publishedLines: [
        ...candidate.pricing.publishedLines,
        {
          ...publishedLines(orderPreparationInput())[0],
          lineCommercialValue: {
            amount: { denominator: '1', numerator: '10' },
            amountBasis: 'NET',
            currency: 'EUR',
          },
          occurrenceId: 'o2',
          pricingLineRef: 'pricing-line-o2',
        },
      ],
    },
  }));
  expect(() => governedAmount(mixedCurrency)).toThrow(OrderPurchaseValueUnresolvable);

  const grossLine = orderPreparationInput({}, (candidate) => ({
    ...candidate,
    pricing: {
      ...candidate.pricing,
      publishedLines: [
        {
          ...publishedLines(orderPreparationInput())[0],
          lineCommercialValue: { ...lineValue(orderPreparationInput(), 0), amountBasis: 'GROSS' },
        },
      ],
    },
  }));
  expect(() => governedAmount(grossLine)).toThrow(OrderPurchaseValueUnresolvable);
});

it('rounds a value that is not representable in minor units up, so a ceiling is never understated', () => {
  const third = orderPreparationInput({}, (candidate) => ({
    ...candidate,
    pricing: {
      ...candidate.pricing,
      publishedLines: [
        {
          ...publishedLines(orderPreparationInput())[0],
          lineCommercialValue: {
            amount: { denominator: '3', numerator: '1' },
            amountBasis: 'NET',
            currency: 'CZK',
          },
        },
      ],
    },
  }));
  // 1/3 CZK is 33.33 haléře: rounding any other way would govern less than the purchase.
  expect(governedAmount(third)).toEqual({ currency: 'CZK', minor: 34 });
});

it('leaves a candidate without any published Pricing line to the owner candidate verification', () => {
  // Zero is the exact sum of no published line value; the domain refuses such a candidate itself,
  // so the gate must not answer it with an authorization error first.
  const empty = orderPreparationInput({}, (candidate) => ({
    ...candidate,
    pricing: { ...candidate.pricing, publishedLines: [] },
  }));
  expect(governedAmount(empty)).toEqual({ currency: 'CZK', minor: 0 });
});

it('binds the resolver to the Action whose declaration names a server-derived total', () => {
  const payload = orderPreparationInput();
  // The declaration is the only thing that authorizes a resolver at all (O18): a client-supplied
  // total can never be decoded into the governed amount.
  expect(Schema.is(PrepareOrderCommitmentPayloadSchema)(payload)).toBe(true);
  expect(payload).not.toHaveProperty('purchaseValue');
});

/** One owner-verified frozen purchase value, as the commit command carries it (O91). */
const frozenPurchaseValue = (amount: string, currency = 'CZK') => ({
  monetaryAmount: { amount, currency },
  roundingRuleRevision: 'round-1',
  sourceRef: 'cart',
  sourceRevision: 'cart-1',
});

it('derives the governed amount of a frozen purchase value in its own currency (O91)', () => {
  expect(frozenPurchaseValueAccessAmount(frozenPurchaseValue('1000'))).toEqual({ currency: 'CZK', minor: 100_000 });
  // A zero-decimal currency is derived from the platform currency data, not assumed two-digit.
  expect(frozenPurchaseValueAccessAmount(frozenPurchaseValue('1000', 'JPY'))).toEqual({
    currency: 'JPY',
    minor: 1000,
  });
});

it('rounds a frozen value that is not representable in minor units up, never down (O91)', () => {
  // 0.333333 CZK is 33.3333 haléře: rounding down would govern less than the purchase.
  expect(frozenPurchaseValueAccessAmount(frozenPurchaseValue('0.333333'))).toEqual({ currency: 'CZK', minor: 34 });
});

it('refuses a frozen value in a currency the platform does not recognize instead of guessing (O91)', () => {
  let failure: unknown;
  try {
    frozenPurchaseValueAccessAmount(frozenPurchaseValue('1000', 'XAU'));
  } catch (error) {
    failure = error;
  }
  expect(Predicate.isTagged(failure, 'OrderPurchaseValueUnresolvable')).toBe(true);
});

/** The same candidate with exactly one published net line in the given currency and value. */
const singleLine = (currency: string, numerator: string, denominator = '1') =>
  orderPreparationInput({}, (candidate) => ({
    ...candidate,
    pricing: {
      ...candidate.pricing,
      publishedLines: [
        {
          ...publishedLines(orderPreparationInput())[0],
          lineCommercialValue: { amount: { denominator, numerator }, amountBasis: 'NET', currency },
        },
      ],
    },
  }));

it('derives the minor unit of a zero-decimal currency from the platform currency data', () => {
  // JPY has no minor unit; a hand-written two-digit scale would govern 100x the purchase.
  expect(governedAmount(singleLine('JPY', '1000'))).toEqual({ currency: 'JPY', minor: 1000 });
});

it('derives the minor unit of a three-decimal currency and still rounds up', () => {
  // 1/3 BHD is 333.33 fils: rounding any other way would govern less than the purchase.
  expect(governedAmount(singleLine('BHD', '1', '3'))).toEqual({ currency: 'BHD', minor: 334 });
});

it('refuses a currency the platform does not recognize instead of guessing two minor digits', () => {
  // XAU is a well-formed ISO 4217 code with no minor unit the owner can trust; the derivation must
  // refuse it rather than fall back to a default exponent and silently mis-govern the amount.
  let failure: unknown;
  try {
    governedAmount(singleLine('XAU', '1000'));
  } catch (error) {
    failure = error;
  }
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({ _tag: Schema.Literal('OrderPurchaseValueUnresolvable'), reason: Schema.String }),
  )(failure);
  if (Option.isNone(decoded)) {
    throw new TypeError('The derivation accepted a currency with no platform minor unit');
  }
  expect(decoded.value.reason).toContain('ISO 4217');
});
