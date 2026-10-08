import { Array as Arr, Schema, pipe } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { sumTaxExactRationals } from '../../src/domain/tax-exact-rational.ts';
import { sumTaxMonetaryAmounts } from '../../src/domain/tax-monetary-amount.ts';
import {
  TaxRoundingPolicySchema,
  TaxUnitRoundingEvidenceSchema,
  exactTaxContribution,
  finalizeTaxDecisionUnits,
  finalizeTaxableSupplyUnitTax,
} from '../../src/domain/tax-rounding.ts';
import type { TaxUnitRoundingEvidence } from '../../src/domain/tax-rounding.ts';
import {
  decisionUnitInput,
  decodeTaxDecision,
  decodeTaxDecisionUnit,
  exactDecimal,
  roundingPolicy as policy,
  shippingSourceRefInput,
  taxDecisionInput,
} from './tax-domain-fixtures.ts';

/** Purchase total as the exact sum of the already published unit amounts (#935 F27-F30). */
const publishedTotal = (units: readonly [TaxUnitRoundingEvidence, ...TaxUnitRoundingEvidence[]]) =>
  sumTaxMonetaryAmounts(
    pipe(
      units,
      Arr.map(({ publishedTaxAmount }) => publishedTaxAmount),
    ),
  );
/** Publishes an exact contribution: a 100 % rate makes the contribution equal the basis, isolating the boundary. */
const publish = (occurrenceId: string, exact: string) =>
  finalizeTaxableSupplyUnitTax(decodeTaxDecisionUnit(decisionUnitInput(occurrenceId, exact, '100')), policy);
const decodeEvidence = Schema.decodeUnknownSync(TaxUnitRoundingEvidenceSchema);

describe('Tax Rounding', () => {
  it('#935 F21-F22 BDD rounds 10.004 / 10.005 / 10.006 HALF_UP to 0.01 CZK', () => {
    expect(publish('u-1', '10.004').publishedTaxAmount).toEqual({ amount: '10.00', currency: 'CZK' });
    expect(publish('u-1', '10.005').publishedTaxAmount).toEqual({ amount: '10.01', currency: 'CZK' });
    expect(publish('u-1', '10.006').publishedTaxAmount).toEqual({ amount: '10.01', currency: 'CZK' });
  });

  it('#935 F27-F30 BDD two 0.0063 units publish 0.01 + 0.01 = 0.02, not ROUND(SUM) = 0.01', () => {
    const units = [publish('u-1', '0.0063'), publish('u-2', '0.0063')] as const;

    expect(units.map(({ publishedTaxAmount }) => publishedTaxAmount.amount)).toEqual(['0.01', '0.01']);
    expect(publishedTotal(units)).toEqual({ amount: '0.02', currency: 'CZK' });
    const roundOfSum = publish('aggregate', '0.0126').publishedTaxAmount;
    expect(roundOfSum.amount).toBe('0.01');
    expect(publishedTotal(units).amount).not.toBe(roundOfSum.amount);
  });

  it('#935 F31-F34 BDD two 21 % units of one Decision are rounded independently', () => {
    const decision = decodeTaxDecision(
      taxDecisionInput(['o-1', 'o-2'], { units: [decisionUnitInput('o-1', '0.03'), decisionUnitInput('o-2', '0.03')] }),
    );
    const units = finalizeTaxDecisionUnits(decision, policy);

    expect(units).toHaveLength(2);
    expect(units.map(({ taxableSupplyUnitId }) => taxableSupplyUnitId)).toEqual([
      'taxable-supply-unit:o-1',
      'taxable-supply-unit:o-2',
    ]);
    expect(units.map(({ exactTaxContribution: exact }) => exact)).toEqual([
      exactDecimal('0.0063'),
      exactDecimal('0.0063'),
    ]);
    expect(publishedTotal(units)).toEqual({ amount: '0.02', currency: 'CZK' });
  });

  it('#935 F35-F44 BDD 31.4925 publishes 31.49 with -0.0025 as Tax rounding evidence, no balancing haler', () => {
    const unit = publish('u-1', '31.4925');
    const other = publish('u-2', '10.004');

    expect(unit.publishedTaxAmount).toEqual({ amount: '31.49', currency: 'CZK' });
    expect(unit.taxRoundingAdjustment).toEqual(exactDecimal('-0.0025'));
    expect(other.publishedTaxAmount).toEqual({ amount: '10.00', currency: 'CZK' });
    expect(publishedTotal([unit, other])).toEqual({ amount: '41.49', currency: 'CZK' });
    expect(decodeEvidence(Schema.encodeSync(TaxUnitRoundingEvidenceSchema)(unit))).toEqual(unit);
  });

  it('#935 F36 F42-F44 rejects evidence with a balancing haler or a mismatched adjustment', () => {
    const unit = Schema.encodeSync(TaxUnitRoundingEvidenceSchema)(publish('u-1', '0.0063'));

    expect(() => decodeEvidence({ ...unit, publishedTaxAmount: { amount: '0.00', currency: 'CZK' } })).toThrow();
    expect(() => decodeEvidence({ ...unit, taxRoundingAdjustment: exactDecimal('0') })).toThrow();
  });

  it('#935 F12-F19 BDD calculates the exact unit contribution from exact basis and rate, rounding only at the end', () => {
    const unit = decodeTaxDecisionUnit({
      ...decisionUnitInput('o-1', '100.00', '12'),
      taxableBasisInterpretation: {
        components: [
          {
            _tag: 'LINE_COMMERCIAL_VALUE',
            amount: exactDecimal('100.00'),
            occurrenceId: 'o-1',
            pricingLineRef: 'pricing-line-o-1',
          },
          {
            _tag: 'SHIPPING_ALLOCATION',
            amount: { denominator: '7', numerator: '1' },
            shippingSourceRef: shippingSourceRefInput,
          },
        ],
      },
    });

    expect(exactTaxContribution(unit.taxableBasisInterpretation, unit.treatment)).toEqual({
      denominator: '175',
      numerator: '2103',
    });
    expect(finalizeTaxableSupplyUnitTax(unit, policy).publishedTaxAmount).toEqual({
      amount: '12.02',
      currency: 'CZK',
    });
  });

  it('#935 F53-F55 retrying the same exact evaluation gives the same haler', () => {
    const unit = decodeTaxDecisionUnit(decisionUnitInput('o-1', '47.64', '21'));

    expect(finalizeTaxableSupplyUnitTax(unit, policy)).toEqual(finalizeTaxableSupplyUnitTax(unit, policy));
    expect(finalizeTaxableSupplyUnitTax(unit, policy).publishedTaxAmount.amount).toBe('10.00');
  });

  it('#935 F56-F58 the rounding policy is versioned, retained on evidence and closed to CZK', () => {
    const decodePolicy = Schema.decodeUnknownSync(TaxRoundingPolicySchema);

    expect(publish('u-1', '1').taxRoundingPolicy.revision).toBe(1);
    expect(() => decodePolicy({ ...policy, currency: 'EUR' })).toThrow();
    expect(() => decodePolicy({ ...policy, mode: 'ROUND_HALF_EVEN' })).toThrow();
    expect(() => decodePolicy({ ...policy, revision: 0 })).toThrow();
  });

  it('#935 F25 F45 the purchase total is explainable from the exact list of published unit amounts', () => {
    const units = [publish('u-1', '0.004'), publish('u-2', '0.005'), publish('u-3', '0.006')] as const;
    const exactSum = sumTaxExactRationals(
      pipe(
        units,
        Arr.map(({ exactTaxContribution: exact }) => exact),
      ),
    );

    expect(units.map(({ publishedTaxAmount }) => publishedTaxAmount.amount)).toEqual(['0.00', '0.01', '0.01']);
    expect(publishedTotal(units)).toEqual({ amount: '0.02', currency: 'CZK' });
    expect(exactSum).toEqual(exactDecimal('0.015'));
  });
});
