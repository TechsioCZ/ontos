import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TaxExactRationalSchema,
  makeTaxExactRational,
  taxExactRationalFromDecimal,
} from '../../src/domain/tax-exact-rational.ts';
import {
  sumTaxMonetaryAmounts,
  taxMonetaryAmountFromMinorUnits,
  taxMonetaryAmountMinorUnits,
} from '../../src/domain/tax-monetary-amount.ts';

describe('Exact Tax values', () => {
  it('#907 F95-F96 reads decimals exactly without binary floating point', () => {
    expect(taxExactRationalFromDecimal('0.10')).toEqual(Option.some({ denominator: '10', numerator: '1' }));
    expect(taxExactRationalFromDecimal('100.00')).toEqual(Option.some({ denominator: '1', numerator: '100' }));
    expect(taxExactRationalFromDecimal('-2.5')).toEqual(Option.some({ denominator: '2', numerator: '-5' }));
    expect(taxExactRationalFromDecimal('1e2')).toEqual(Option.none());
  });

  it('#907 F95 keeps non-terminating intermediates exact in lowest terms', () => {
    expect(makeTaxExactRational(200n, -6n)).toEqual(Option.some({ denominator: '3', numerator: '-100' }));
    expect(makeTaxExactRational(0n, 7n)).toEqual(Option.some({ denominator: '1', numerator: '0' }));
    expect(makeTaxExactRational(1n, 0n)).toEqual(Option.none());
    expect(Schema.is(TaxExactRationalSchema)({ denominator: '6', numerator: '2' })).toBe(false);
  });

  it('#936 F31-F35 published CZK amounts round-trip through exact minor units and sum exactly', () => {
    const amount = Option.getOrThrow(taxMonetaryAmountFromMinorUnits(123_456n));

    expect(amount).toEqual({ amount: '1234.56', currency: 'CZK' });
    expect(taxMonetaryAmountMinorUnits(amount)).toBe(123_456n);
    expect(taxMonetaryAmountFromMinorUnits(-1n)).toEqual(Option.none());
    expect(
      sumTaxMonetaryAmounts([
        { amount: '0.10', currency: 'CZK' },
        { amount: '0.20', currency: 'CZK' },
      ]),
    ).toEqual({ amount: '0.30', currency: 'CZK' });
  });
});
