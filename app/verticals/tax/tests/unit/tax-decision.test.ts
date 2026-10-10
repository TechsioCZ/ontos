import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  TaxDecision,
  TaxDecisionSchema,
  TaxDecisionUnitSchema,
} from '../../shared/domain/tax-kernel/tax-decision.ts';

import {
  catalogSelectionInput,
  decisionUnitInput,
  decodeTaxDecision,
  decodeTaxDecisionUnit,
  decodeTaxableDecisionUnit,
  exactDecimal,
  nonPayerDecisionUnitInput,
  nonPayerTaxDecisionInput,
  purchaseBindingInput,
  shippingSourceRefInput,
  taxDecisionInput,
} from './tax-domain-fixtures.ts';

type TaxDecisionUnitInput = typeof TaxDecisionUnitSchema.Encoded;
type TaxDecisionInput = typeof TaxDecisionSchema.Encoded;
type ShippingAllocationInput = NonNullable<TaxDecisionInput['shippingAllocation']>;
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

/** Purchase-level allocation of the owner-issued Shipping amount, entry by entry (unit id, basis component). */
const allocationOf = (
  ownerIssuedShippingAmount: string,
  entries: readonly [readonly [string, ShippingComponentInput], ...(readonly [string, ShippingComponentInput])[]],
): ShippingAllocationInput => ({
  ownerIssuedShippingAmount: exactDecimal(ownerIssuedShippingAmount),
  unitAllocations: [
    { basisComponent: entries[0][1], taxableSupplyUnitId: `taxable-supply-unit:${entries[0][0]}` },
    ...entries.slice(1).map(([occurrenceId, basisComponent]) => ({
      basisComponent,
      taxableSupplyUnitId: `taxable-supply-unit:${occurrenceId}`,
    })),
  ],
});

const withBoundShipping = (
  units: readonly [TaxDecisionUnitInput, ...TaxDecisionUnitInput[]],
  shippingAllocation?: ShippingAllocationInput,
) => {
  const occurrenceIds = units.map(({ taxableSupplyUnit }) => taxableSupplyUnit.mapping.occurrenceId);
  const [first = 'o-1', ...rest] = occurrenceIds;
  const input = taxDecisionInput([first, ...rest], {
    purchaseBinding: purchaseBindingInput([first, ...rest], { shippingSourceRef: shippingSourceRefInput }),
    units,
  });
  return shippingAllocation === undefined ? input : { ...input, shippingAllocation };
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
      jurisdiction: { jurisdiction: 'CZ_DOMESTIC' },
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
    const decision = decodeTaxDecision(
      withBoundShipping([withShipping], allocationOf('33.3', [['o-1', shipping('33.3')]])),
    );
    expect(decision.units[0]?.taxableBasisInterpretation.components).toHaveLength(2);
  });

  it('#920 F33 #937 F29-F30 a Shipping allocation is attributed to the exact bound Shipping source revision', () => {
    const otherRevision = shipping('10', { shippingSourceRef: { ...shippingSourceRefInput, revision: 2 } });

    expect(() =>
      decodeTaxDecision(
        withBoundShipping(
          [unitWith('o-1', [lineValue('o-1', '100'), otherRevision])],
          allocationOf('10', [['o-1', otherRevision]]),
        ),
      ),
    ).toThrow();
  });

  it('#933 F17-F18 #936 F19 a split across units keeps the owner-approved allocation-weights evidence', () => {
    const split = (evidence?: string) => {
      const attribution = evidence === undefined ? {} : { allocationWeightsEvidenceRef: evidence };
      return withBoundShipping(
        [
          unitWith('o-1', [lineValue('o-1', '100'), shipping('30', attribution)]),
          unitWith('o-2', [lineValue('o-2', '100'), shipping('90', attribution)]),
        ],
        allocationOf('120', [
          ['o-1', shipping('30', attribution)],
          ['o-2', shipping('90', attribution)],
        ]),
      );
    };

    expect(() => decodeTaxDecision(split())).toThrow();
    expect(decodeTaxDecision(split('owner-approved-allocation-key-1')).units).toHaveLength(2);
    expect(
      decodeTaxDecision(
        withBoundShipping(
          [
            unitWith('o-1', [lineValue('o-1', '100'), shipping('0')]),
            unitWith('o-2', [lineValue('o-2', '100'), shipping('0')]),
          ],
          allocationOf('0', [
            ['o-1', shipping('0')],
            ['o-2', shipping('0')],
          ]),
        ),
      ).units,
    ).toHaveLength(2);
  });

  it('#907 F85 #933 F8 F12 F21 #935 F14 #920 F32-F34 bound Shipping is allocated completely and exactly', () => {
    const evidence = { allocationWeightsEvidenceRef: 'owner-approved-allocation-key-1' };
    const allocation = allocationOf('120', [
      ['o-1', shipping('30', evidence)],
      ['o-2', shipping('90', evidence)],
    ]);
    const withShipping = unitWith('o-1', [lineValue('o-1', '100'), shipping('30', evidence)]);
    const withoutShipping = decisionUnitInput('o-2');

    expect(() => decodeTaxDecision(withBoundShipping([decisionUnitInput('o-1')]))).toThrow();
    expect(() => decodeTaxDecision(withBoundShipping([withShipping, withoutShipping], allocation))).toThrow();
    expect(() =>
      decodeTaxDecision(
        withBoundShipping(
          [withShipping, unitWith('o-2', [lineValue('o-2', '100'), shipping('80', evidence)])],
          allocation,
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeTaxDecision(
        withBoundShipping(
          [unitWith('o-1', [lineValue('o-1', '100'), shipping('30')]), withoutShipping],
          allocationOf('30', [['o-1', shipping('30')]]),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      decodeTaxDecision(
        withBoundShipping(
          [unitWith('o-1', [lineValue('o-1', '100'), shipping('30', evidence)])],
          allocationOf('30', [
            ['o-1', shipping('30', evidence)],
            ['o-9', shipping('0', evidence)],
          ]),
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeTaxDecision(taxDecisionInput(['o-1'], { shippingAllocation: allocationOf('0', [['o-1', shipping('0')]]) })),
    ).toThrow();
  });

  it('#931 F8-F9 #907 F80-F82 a Line Commercial Value or Shipping allocation never enters one basis twice', () => {
    expect(() => decodeTaxDecisionUnit(unitWith('o-1', [lineValue('o-1', '50'), lineValue('o-1', '50')]))).toThrow();
    expect(() =>
      decodeTaxDecisionUnit(unitWith('o-1', [lineValue('o-1', '100'), shipping('10'), shipping('10')])),
    ).toThrow();
  });

  it('#931 F3-F4 F17 #920 F19 F21 #936 F17 each unit carries exactly one Line Commercial Value per source occurrence', () => {
    expect(() => decodeTaxDecisionUnit(unitWith('o-1', [shipping('30')]))).toThrow();
    expect(
      decodeTaxDecisionUnit(unitWith('o-1', [lineValue('o-1', '0')])).taxableBasisInterpretation.components,
    ).toEqual([
      {
        _tag: 'LINE_COMMERCIAL_VALUE',
        amount: exactDecimal('0'),
        occurrenceId: 'o-1',
        pricingLineRef: 'pricing-line-o-1',
      },
    ]);
  });

  it('#920 F18 #936 F15 F19 #927 H #937 F13 F15 F31-F32 a unit binds its classification, place evidence and exact Catalog Selection', () => {
    const otherSelection = catalogSelectionInput('variant-2');
    const unit = decisionUnitInput('o-1');
    const reselected = {
      ...unit,
      taxableSupplyUnit: {
        ...unit.taxableSupplyUnit,
        mapping: { ...unit.taxableSupplyUnit.mapping, catalogSelection: otherSelection },
      },
      taxClassification: { ...unit.taxClassification, catalogSelection: otherSelection },
    };

    expect(decodeTaxableDecisionUnit(reselected).taxClassification.catalogSelection.variantRef).toBe('variant-2');
    expect(() => decodeTaxDecision(taxDecisionInput(['o-1'], { units: [reselected] }))).toThrow();
    expect(() =>
      decodeTaxDecisionUnit({
        ...unit,
        taxClassification: { ...unit.taxClassification, catalogSelection: otherSelection },
      }),
    ).toThrow();
    const { taxClassification: _classification, ...withoutClassification } = unit;
    expect(() => decodeTaxDecisionUnit(withoutClassification)).toThrow();
    expect(() => decodeTaxDecisionUnit({ ...unit, jurisdiction: 'CZ_DOMESTIC' })).toThrow();
    expect(() =>
      decodeTaxDecisionUnit({
        ...unit,
        jurisdiction: {
          jurisdiction: 'CZ_DOMESTIC',
          placeEvidenceRefs: { deliveryDestination: 'delivery-destination-evidence-1' },
        },
      }),
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

  it('Unit 10 A2 A4 a non-payer unit decodes without rate, classification or governing rule', () => {
    const decision = decodeTaxDecision(nonPayerTaxDecisionInput(['o-1']));

    expect(decision.sellerVatRegime).toBe('NON_PAYER');
    expect(decision.units[0]).toMatchObject({
      governingReference: { legalBasis: { revision: 1 } },
      treatment: { _tag: 'SELLER_NOT_VAT_PAYER' },
    });
    expect(decision.units[0]).not.toHaveProperty('taxClassification');
    expect(decision.units[0]).not.toHaveProperty('governingTaxRuleRevisionRef');
  });

  it('Unit 10 A2 mixed treatments across one Decision are rejected', () => {
    expect(() =>
      decodeTaxDecision(
        taxDecisionInput(['o-1', 'o-2'], { units: [decisionUnitInput('o-1'), nonPayerDecisionUnitInput('o-2')] }),
      ),
    ).toThrow();
  });

  it('Unit 10 A2 a unit must match the Decision Seller VAT Regime', () => {
    // A taxable unit under a NON_PAYER Decision.
    expect(() => decodeTaxDecision(nonPayerTaxDecisionInput(['o-1'], { units: [decisionUnitInput('o-1')] }))).toThrow();
    // A non-payer unit under a VAT_PAYER Decision.
    expect(() => decodeTaxDecision(taxDecisionInput(['o-1'], { units: [nonPayerDecisionUnitInput('o-1')] }))).toThrow();
  });

  it('Unit 10 A4 F16 a non-payer unit carrying a different declaration revision than the Decision is rejected', () => {
    const base = nonPayerDecisionUnitInput('o-1');
    const otherRevision: typeof base = {
      ...base,
      governingReference: { ...base.governingReference, declarationRevisionRef: { revision: 2 } },
    };

    expect(() => decodeTaxDecision(nonPayerTaxDecisionInput(['o-1'], { units: [otherRevision] }))).toThrow();
  });

  it('Unit 10 A2 F14 a non-payer unit carrying a shipping component or allocation is rejected', () => {
    const base = nonPayerDecisionUnitInput('o-1');
    const withShippingComponent: typeof base = {
      ...base,
      taxableBasisInterpretation: {
        components: [
          ...base.taxableBasisInterpretation.components,
          { _tag: 'SHIPPING_ALLOCATION', amount: exactDecimal('10'), shippingSourceRef: shippingSourceRefInput },
        ],
      },
    };
    expect(() => decodeTaxDecision(nonPayerTaxDecisionInput(['o-1'], { units: [withShippingComponent] }))).toThrow();

    // A bound Shipping source with no allocation is accepted for NON_PAYER (shipping evidence is ignored, not an
    // error, Unit 10 A4, F14) but a VAT_PAYER Decision still requires the allocation to exist (#920 F32-F34).
    const nonPayerBoundShipping = nonPayerTaxDecisionInput(['o-1'], {
      purchaseBinding: purchaseBindingInput(['o-1'], { shippingSourceRef: shippingSourceRefInput }),
    });
    expect(() => decodeTaxDecision(nonPayerBoundShipping)).not.toThrow();
    const vatPayerBoundShipping = taxDecisionInput(['o-1'], {
      purchaseBinding: purchaseBindingInput(['o-1'], { shippingSourceRef: shippingSourceRefInput }),
    });
    expect(() => decodeTaxDecision(vatPayerBoundShipping)).toThrow();
  });
});
