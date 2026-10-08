import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  SignedTaxMonetaryAmountSchema,
  signedTaxMonetaryAmountFromMinorUnits,
  signedTaxMonetaryAmountMinorUnits,
} from '../../src/domain/tax-monetary-amount.ts';

const isSigned = Schema.is(SignedTaxMonetaryAmountSchema);

describe('Signed Tax Monetary Amount', () => {
  it('#948 F19 represents a signed Tax difference exactly at 0.01 CZK and round-trips its minor units', () => {
    for (const minorUnits of [-20_998n, -6299n, -1n, 0n, 1n, 6300n]) {
      const amount = signedTaxMonetaryAmountFromMinorUnits(minorUnits);
      expect(isSigned(amount)).toBe(true);
      expect(signedTaxMonetaryAmountMinorUnits(amount)).toBe(minorUnits);
    }
    expect(signedTaxMonetaryAmountFromMinorUnits(-6299n).amount).toBe('-62.99');
    expect(signedTaxMonetaryAmountFromMinorUnits(-1n).amount).toBe('-0.01');
    expect(signedTaxMonetaryAmountFromMinorUnits(0n).amount).toBe('0.00');
  });

  it('has one representation of zero and no binary-float or unrounded form', () => {
    for (const amount of ['-0.00', '1.5', '-62.999', '1e2', '01.00', '-']) {
      expect(isSigned({ amount, currency: 'CZK' })).toBe(false);
    }
    expect(isSigned({ amount: '-62.99', currency: 'EUR' })).toBe(false);
  });
});
