import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TaxRuleMissingSchema } from '../../src/domain/tax-non-success-outcome.ts';
import { TaxOutcomeSchema, TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import { TaxResultSchema } from '../../src/domain/tax-result.ts';
import {
  composeResult,
  decisionUnitInput,
  decodeTaxDecision,
  encodeTaxDecision,
  exactDecimal,
  roundingPolicy,
  taxDecisionInput,
} from './tax-domain-fixtures.ts';

const decodeOutcome = Schema.decodeUnknownSync(TaxOutcomeSchema);
const encodeResult = Schema.encodeSync(TaxResultSchema);
const decodeResult = Schema.decodeUnknownSync(TaxResultSchema);

/** Otherwise valid zero Result: one 0.00 CZK unit with its exact zero contribution under the Launch policy. */
const zeroResultInput = {
  currency: 'CZK',
  purchaseTaxTotal: { amount: '0.00', currency: 'CZK' },
  taxDecisionId: 'tax-decision-1',
  taxRoundingPolicy: roundingPolicy,
  units: [
    {
      exactTaxContribution: exactDecimal('0'),
      publishedTaxAmount: { amount: '0.00', currency: 'CZK' },
      taxableSupplyUnitId: 'taxable-supply-unit:o-1',
      taxRoundingAdjustment: exactDecimal('0'),
      taxRoundingPolicy: roundingPolicy,
    },
  ],
} as const;

describe('Tax Outcome', () => {
  it('#936 F7 F20 #938 F1 success carries one Decision with its exactly bound Result', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1']));
    const outcome = decodeOutcome({
      _tag: 'TAX_DETERMINED',
      decision: encodeTaxDecision(decision),
      result: encodeResult(composeResult(decision)),
    });

    expect(Schema.is(TaxOutcomeSuccessSchema)(outcome)).toBe(true);
  });

  it('#936 F28-F29 success rejects a Result bound to another Decision', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1']));
    const otherDecision = decodeTaxDecision(taxDecisionInput(['o-1'], { decisionId: 'tax-decision-2' }));

    expect(() =>
      decodeOutcome({
        _tag: 'TAX_DETERMINED',
        decision: encodeTaxDecision(decision),
        result: encodeResult(composeResult(otherDecision)),
      }),
    ).toThrow();
  });

  it('#936 F19 F27 F32 #939 F2 #907 F132 success rejects Result amounts that do not follow from the Decision', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1']));

    expect(composeResult(decision).purchaseTaxTotal).toEqual({ amount: '21.00', currency: 'CZK' });
    expect(() =>
      decodeOutcome({ _tag: 'TAX_DETERMINED', decision: encodeTaxDecision(decision), result: zeroResultInput }),
    ).toThrow();
    const zeroDecision = decodeTaxDecision(taxDecisionInput(['o-1'], { units: [decisionUnitInput('o-1', '0.00')] }));
    const zeroOutcome = decodeOutcome({
      _tag: 'TAX_DETERMINED',
      decision: encodeTaxDecision(zeroDecision),
      result: zeroResultInput,
    });
    expect(Schema.is(TaxOutcomeSuccessSchema)(zeroOutcome)).toBe(true);
  });

  it('#936 F21 F26 #938 F2 a non-success outcome keeps no Decision or Result', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1']));
    const outcome = decodeOutcome({
      _tag: 'TAX_RULE_MISSING',
      decision: encodeTaxDecision(decision),
      result: encodeResult(composeResult(decision)),
    });

    expect(Schema.is(TaxRuleMissingSchema)(outcome)).toBe(true);
    expect(Object.keys(outcome)).toEqual(['_tag']);
  });

  it('#936 F27 #939 F1-F2 F10 a zero amount without a Decision is not a successful outcome', () => {
    expect(decodeResult(zeroResultInput).purchaseTaxTotal.amount).toBe('0.00');
    expect(() => decodeOutcome({ _tag: 'TAX_DETERMINED', result: zeroResultInput })).toThrow();
    expect(() => decodeOutcome({ amount: '0.00', currency: 'CZK' })).toThrow();
    expect(() => decodeOutcome(null)).toThrow();
    expect(() => decodeOutcome({})).toThrow();
  });
});
