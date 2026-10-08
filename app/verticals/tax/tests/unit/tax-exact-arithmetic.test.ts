import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  NonNegativeTaxExactRationalSchema,
  addTaxExactRationals,
  divideTaxExactRationals,
  multiplyTaxExactRationals,
  roundHalfUpToMinorUnits,
  subtractTaxExactRationals,
  sumTaxExactRationals,
  taxExactRationalsEqual,
} from '../../src/domain/tax-exact-rational.ts';
import { exactDecimal } from './tax-domain-fixtures.ts';

const nonNegative = (value: string) => NonNegativeTaxExactRationalSchema.make(exactDecimal(value));

describe('Exact Tax arithmetic', () => {
  it('#935 F1-F2 #907 F95-F96 adds finite decimals exactly without binary floating point', () => {
    expect(addTaxExactRationals(exactDecimal('0.1'), exactDecimal('0.2'))).toEqual(exactDecimal('0.3'));
    expect(subtractTaxExactRationals(exactDecimal('10.01'), exactDecimal('10.005'))).toEqual(exactDecimal('0.005'));
    expect(multiplyTaxExactRationals(exactDecimal('0.03'), exactDecimal('0.21'))).toEqual(exactDecimal('0.0063'));
  });

  it('#935 F1 #907 F95 keeps a non-terminating division exact as a rational', () => {
    const oneSeventh = Option.getOrThrow(divideTaxExactRationals(exactDecimal('1'), exactDecimal('7')));
    const sixSevenths = Option.getOrThrow(divideTaxExactRationals(exactDecimal('6'), exactDecimal('7')));

    expect(oneSeventh).toEqual({ denominator: '7', numerator: '1' });
    expect(taxExactRationalsEqual(sumTaxExactRationals([oneSeventh, sixSevenths]), exactDecimal('1'))).toBe(true);
    expect(divideTaxExactRationals(exactDecimal('1'), exactDecimal('0'))).toEqual(Option.none());
  });

  it('#935 F21-F22 rounds non-negative values HALF_UP to whole minor units', () => {
    expect(roundHalfUpToMinorUnits(nonNegative('0.004'), 100n)).toBe(0n);
    expect(roundHalfUpToMinorUnits(nonNegative('0.005'), 100n)).toBe(1n);
    expect(
      roundHalfUpToMinorUnits(NonNegativeTaxExactRationalSchema.make({ denominator: '175', numerator: '3' }), 100n),
    ).toBe(2n);
  });

  it('#935 F21-F22 HALF_UP has no negative input: a negative exact value is not a non-negative rounding input', () => {
    expect(Schema.is(NonNegativeTaxExactRationalSchema)(exactDecimal('-0.005'))).toBe(false);
    expect(NonNegativeTaxExactRationalSchema.makeOption(exactDecimal('-0.006'))).toEqual(Option.none());
  });
});
