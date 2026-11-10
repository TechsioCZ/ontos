import { describe, expect, it } from 'effect-rstest';
import { Result, Schema } from 'effect';

import { PaymentMonetaryAmountSchema, PaymentPositiveMonetaryAmountSchema } from '../../shared/domain/payment-money.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import { addAmounts, compareAmounts, sameAmount, subtractAmounts, sumAmounts } from '../../src/domain/money.ts';

const czk = (amountMinor: number): PaymentMonetaryAmount => ({ amountMinor, currency: 'CZK' });

describe('#1148 Payment money is exact CZK minor units', () => {
  it('#1148 accepts exact non-negative integer minor units in CZK only', () => {
    const decode = Schema.decodeUnknownSync(PaymentMonetaryAmountSchema);

    expect(decode({ amountMinor: 33_200, currency: 'CZK' })).toEqual(czk(33_200));
    expect(decode({ amountMinor: 0, currency: 'CZK' })).toEqual(czk(0));
    expect(decode({ amountMinor: Number.MAX_SAFE_INTEGER, currency: 'CZK' }).amountMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => decode({ amountMinor: 332.5, currency: 'CZK' })).toThrow();
    expect(() => decode({ amountMinor: -1, currency: 'CZK' })).toThrow();
    expect(() => decode({ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'CZK' })).toThrow();
    expect(() => decode({ amountMinor: 100, currency: 'EUR' })).toThrow();
  });

  it('#1148 Zero payable: a monetary operation amount must be positive', () => {
    const decode = Schema.decodeUnknownSync(PaymentPositiveMonetaryAmountSchema);

    expect(decode({ amountMinor: 1, currency: 'CZK' })).toEqual(czk(1));
    expect(() => decode({ amountMinor: 0, currency: 'CZK' })).toThrow();
  });

  it('#1148 Authoritative payable already includes the proper GROSS shipping treatment: 332.00 CZK stays 33200 haler', () => {
    const total = sumAmounts([czk(30_000), czk(3200)]);

    expect(Result.getOrThrow(total)).toEqual(czk(33_200));
    expect(sameAmount(Result.getOrThrow(total), czk(33_200))).toBe(true);
  });

  it('adds, subtracts and compares exactly without negative money', () => {
    expect(Result.getOrThrow(addAmounts(czk(600), czk(400)))).toEqual(czk(1000));
    expect(Result.getOrThrow(subtractAmounts(czk(1000), czk(600)))).toEqual(czk(400));
    expect(Result.isFailure(subtractAmounts(czk(400), czk(600)))).toBe(true);
    expect(Result.getOrThrow(compareAmounts(czk(1), czk(2)))).toBe(-1);
    expect(Result.getOrThrow(compareAmounts(czk(2), czk(2)))).toBe(0);
    expect(Result.getOrThrow(compareAmounts(czk(3), czk(2)))).toBe(1);
    expect(Result.getOrThrow(sumAmounts([]))).toEqual(czk(0));
  });

  it('refuses overflow beyond the safe integer range instead of losing precision', () => {
    const overflow = addAmounts(czk(Number.MAX_SAFE_INTEGER), czk(1));

    expect(Result.isFailure(overflow)).toBe(true);
    if (Result.isFailure(overflow)) {
      expect(overflow.failure.code).toBe('payment_amount_invalid');
    }
    expect(Result.isFailure(sumAmounts([czk(Number.MAX_SAFE_INTEGER), czk(1)]))).toBe(true);
  });
});
