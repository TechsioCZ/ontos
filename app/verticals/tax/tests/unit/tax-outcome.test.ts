import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TaxRuleMissingSchema } from '../../src/domain/tax-non-success-outcome.ts';
import { TaxOutcomeSchema, TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import { TaxResultSchema } from '../../src/domain/tax-result.ts';
import { composeResult, decodeTaxDecision, encodeTaxDecision, taxDecisionInput } from './tax-domain-fixtures.ts';

const decodeOutcome = Schema.decodeUnknownSync(TaxOutcomeSchema);
const encodeResult = Schema.encodeSync(TaxResultSchema);

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
    expect(() =>
      decodeOutcome({
        _tag: 'TAX_DETERMINED',
        result: {
          currency: 'CZK',
          purchaseTaxTotal: { amount: '0.00', currency: 'CZK' },
          taxDecisionId: 'tax-decision-1',
          units: [{ publishedTaxAmount: { amount: '0.00', currency: 'CZK' }, taxableSupplyUnitId: 'u-1' }],
        },
      }),
    ).toThrow();
    expect(() => decodeOutcome({ amount: '0.00', currency: 'CZK' })).toThrow();
    expect(() => decodeOutcome(null)).toThrow();
    expect(() => decodeOutcome({})).toThrow();
  });
});
