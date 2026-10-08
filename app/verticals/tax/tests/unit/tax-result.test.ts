import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TaxResultSchema, composeTaxResult, taxResultBindsDecision } from '../../src/domain/tax-result.ts';
import { TaxableTreatmentSchema } from '../../src/domain/tax-treatment.ts';
import {
  composeResult,
  decisionUnitInput,
  decodeTaxDecision,
  roundingPolicy,
  taxDecisionInput,
} from './tax-domain-fixtures.ts';

const decodeResult = Schema.decodeUnknownSync(TaxResultSchema);
interface AmountInput {
  readonly amount: string | number;
  readonly currency: string;
}

const resultInput = (units: readonly object[], total: AmountInput, currency = 'CZK') => ({
  currency,
  purchaseTaxTotal: total,
  taxDecisionId: 'tax-decision-1',
  taxRoundingPolicy: roundingPolicy,
  units,
});

describe('Tax Result', () => {
  it('#936 F28-F30 keeps one published amount bound to each exact unit', () => {
    const decision = decodeTaxDecision(
      taxDecisionInput(['o-1', 'o-2'], { units: [decisionUnitInput('o-1'), decisionUnitInput('o-2', '50.00')] }),
    );
    const result = composeResult(decision);

    expect(result.units).toEqual([
      { publishedTaxAmount: { amount: '21.00', currency: 'CZK' }, taxableSupplyUnitId: 'taxable-supply-unit:o-1' },
      { publishedTaxAmount: { amount: '10.50', currency: 'CZK' }, taxableSupplyUnitId: 'taxable-supply-unit:o-2' },
    ]);
    expect(result.currency).toBe('CZK');
    expect(result.taxDecisionId).toBe(decision.decisionId);
    expect(taxResultBindsDecision(decision, result)).toBe(true);
  });

  it('#936 F32 F56 #935 F56 the Result retains the Tax Rounding policy revision that published it', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1']));
    const revision2 = Option.getOrThrow(composeTaxResult(decision, { ...roundingPolicy, revision: 2 }));

    expect(composeResult(decision).taxRoundingPolicy.revision).toBe(1);
    expect(revision2.taxRoundingPolicy.revision).toBe(2);
    const { taxRoundingPolicy: _policy, ...withoutPolicy } = Schema.encodeSync(TaxResultSchema)(revision2);
    expect(() => decodeResult(withoutPolicy)).toThrow();
  });

  it('#936 F35-F37 purchase total is the exact sum of published unit amounts, never re-rounded', () => {
    const decision = decodeTaxDecision(
      taxDecisionInput(['o-1', 'o-2', 'o-3'], {
        units: [decisionUnitInput('o-1', '0.03'), decisionUnitInput('o-2', '0.03'), decisionUnitInput('o-3', '0.03')],
      }),
    );

    expect(composeResult(decision).purchaseTaxTotal).toEqual({ amount: '0.03', currency: 'CZK' });
  });

  it('#936 F35 rejects a Result whose total is not the exact sum of its unit amounts', () => {
    expect(() =>
      decodeResult(
        resultInput(
          [
            { publishedTaxAmount: { amount: '0.01', currency: 'CZK' }, taxableSupplyUnitId: 'u-1' },
            { publishedTaxAmount: { amount: '0.02', currency: 'CZK' }, taxableSupplyUnitId: 'u-2' },
          ],
          { amount: '0.02', currency: 'CZK' },
        ),
      ),
    ).toThrow();
  });

  it('#936 F31 #921 F26-F28 currency is explicit CZK and amounts are exact 0.01 decimals', () => {
    const unit = { publishedTaxAmount: { amount: '1.00', currency: 'CZK' }, taxableSupplyUnitId: 'u-1' };

    expect(decodeResult(resultInput([unit], unit.publishedTaxAmount)).currency).toBe('CZK');
    expect(() => decodeResult(resultInput([unit], unit.publishedTaxAmount, 'EUR'))).toThrow();
    expect(() =>
      decodeResult(
        resultInput([{ ...unit, publishedTaxAmount: { amount: 1, currency: 'CZK' } }], { amount: 1, currency: 'CZK' }),
      ),
    ).toThrow();
    expect(() =>
      decodeResult(
        resultInput([{ ...unit, publishedTaxAmount: { amount: '1.005', currency: 'CZK' } }], {
          amount: '1.005',
          currency: 'CZK',
        }),
      ),
    ).toThrow();
  });

  it('#936 F28-F29 a Result for another Decision or unit set is not bound', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1', 'o-2']));
    const otherDecision = decodeTaxDecision(taxDecisionInput(['o-1', 'o-2'], { decisionId: 'tax-decision-2' }));
    const oneUnitDecision = decodeTaxDecision(taxDecisionInput(['o-1']));

    expect(taxResultBindsDecision(otherDecision, composeResult(decision))).toBe(false);
    expect(taxResultBindsDecision(oneUnitDecision, composeResult(oneUnitDecision))).toBe(true);
    expect(taxResultBindsDecision(decision, composeResult(oneUnitDecision))).toBe(false);
  });

  it('#936 F27 #939 F3-F4 a successful zero keeps the taxable Decision that explains it', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1'], { units: [decisionUnitInput('o-1', '0.00')] }));

    expect(composeResult(decision).purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
    const [unit] = decision.units;
    expect(Schema.is(TaxableTreatmentSchema)(unit.treatment)).toBe(true);
    expect(unit.treatment.ratePercent).toBe('21');
  });
});
