import { Array as Arr, Option, Result, Schema, pipe } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { sumTaxExactRationals } from '../../src/domain/tax-exact-rational.ts';
import {
  ShippingAllocationInputSchema,
  ShippingAllocationSchema,
  allocateShippingTaxableBasis,
} from '../../src/domain/shipping-allocation.ts';
import { ShippingAllocationBasisSchema } from '../../src/domain/tax-decision.ts';
import { exactTaxContribution, finalizeTaxableSupplyUnitTax } from '../../src/domain/tax-rounding.ts';
import {
  decisionUnitInput,
  decodeTaxDecisionUnit,
  exactDecimal,
  roundingPolicy,
  shippingSourceRefInput,
} from './tax-domain-fixtures.ts';

const decodeInput = Schema.decodeUnknownSync(ShippingAllocationInputSchema);

type AllocationInput = typeof ShippingAllocationInputSchema.Encoded;
type ShippingBasisComponentInput = typeof ShippingAllocationBasisSchema.Encoded;
type WeightsInput = NonNullable<AllocationInput['allocationWeights']>;
type WeightEntry = readonly [string, string];

const current = (amount: string, currency = 'CZK'): AllocationInput['shippingSource'] => ({
  _tag: 'CURRENT',
  amount: { amount: exactDecimal(amount), currency },
  shippingSourceRef: shippingSourceRefInput,
});
const weights = (entries: readonly [WeightEntry, ...WeightEntry[]]): WeightsInput => ({
  approvalEvidenceRef: 'owner-approved-allocation-key-1',
  weights: pipe(
    entries,
    Arr.map(([taxableSupplyUnitId, weight]) => ({ taxableSupplyUnitId, weight: exactDecimal(weight) })),
  ),
});
const allocate = (input: AllocationInput) => allocateShippingTaxableBasis(decodeInput(input));
const amounts = (input: AllocationInput) =>
  Result.getOrThrow(allocate(input)).unitAllocations.map(({ basisComponent, taxableSupplyUnitId }) => [
    taxableSupplyUnitId,
    basisComponent.amount,
  ]);
const indeterminate = Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' });
const unitWith = (occurrenceId: string, ratePercent: string, shipping: ShippingBasisComponentInput) => {
  const input = decisionUnitInput(occurrenceId, '0.00', ratePercent);
  return decodeTaxDecisionUnit({
    ...input,
    taxableBasisInterpretation: { components: [...input.taxableBasisInterpretation.components, shipping] },
  });
};
const conservedPart = (taxableSupplyUnitId: string, revision = 1) => ({
  basisComponent: {
    _tag: 'SHIPPING_ALLOCATION',
    allocationWeightsEvidenceRef: 'owner-approved-allocation-key-1',
    amount: exactDecimal('0.33'),
    shippingSourceRef: { ...shippingSourceRefInput, revision },
  },
  taxableSupplyUnitId,
});

describe('Shipping Taxable Basis allocation', () => {
  it('#933 F4 F14 BDD one affected unit receives the whole unchanged 120.00 CZK owner-issued amount', () => {
    const allocation = Result.getOrThrow(
      allocate({ affectedTaxableSupplyUnitIds: ['u-1'], shippingSource: current('120.00') }),
    );

    expect(allocation.ownerIssuedShippingAmount).toEqual(exactDecimal('120.00'));
    expect(allocation.unitAllocations).toEqual([
      {
        basisComponent: {
          _tag: 'SHIPPING_ALLOCATION',
          amount: exactDecimal('120.00'),
          shippingSourceRef: shippingSourceRefInput,
        },
        taxableSupplyUnitId: 'u-1',
      },
    ]);
  });

  it('#962 PO #933 F21 #935 F13-F14 allocates 1 CZK at 1:6 exactly as 1/7 + 6/7 with no intermediate rounding', () => {
    const allocation = Result.getOrThrow(
      allocate({
        affectedTaxableSupplyUnitIds: ['u-1', 'u-2'],
        allocationWeights: weights([
          ['u-1', '1'],
          ['u-2', '6'],
        ]),
        shippingSource: current('1.00'),
      }),
    );
    const [first, second] = allocation.unitAllocations;

    expect(first?.basisComponent.amount).toEqual({ denominator: '7', numerator: '1' });
    expect(second?.basisComponent.amount).toEqual({ denominator: '7', numerator: '6' });
    expect(
      sumTaxExactRationals(
        pipe(
          allocation.unitAllocations,
          Arr.map(({ basisComponent }) => basisComponent.amount),
        ),
      ),
    ).toEqual(exactDecimal('1'));
    for (const { basisComponent } of allocation.unitAllocations) {
      expect(basisComponent.allocationWeightsEvidenceRef).toBe('owner-approved-allocation-key-1');
      expect(basisComponent.shippingSourceRef).toEqual(shippingSourceRefInput);
    }
  });

  it('#933 F17-F20 #935 F16 BDD mixed-rate allocations keep each unit treatment and round only per unit', () => {
    const { unitAllocations } = Result.getOrThrow(
      allocate({
        affectedTaxableSupplyUnitIds: ['taxable-supply-unit:o-1', 'taxable-supply-unit:o-2'],
        allocationWeights: weights([
          ['taxable-supply-unit:o-1', '1'],
          ['taxable-supply-unit:o-2', '6'],
        ]),
        shippingSource: current('1.00'),
      }),
    );
    const allocationAt = (index: number) => Option.getOrThrow(Arr.get(unitAllocations, index)).basisComponent;
    const encode = Schema.encodeSync(ShippingAllocationBasisSchema);
    const standard = unitWith('o-1', '21', encode(allocationAt(0)));
    const reduced = unitWith('o-2', '12', encode(allocationAt(1)));

    expect(exactTaxContribution(standard.taxableBasisInterpretation, standard.treatment)).toEqual(
      Option.some({ denominator: '100', numerator: '3' }),
    );
    expect(exactTaxContribution(reduced.taxableBasisInterpretation, reduced.treatment)).toEqual(
      Option.some({ denominator: '175', numerator: '18' }),
    );
    expect(Option.getOrThrow(finalizeTaxableSupplyUnitTax(reduced, roundingPolicy)).publishedTaxAmount.amount).toBe(
      '0.10',
    );
  });

  it('#933 F18 BDD unequal owner-approved weights are applied instead of an equal split', () => {
    expect(
      amounts({
        affectedTaxableSupplyUnitIds: ['u-1', 'u-2'],
        allocationWeights: weights([
          ['u-1', '100.00'],
          ['u-2', '300.00'],
        ]),
        shippingSource: current('120.00'),
      }),
    ).toEqual([
      ['u-1', exactDecimal('30')],
      ['u-2', exactDecimal('90')],
    ]);
  });

  it('#933 F24 #907 F91 F93 PO D3 without usable owner-approved weights there is no guessed allocation', () => {
    const affectedTaxableSupplyUnitIds = ['u-1', 'u-2'] as const;

    expect(allocate({ affectedTaxableSupplyUnitIds, shippingSource: current('120.00') })).toEqual(indeterminate);
    expect(
      allocate({
        affectedTaxableSupplyUnitIds,
        allocationWeights: weights([['u-1', '1']]),
        shippingSource: current('1.00'),
      }),
    ).toEqual(indeterminate);
    expect(
      allocate({
        affectedTaxableSupplyUnitIds,
        allocationWeights: weights([
          ['u-1', '0'],
          ['u-2', '0'],
        ]),
        shippingSource: current('1.00'),
      }),
    ).toEqual(indeterminate);
  });

  it('#933 F8-F10 #962 F33 stale or unavailable Shipping is never zero Shipping', () => {
    const affectedTaxableSupplyUnitIds = ['u-1'] as const;

    expect(
      allocate({ affectedTaxableSupplyUnitIds, shippingSource: { _tag: 'NOT_ESTABLISHED', state: 'STALE' } }),
    ).toEqual(Result.fail({ _tag: 'TAX_INPUT_STALE' }));
    expect(
      allocate({ affectedTaxableSupplyUnitIds, shippingSource: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' } }),
    ).toEqual(Result.fail({ _tag: 'TAX_DEPENDENCY_UNAVAILABLE' }));
  });

  it('#962 F32 #933 G authoritative zero Shipping stays zero for every affected unit', () => {
    expect(amounts({ affectedTaxableSupplyUnitIds: ['u-1', 'u-2'], shippingSource: current('0.00') })).toEqual([
      ['u-1', exactDecimal('0')],
      ['u-2', exactDecimal('0')],
    ]);
  });

  it('#933 F11 #931 F16 a non-CZK Shipping amount is never relabelled', () => {
    expect(allocate({ affectedTaxableSupplyUnitIds: ['u-1'], shippingSource: current('5.00', 'EUR') })).toEqual(
      Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'NON_CZK_CURRENCY' }),
    );
  });

  it('#933 F21-F22 #931 F20-F21 rejects an allocation that does not conserve the owner-issued amount', () => {
    const decodeAllocation = Schema.decodeUnknownSync(ShippingAllocationSchema);
    expect(() =>
      decodeAllocation({
        ownerIssuedShippingAmount: exactDecimal('0.67'),
        unitAllocations: [conservedPart('u-1'), conservedPart('u-2')],
      }),
    ).toThrow();
    expect(
      decodeAllocation({
        ownerIssuedShippingAmount: exactDecimal('0.66'),
        unitAllocations: [conservedPart('u-1'), conservedPart('u-2')],
      }),
    ).toBeDefined();
  });

  it('#920 F33 #933 F19 every allocation keeps the same exact Shipping source attribution', () => {
    expect(() =>
      Schema.decodeUnknownSync(ShippingAllocationSchema)({
        ownerIssuedShippingAmount: exactDecimal('0.66'),
        unitAllocations: [conservedPart('u-1'), conservedPart('u-2', 2)],
      }),
    ).toThrow();
  });

  it('#932 F18-F20 BDD a Pricing Fee stays inside the line and Shipping is a separate component, each counted once', () => {
    const shipping = Result.getOrThrow(
      allocate({ affectedTaxableSupplyUnitIds: ['taxable-supply-unit:o-1'], shippingSource: current('50.00') }),
    );
    const input = decisionUnitInput('o-1', '104.00', '21');
    const unit = decodeTaxDecisionUnit({
      ...input,
      taxableBasisInterpretation: {
        components: [
          ...input.taxableBasisInterpretation.components,
          ...shipping.unitAllocations.map(({ basisComponent }) => basisComponent),
        ],
      },
    });

    const [line, shippingComponent] = unit.taxableBasisInterpretation.components;
    expect(unit.taxableBasisInterpretation.components).toHaveLength(2);
    expect(line.amount).toEqual(exactDecimal('104.00'));
    expect(Schema.is(ShippingAllocationBasisSchema)(shippingComponent)).toBe(true);
    expect(exactTaxContribution(unit.taxableBasisInterpretation, unit.treatment)).toEqual(
      Option.some(exactDecimal('32.34')),
    );
  });
});
