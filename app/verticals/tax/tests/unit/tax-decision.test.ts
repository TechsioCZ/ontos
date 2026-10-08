import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { TaxDecision, TaxDecisionUnitSchema } from '../../src/domain/tax-decision.ts';

import {
  decisionUnitInput,
  decodeTaxDecision,
  decodeTaxDecisionUnit,
  exactDecimal,
  purchaseBindingInput,
  shippingSourceRefInput,
  taxDecisionInput,
} from './tax-domain-fixtures.ts';

type TaxDecisionUnitInput = typeof TaxDecisionUnitSchema.Encoded;
type BasisComponentInput = TaxDecisionUnitInput['taxableBasisInterpretation']['components'][number];
type ShippingComponentInput = Extract<BasisComponentInput, { readonly _tag: 'SHIPPING_ALLOCATION' }>;

const lineValue = (occurrenceId: string, amount: string): BasisComponentInput => ({
  _tag: 'LINE_COMMERCIAL_VALUE',
  amount: exactDecimal(amount),
  occurrenceId,
  pricingLineRef: `pricing-line-${occurrenceId}`,
});

const shipping = (amount: string, overrides: Partial<ShippingComponentInput> = {}): ShippingComponentInput => ({
  _tag: 'SHIPPING_ALLOCATION',
  amount: exactDecimal(amount),
  shippingSourceRef: shippingSourceRefInput,
  ...overrides,
});

const unitWith = (
  occurrenceId: string,
  components: readonly [BasisComponentInput, ...BasisComponentInput[]],
): TaxDecisionUnitInput => ({ ...decisionUnitInput(occurrenceId), taxableBasisInterpretation: { components } });

const withBoundShipping = (units: readonly [TaxDecisionUnitInput, ...TaxDecisionUnitInput[]]) => {
  const occurrenceIds = units.map(({ taxableSupplyUnit }) => taxableSupplyUnit.mapping.occurrenceId);
  const [first = 'o-1', ...rest] = occurrenceIds;
  return taxDecisionInput([first, ...rest], {
    purchaseBinding: purchaseBindingInput([first, ...rest], { shippingSourceRef: shippingSourceRefInput }),
    units,
  });
};

describe('Tax Decision', () => {
  it('#936 F7-F9 one purchase-scoped Decision preserves the exact unit set and per-unit meaning', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1', 'o-2']));

    expect(decision.units.map(({ taxableSupplyUnit }) => taxableSupplyUnit.unitId)).toEqual([
      'taxable-supply-unit:o-1',
      'taxable-supply-unit:o-2',
    ]);
    expect(decision.units[0]).toMatchObject({
      applicability: 'APPLICABLE',
      jurisdiction: 'CZ_DOMESTIC',
      treatment: { _tag: 'TAXABLE', ratePercent: '21' },
    });
  });

  it('#936 F18 #907 F110 a rate alone is not a complete unit Decision', () => {
    expect(() => decodeTaxDecisionUnit({ treatment: { _tag: 'TAXABLE', ratePercent: '21' } })).toThrow();
    const { taxableBasisInterpretation: _basis, ...withoutBasis } = decisionUnitInput('o-1');
    expect(() => decodeTaxDecisionUnit(withoutBasis)).toThrow();
    const { jurisdiction: _jurisdiction, ...withoutJurisdiction } = decisionUnitInput('o-1');
    expect(() => decodeTaxDecisionUnit(withoutJurisdiction)).toThrow();
  });

  it('#936 F10-F11 equal-valued units with the same rate are not merged', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1', 'o-2']));

    expect(decision.units).toHaveLength(2);
    expect(() => decodeTaxDecision(taxDecisionInput(['o-1', 'o-2'], { units: [decisionUnitInput('o-1')] }))).toThrow();
  });

  it('#936 F8 #937 F15 every bound occurrence maps to exactly one unit', () => {
    expect(() =>
      decodeTaxDecision(taxDecisionInput(['o-1'], { units: [decisionUnitInput('o-1'), decisionUnitInput('o-2')] })),
    ).toThrow();
    expect(() =>
      decodeTaxDecision(taxDecisionInput(['o-1'], { units: [decisionUnitInput('o-1'), decisionUnitInput('o-1')] })),
    ).toThrow();
  });

  it('#937 F27 #920 F19 Line Commercial Value stays bound to the unit source occurrence', () => {
    const misbound = {
      ...decisionUnitInput('o-1'),
      taxableBasisInterpretation: {
        components: [
          { _tag: 'LINE_COMMERCIAL_VALUE', amount: exactDecimal('100'), occurrenceId: 'o-2', pricingLineRef: 'line-2' },
        ],
      },
    };

    expect(() => decodeTaxDecisionUnit(misbound)).toThrow();
  });

  it('#920 F31-F33 #937 F29 Shipping allocates into a unit only with an exact Shipping source binding', () => {
    const withShipping = unitWith('o-1', [lineValue('o-1', '100'), shipping('33.3')]);

    expect(() => decodeTaxDecision(taxDecisionInput(['o-1'], { units: [withShipping] }))).toThrow();
    const decision = decodeTaxDecision(withBoundShipping([withShipping]));
    expect(decision.units[0]?.taxableBasisInterpretation.components).toHaveLength(2);
  });

  it('#920 F33 #937 F29-F30 a Shipping allocation is attributed to the exact bound Shipping source revision', () => {
    const otherRevision = shipping('10', { shippingSourceRef: { ...shippingSourceRefInput, revision: 2 } });

    expect(() =>
      decodeTaxDecision(withBoundShipping([unitWith('o-1', [lineValue('o-1', '100'), otherRevision])])),
    ).toThrow();
  });

  it('#933 F17-F18 #936 F19 a split across units keeps the owner-approved allocation-weights evidence', () => {
    const split = (evidence?: string) =>
      withBoundShipping([
        unitWith('o-1', [
          lineValue('o-1', '100'),
          shipping('30', evidence === undefined ? {} : { allocationWeightsEvidenceRef: evidence }),
        ]),
        unitWith('o-2', [
          lineValue('o-2', '100'),
          shipping('90', evidence === undefined ? {} : { allocationWeightsEvidenceRef: evidence }),
        ]),
      ]);

    expect(() => decodeTaxDecision(split())).toThrow();
    expect(decodeTaxDecision(split('owner-approved-allocation-key-1')).units).toHaveLength(2);
    expect(
      decodeTaxDecision(
        withBoundShipping([
          unitWith('o-1', [lineValue('o-1', '100'), shipping('0')]),
          unitWith('o-2', [lineValue('o-2', '100'), shipping('0')]),
        ]),
      ).units,
    ).toHaveLength(2);
  });

  it('#931 F8-F9 #907 F80-F82 a Line Commercial Value or Shipping allocation never enters one basis twice', () => {
    expect(() => decodeTaxDecisionUnit(unitWith('o-1', [lineValue('o-1', '50'), lineValue('o-1', '50')]))).toThrow();
    expect(() =>
      decodeTaxDecisionUnit(unitWith('o-1', [lineValue('o-1', '100'), shipping('10'), shipping('10')])),
    ).toThrow();
  });

  it('#936 F17 Taxable Basis components are non-negative exact values', () => {
    const negative = {
      ...decisionUnitInput('o-1'),
      taxableBasisInterpretation: {
        components: [
          { _tag: 'LINE_COMMERCIAL_VALUE', amount: exactDecimal('-1'), occurrenceId: 'o-1', pricingLineRef: 'line-1' },
        ],
      },
    };

    expect(() => decodeTaxDecisionUnit(negative)).toThrow();
  });

  it('#937 F33-F35 #941 F1 Tax-Relevant Time and Tax Evaluation Time stay distinct fields', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1']));

    expect(DateTime.formatIso(decision.taxRelevantTime)).toBe('2026-10-08T10:00:00.000Z');
    expect(DateTime.formatIso(decision.taxEvaluationTime)).toBe('2026-10-08T10:00:02.000Z');
    const { taxRelevantTime: _time, ...withoutRelevantTime } = taxDecisionInput(['o-1']);
    expect(() => decodeTaxDecision(withoutRelevantTime)).toThrow();
  });

  it('#941 F1 #937 F33-F35 #927 H both times are real instants and are not interchangeable', () => {
    const decision = decodeTaxDecision(taxDecisionInput(['o-1']));

    expect(() => decodeTaxDecision(taxDecisionInput(['o-1'], { taxRelevantTime: 'not-a-date' }))).toThrow();
    expect(() => decodeTaxDecision(taxDecisionInput(['o-1'], { taxEvaluationTime: 'not-a-date' }))).toThrow();
    // @ts-expect-error Tax Evaluation Time cannot stand in for Tax-Relevant Time.
    const swapped: TaxDecision = { ...decision, taxRelevantTime: decision.taxEvaluationTime };
    expect(DateTime.isGreaterThan(swapped.taxRelevantTime, decision.taxRelevantTime)).toBe(true);
  });
});
