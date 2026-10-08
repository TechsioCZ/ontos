import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PurchaseDemandOccurrenceIdSchema } from '../../src/domain/purchase-binding.ts';
import { exactTaxContribution } from '../../src/domain/tax-rounding.ts';
import {
  LineCommercialValueBasisSchema,
  PublishedPricingLineSchema,
  composeLineTaxableBasis,
  lineTaxableBasisForOccurrence,
} from '../../src/domain/taxable-basis.ts';
import {
  catalogSelectionInput,
  decisionUnitInput,
  decodeTaxDecisionUnit,
  exactDecimal,
} from './tax-domain-fixtures.ts';

const decodeLine = Schema.decodeUnknownSync(PublishedPricingLineSchema);
const czk = (amount: string) => ({ amount: exactDecimal(amount), currency: 'CZK' });
const contribution = (contributionFamily: string, amount: string) => ({
  amount: czk(amount),
  contributionFamily,
  contributionRef: `contribution-${contributionFamily}`,
});
const pricingLine = (occurrenceId: string, value: string, breakdown: readonly object[] = [], currency = 'CZK') =>
  decodeLine({
    breakdown,
    lineCommercialValue: { amount: exactDecimal(value), currency },
    occurrenceId,
    pricingLineRef: `pricing-line-${occurrenceId}`,
  });

describe('Taxable Basis composition', () => {
  it('#931 F3-F4 BDD uses the published 100.00 CZK Line Commercial Value, not Pricing internals', () => {
    const line = pricingLine('o-1', '100.00', [
      contribution('PRICE', '99.996'),
      contribution('PRICING_LINE_ROUNDING_ADJUSTMENT', '0.004'),
    ]);

    const { basisComponent } = Result.getOrThrow(composeLineTaxableBasis(line));

    expect(basisComponent.amount).toEqual(exactDecimal('100.00'));
    expect(basisComponent.occurrenceId).toBe('o-1');
    expect(basisComponent.pricingLineRef).toBe('pricing-line-o-1');
  });

  it('#931 F7-F11 #932 F7-F9 BDD Discount, Promotion and Fees are included exactly once and kept as evidence', () => {
    const breakdown = [
      contribution('PRICE', '100.00'),
      contribution('DISCOUNT', '-15.00'),
      contribution('PROMOTION_ALLOCATION', '-5.00'),
      contribution('RECYCLING_FEE', '4.00'),
      contribution('COPYRIGHT_FEE', '6.00'),
    ];
    const composed = Result.getOrThrow(composeLineTaxableBasis(pricingLine('o-1', '90.00', breakdown)));

    expect(composed.basisComponent.amount).toEqual(exactDecimal('90.00'));
    expect(composed.pricingBreakdownEvidence).toEqual(
      decodeLine({ ...pricingLine('o-1', '90.00'), breakdown }).breakdown,
    );
  });

  it('#932 F10-F13 F22 BDD a fee label never creates a separate supply, component or treatment', () => {
    const lines = [
      pricingLine('o-1', '104.00', [contribution('RECYCLING_FEE', '4.00')]),
      pricingLine('o-2', '106.00', [contribution('COPYRIGHT_FEE', '6.00')]),
      pricingLine('o-3', '110.00', [contribution('FUTURE_DISTINCT_FEE', '10.00')]),
    ];

    for (const line of lines) {
      const composed = Result.getOrThrow(composeLineTaxableBasis(line));
      expect(Schema.is(LineCommercialValueBasisSchema)(composed.basisComponent)).toBe(true);
      expect(composed.basisComponent.amount).toEqual(line.lineCommercialValue.amount);
    }
  });

  it('#931 F15-F16 #918 F31-F33 a non-CZK line is never relabelled or converted', () => {
    expect(composeLineTaxableBasis(pricingLine('o-1', '4.00', [], 'EUR'))).toEqual(
      Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'NON_CZK_CURRENCY' }),
    );
  });

  it('#931 F14 a missing or ambiguous owner-issued amount is never estimated', () => {
    const occurrenceId = PurchaseDemandOccurrenceIdSchema.make('o-2');
    const lines = [pricingLine('o-1', '10.00')];

    expect(lineTaxableBasisForOccurrence(lines, occurrenceId)).toEqual(
      Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }),
    );
    expect(
      lineTaxableBasisForOccurrence([pricingLine('o-2', '10.00'), pricingLine('o-2', '12.00')], occurrenceId),
    ).toEqual(Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' }));
    expect(Result.isSuccess(lineTaxableBasisForOccurrence([...lines, pricingLine('o-2', '0.00')], occurrenceId))).toBe(
      true,
    );
  });

  it('#934 F11 F21-F22 BDD a whole-treatment Set uses its full 1000.00 CZK without component allocation', () => {
    const composed = Result.getOrThrow(
      composeLineTaxableBasis(pricingLine('set-o-1', '1000.00', [contribution('PRICE', '1000.00')])),
    );
    const input = decisionUnitInput('set-o-1');
    const setSelection = {
      ...catalogSelectionInput('set-variant-1'),
      setCompositionRevisionRef: { revision: 1, setCompositionId: 'set-composition-1' },
    };
    const unit = decodeTaxDecisionUnit({
      ...input,
      taxableBasisInterpretation: { components: [composed.basisComponent] },
      taxableSupplyUnit: {
        mapping: { _tag: 'WHOLE_TREATMENT_SET', catalogSelection: setSelection, occurrenceId: 'set-o-1' },
        unitId: 'taxable-supply-unit:set-o-1',
      },
      taxClassification: { ...input.taxClassification, catalogSelection: setSelection },
    });

    expect(unit.taxableBasisInterpretation.components).toHaveLength(1);
    expect(exactTaxContribution(unit.taxableBasisInterpretation, unit.treatment)).toEqual(exactDecimal('210'));
  });
});
