import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TaxRatePercentSchema, requireLaunchActivatedTaxTreatment } from '../../src/domain/tax-treatment.ts';

describe('Tax Treatment vocabulary', () => {
  it('#939 J #918 F2-F3 activates only ordinary domestic taxable treatment', () => {
    expect(requireLaunchActivatedTaxTreatment('TAXABLE')).toEqual(Result.succeed('TAXABLE'));
  });

  it('#939 F26-F29 #918 F22-F23 requiring an unactivated treatment is TAX_CASE_UNSUPPORTED, not zero', () => {
    expect(requireLaunchActivatedTaxTreatment('ZERO_RATE')).toEqual(
      Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'ZERO_RATE_TREATMENT' }),
    );
    expect(requireLaunchActivatedTaxTreatment('EXEMPTION')).toEqual(
      Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'EXEMPTION_TREATMENT' }),
    );
    expect(requireLaunchActivatedTaxTreatment('NOT_APPLICABLE')).toEqual(
      Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'NOT_APPLICABLE_TREATMENT' }),
    );
  });

  it('#939 F7 F30 a taxable rate is explicit and positive; missing or 0 % is not a taxable rate', () => {
    const isRate = Schema.is(TaxRatePercentSchema);

    expect(isRate('21')).toBe(true);
    expect(isRate('12')).toBe(true);
    expect(isRate('0')).toBe(false);
    expect(isRate('0.00')).toBe(false);
    expect(isRate('')).toBe(false);
    expect(isRate('21.0e0')).toBe(false);
  });
});
