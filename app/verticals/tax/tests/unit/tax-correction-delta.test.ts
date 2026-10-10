import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { AcceptedTaxTerms } from '../../src/domain/accepted-tax-terms.ts';
import { AuthoritativeOriginalAcceptedRecordSchema } from '../../shared/domain/tax-kernel/accepted-tax-terms.ts';
import {
  CumulativeUnitTaxStateSchema,
  TaxCorrectionDeltaSchema,
  TaxCorrectionHistoricalInputUnresolvedSchema,
  TaxCorrectionOutOfBoundsSchema,
  TaxCorrectionRequestSchema,
  calculateTaxCorrectionDelta,
} from '../../src/domain/tax-correction-delta.ts';
import type {
  AcceptedCumulativeCorrectionState,
  TaxCorrectionChange,
  TaxCorrectionDelta,
  TaxCorrectionOutcome,
  TaxCorrectionUnitRequest,
} from '../../src/domain/tax-correction-delta.ts';
import {
  TaxCorrectionChangeSchema,
  TaxCorrectionUnitDeltaSchema,
} from '../../shared/domain/tax-kernel/tax-correction-delta.ts';
import { TAX_HISTORICAL_INPUT_UNRESOLVED } from '../../shared/domain/tax-kernel/tax-historical-input-outcome.ts';
import { DeclaredTaxPurposeOutcomeSchema } from '../../shared/domain/tax-kernel/tax-declared-purpose.ts';
import { TaxNonSuccessOutcomeSchema } from '../../src/domain/tax-non-success-outcome.ts';
import { SellerNotVatPayerTreatmentSchema, TaxableTreatmentSchema } from '../../src/domain/tax-treatment.ts';
import { allocateShippingTaxableBasis, grossLineValueWeight } from '../../src/domain/shipping-allocation.ts';
import { ShippingAllocationInputSchema } from '../../shared/domain/tax-kernel/shipping-allocation.ts';
import { LineCommercialValueBasisSchema } from '../../shared/domain/tax-kernel/taxable-basis.ts';
import {
  ZERO_TAX_EXACT_RATIONAL,
  subtractTaxExactRationals,
} from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { TaxExactRational } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import { acceptedTaxTerms, acceptedTaxTermsInput, unitIdOf } from './tax-correction-fixtures.ts';
import type { OriginalUnitInput } from './tax-correction-fixtures.ts';
import { exactDecimal, shippingSourceRefInput } from './tax-domain-fixtures.ts';

const decodeRequest = Schema.decodeUnknownSync(TaxCorrectionRequestSchema);
const decodeState = Schema.decodeUnknownSync(CumulativeUnitTaxStateSchema);
const isDelta = Schema.is(TaxCorrectionDeltaSchema);
const isUnresolved = Schema.is(TaxCorrectionHistoricalInputUnresolvedSchema);
const isOutOfBounds = Schema.is(TaxCorrectionOutOfBoundsSchema);
const isUnresolvedUnits = Schema.is(TaxCorrectionHistoricalInputUnresolvedSchema.fields.unresolved.members[2]);

const minorUnits = (amount: string) => BigInt(amount.replace('.', ''));
const sumOfDeltas = (steps: readonly { readonly taxCorrectionDelta: { readonly amount: string } }[]) =>
  steps.reduce((total, { taxCorrectionDelta }) => total + minorUnits(taxCorrectionDelta.amount), 0n);

const quantity = (amount: string): TaxCorrectionChange => ({ _tag: 'QUANTITY', quantityDelta: exactDecimal(amount) });
/**
 * B-stage default: a Line Commercial Value change defaults to NET, a Shipping Allocation change to GROSS — each
 * matching its fixture's recorded basis, so every existing payer test proves the identity conversion case.
 */
const value = (
  amount: string,
  basisComponent: 'LINE_COMMERCIAL_VALUE' | 'SHIPPING_ALLOCATION' = 'LINE_COMMERCIAL_VALUE',
  amountBasis: 'GROSS' | 'NET' = basisComponent === 'SHIPPING_ALLOCATION' ? 'GROSS' : 'NET',
): TaxCorrectionChange => ({
  _tag: 'VALUE',
  amountBasis,
  basisComponent,
  valueDelta: exactDecimal(amount),
});
/**
 * Full negation of an exact Shipping share, used to reverse a Shipping Allocation component exactly
 * (Stage A, H5): a quantity-only change would leave the allocated Shipping share behind (A-5).
 */
const fullReversal = (share: TaxExactRational): TaxCorrectionChange => ({
  _tag: 'VALUE',
  amountBasis: 'GROSS',
  basisComponent: 'SHIPPING_ALLOCATION',
  valueDelta: subtractTaxExactRationals(ZERO_TAX_EXACT_RATIONAL, share),
});
const NO_ACCEPTED_CORRECTION: AcceptedCumulativeCorrectionState = { _tag: 'NO_ACCEPTED_CORRECTION' };

const isSingleChange = Schema.is(TaxCorrectionChangeSchema);

const toChanges = (
  changes: TaxCorrectionChange | readonly [TaxCorrectionChange, ...TaxCorrectionChange[]],
): readonly [TaxCorrectionChange, ...TaxCorrectionChange[]] => (isSingleChange(changes) ? [changes] : changes);

const unitRequest = (
  occurrenceId: string,
  changes: TaxCorrectionChange | readonly [TaxCorrectionChange, ...TaxCorrectionChange[]],
  expectedPreviousState: AcceptedCumulativeCorrectionState = NO_ACCEPTED_CORRECTION,
): TaxCorrectionUnitRequest => ({
  changes: toChanges(changes),
  expectedPreviousState,
  taxableSupplyUnitId: unitIdOf(occurrenceId),
});

const correct = (
  terms: AcceptedTaxTerms,
  units: readonly [TaxCorrectionUnitRequest, ...TaxCorrectionUnitRequest[]],
): TaxCorrectionOutcome =>
  calculateTaxCorrectionDelta({
    acceptedTaxTerms: terms,
    correctionEventRef: 'return-1',
    correctionReason: 'CUSTOMER_RETURN',
    units,
  });

const deltaOf = (outcome: TaxCorrectionOutcome): TaxCorrectionDelta => {
  if (!isDelta(outcome)) {
    throw new Error('Expected a Tax Correction Delta');
  }
  return outcome;
};

/** Units reported by a non-success correction outcome; a delta or a whole-record problem reports none. */
const issuesOf = (outcome: TaxCorrectionOutcome): readonly object[] => {
  if (isOutOfBounds(outcome)) {
    return outcome.units;
  }
  return isUnresolved(outcome) && isUnresolvedUnits(outcome.unresolved) ? outcome.unresolved.units : [];
};

/** Billing accepts the proposed next state under a new version it alone assigns. */
const acceptedAs = (delta: TaxCorrectionDelta, stateVersion: string): AcceptedCumulativeCorrectionState => ({
  _tag: 'ACCEPTED',
  state: delta.units[0].proposedNext,
  stateVersion,
});

/** Applies quantity returns one after another, each against the previous Accepted state of the one unit. */
const returnInSteps = (terms: AcceptedTaxTerms, occurrenceId: string, steps: readonly string[]) => {
  let state: AcceptedCumulativeCorrectionState = NO_ACCEPTED_CORRECTION;
  return steps.map((step, index) => {
    const delta = deltaOf(correct(terms, [unitRequest(occurrenceId, quantity(`-${step}`), state)]));
    state = acceptedAs(delta, `v${index + 1}`);
    return delta.units[0];
  });
};

const exceeds = (reason: string) => [{ reason, taxableSupplyUnitId: unitIdOf('o-1') }];

const tenAt9999: OriginalUnitInput = { lineValue: '999.90', occurrenceId: 'o-1', quantity: '10' };

/** Stage A fixture (A-1...A-5): o-1 line 100.00 NET, quantity 2, shipping 10.00 GROSS, 21 %. Stored tax 22.74. */
const stageALineAndShippingTerms = () =>
  acceptedTaxTerms([{ lineValue: '100.00', occurrenceId: 'o-1', quantity: '2', shipping: '10.00' }]);

/** Stage A-3 request builder: no Accepted Tax Terms shipping, so only the `units` shape under test is relevant. */
const stageAEncodedRequest = (units: readonly unknown[]) => ({
  acceptedTaxTerms: acceptedTaxTermsInput([{ lineValue: '100.00', occurrenceId: 'o-1', quantity: '2' }]),
  correctionEventRef: 'return-1',
  correctionReason: 'CUSTOMER_RETURN',
  units,
});

const acceptedAfterSeven: AcceptedCumulativeCorrectionState = {
  _tag: 'ACCEPTED',
  state: decodeState({
    remainingLineBasis: exactDecimal('299.97'),
    remainingPublishedTax: { amount: '62.99', currency: 'CZK' },
    remainingQuantity: exactDecimal('3'),
    remainingShippingBasis: exactDecimal('0'),
  }),
  stateVersion: 'v1',
};

describe('Tax Correction Delta', () => {
  it('#948 F17-F23 cumulative partial returns 3, 3, 4 of 10 x 99.99 CZK at 21 % exhaust to exactly 0.00 CZK', () => {
    const terms = acceptedTaxTerms([tenAt9999]);
    expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('209.98');

    const steps = returnInSteps(terms, 'o-1', ['3', '3', '4']);

    expect(steps.map(({ proposedNext }) => proposedNext.remainingPublishedTax.amount)).toEqual([
      '146.99',
      '83.99',
      '0.00',
    ]);
    expect(steps.map(({ taxCorrectionDelta }) => taxCorrectionDelta.amount)).toEqual(['-62.99', '-63.00', '-83.99']);
    expect(steps.map(({ proposedNext }) => proposedNext.remainingLineBasis)).toEqual([
      exactDecimal('699.93'),
      exactDecimal('399.96'),
      exactDecimal('0'),
    ]);
    // Independently rounded negative sales would reverse 62.99 + 62.99 + 83.99 = 209.97, leaving 0.01 CZK (#948 F20).
    expect(sumOfDeltas(steps)).toBe(-20_998n);
  });

  it('#948 F19 F23 a full return without prior corrections reverses exactly the original published Tax', () => {
    const outcome = deltaOf(correct(acceptedTaxTerms([tenAt9999]), [unitRequest('o-1', quantity('-10'))]));

    expect(outcome.units[0].taxCorrectionDelta.amount).toBe('-209.98');
    expect(outcome.units[0].proposedNext.remainingPublishedTax.amount).toBe('0.00');
    expect(outcome.correctionTaxDelta.amount).toBe('-209.98');
  });

  it('#948 F22-F23 every partition of the original quantity sums to minus the original published Tax', () => {
    const terms = acceptedTaxTerms([{ lineValue: '93.59', occurrenceId: 'o-1', quantity: '7', ratePercent: '12' }]);
    const original = minorUnits(terms.finalTax.result.units[0].publishedTaxAmount.amount);
    for (const partition of [
      ['7'],
      ['1', '6'],
      ['2', '2', '3'],
      ['1', '1', '1', '1', '1', '1', '1'],
      ['5', '1', '1'],
      ['0.5', '6.5'],
    ]) {
      const steps = returnInSteps(terms, 'o-1', partition);
      expect(steps.at(-1)?.proposedNext.remainingPublishedTax.amount).toBe('0.00');
      expect(sumOfDeltas(steps)).toBe(-original);
    }
  });

  it('#948 F24 a partial correction keeps its exact remainder and is not forced to zero', () => {
    const [step] = returnInSteps(acceptedTaxTerms([tenAt9999]), 'o-1', ['9']);

    expect(step?.proposedNext.remainingQuantity).toEqual(exactDecimal('1'));
    expect(step?.proposedNext.remainingPublishedTax.amount).toBe('21.00');
    expect(step?.exactTaxContribution).toEqual(exactDecimal('20.9979'));
    expect(step?.taxRoundingAdjustment).toEqual(exactDecimal('0.0021'));
  });

  it('#948 F21 F24 #907 F189 correcting one unit never moves Tax or a rounding remainder to another unit', () => {
    const terms = acceptedTaxTerms([
      { lineValue: '99.99', occurrenceId: 'o-1', quantity: '3' },
      { lineValue: '99.99', occurrenceId: 'o-2', quantity: '3' },
    ]);

    const outcome = deltaOf(correct(terms, [unitRequest('o-1', quantity('-1'))]));

    expect(outcome.units.map(({ taxableSupplyUnitId }) => taxableSupplyUnitId)).toEqual([unitIdOf('o-1')]);
    expect(outcome.units[0].taxCorrectionDelta.amount).toBe('-7.00');
    expect(outcome.correctionTaxDelta.amount).toBe('-7.00');
  });

  it('#948 F8 F25 a quantity return leaves the allocated Shipping share; only an explicit value change reverses it', () => {
    // PO decision D3 on #907: the Shipping share is always GROSS, so its VAT is carved out under § 37 písm. b):
    // 100 NET @ 21 % gives 21 exactly; 10 GROSS @ 21 % gives 210/121 = 1.7355... -> total 22.7355... -> 22.74.
    const terms = acceptedTaxTerms([{ lineValue: '100.00', occurrenceId: 'o-1', quantity: '2', shipping: '10.00' }]);
    expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('22.74');

    const goods = deltaOf(correct(terms, [unitRequest('o-1', quantity('-2'))]));
    expect(goods.units[0].proposedNext.remainingLineBasis).toEqual(exactDecimal('0'));
    expect(goods.units[0].proposedNext.remainingShippingBasis).toEqual(exactDecimal('10'));
    expect(goods.units[0].proposedNext.remainingQuantity).toEqual(exactDecimal('0'));
    expect(goods.units[0].taxCorrectionDelta.amount).toBe('-21.00');

    const shipping = deltaOf(
      correct(terms, [unitRequest('o-1', value('-10', 'SHIPPING_ALLOCATION'), acceptedAs(goods, 'v1'))]),
    );
    expect(shipping.units[0].proposedNext.remainingPublishedTax.amount).toBe('0.00');
    expect(shipping.units[0].taxCorrectionDelta.amount).toBe('-1.74');
  });

  it('PO decision D3 on #907: a GROSS original quantity row corrects consistently with its own basis', () => {
    // 3 x 9.99 GROSS @ 21 % publishes 5.20 (D3-3); returning 2 leaves 1 x 9.99 GROSS -> 1.73; a full return -> 0.00.
    const terms = acceptedTaxTerms([{ amountBasis: 'GROSS', lineValue: '29.97', occurrenceId: 'o-1', quantity: '3' }]);
    expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('5.20');

    const partial = deltaOf(correct(terms, [unitRequest('o-1', quantity('-2'))]));
    expect(partial.units[0].proposedNext.remainingPublishedTax.amount).toBe('1.73');
    expect(partial.units[0].taxCorrectionDelta.amount).toBe('-3.47');

    const full = deltaOf(correct(terms, [unitRequest('o-1', quantity('-3'))]));
    expect(full.units[0].proposedNext.remainingPublishedTax.amount).toBe('0.00');
    expect(full.units[0].taxCorrectionDelta.amount).toBe('-5.20');
  });

  it('#948 F10 a value correction without a quantity change keeps the accepted quantity', () => {
    const outcome = deltaOf(correct(acceptedTaxTerms([tenAt9999]), [unitRequest('o-1', value('-99.99'))]));

    expect(outcome.units[0].proposedNext.remainingQuantity).toEqual(exactDecimal('10'));
    expect(outcome.units[0].proposedNext.remainingPublishedTax.amount).toBe('188.98');
    expect(outcome.units[0].taxCorrectionDelta.amount).toBe('-21.00');
  });

  it('#948 F16 already corrected quantity or basis is not consumed twice and nothing is clamped', () => {
    const terms = acceptedTaxTerms([tenAt9999]);

    for (const outcome of [
      correct(terms, [unitRequest('o-1', quantity('-4'), acceptedAfterSeven)]),
      correct(terms, [unitRequest('o-1', quantity('-11'))]),
    ]) {
      expect(isOutOfBounds(outcome)).toBe(true);
      expect(issuesOf(outcome)).toEqual(exceeds('EXCEEDS_REMAINING_QUANTITY'));
    }
    for (const outcome of [
      correct(terms, [unitRequest('o-1', value('-1000'))]),
      correct(terms, [unitRequest('o-1', value('-300'), acceptedAfterSeven)]),
      correct(terms, [unitRequest('o-1', value('-0.01', 'SHIPPING_ALLOCATION'))]),
    ]) {
      expect(isOutOfBounds(outcome)).toBe(true);
      expect(issuesOf(outcome)).toEqual(exceeds('EXCEEDS_REMAINING_BASIS_COMPONENT'));
    }
    expect(isDelta(correct(terms, [unitRequest('o-1', quantity('-3'), acceptedAfterSeven)]))).toBe(true);
  });

  it('#948 F22 G a value correction followed by returns still exhausts the unit to exactly 0.00 CZK', () => {
    const terms = acceptedTaxTerms([tenAt9999]);
    const discounted = deltaOf(correct(terms, [unitRequest('o-1', value('-99.99'))]));
    const returned = deltaOf(correct(terms, [unitRequest('o-1', quantity('-10'), acceptedAs(discounted, 'v1'))]));

    expect(discounted.units[0].proposedNext.remainingPublishedTax.amount).toBe('188.98');
    expect(returned.units[0].proposedNext).toEqual({
      remainingLineBasis: exactDecimal('0'),
      remainingPublishedTax: { amount: '0.00', currency: 'CZK' },
      remainingQuantity: exactDecimal('0'),
      remainingShippingBasis: exactDecimal('0'),
    });
    expect(sumOfDeltas([...discounted.units, ...returned.units])).toBe(-20_998n);
  });

  it('#948 F20-F25 mixed quantity, line-value and Shipping reductions always exhaust to minus the original Tax', () => {
    const terms = acceptedTaxTerms([
      { lineValue: '93.59', occurrenceId: 'o-1', quantity: '7', ratePercent: '12', shipping: '12.34' },
    ]);
    const original = minorUnits(terms.finalTax.result.units[0].publishedTaxAmount.amount);
    const paths: readonly (readonly TaxCorrectionChange[])[] = [
      [quantity('-7'), value('-12.34', 'SHIPPING_ALLOCATION')],
      [value('-12.34', 'SHIPPING_ALLOCATION'), quantity('-7')],
      [
        value('-10'),
        quantity('-2'),
        value('-2.34', 'SHIPPING_ALLOCATION'),
        quantity('-5'),
        value('-10', 'SHIPPING_ALLOCATION'),
      ],
      [quantity('-1'), value('-0.01'), quantity('-3'), value('-12.34', 'SHIPPING_ALLOCATION'), quantity('-3')],
      [value('-93.59'), quantity('-7'), value('-12.34', 'SHIPPING_ALLOCATION')],
      [
        quantity('-0.5'),
        value('-3.33'),
        quantity('-6.5'),
        value('-6', 'SHIPPING_ALLOCATION'),
        value('-6.34', 'SHIPPING_ALLOCATION'),
      ],
    ];
    for (const path of paths) {
      let state: AcceptedCumulativeCorrectionState = NO_ACCEPTED_CORRECTION;
      const steps = path.map((change, index) => {
        const delta = deltaOf(correct(terms, [unitRequest('o-1', change, state)]));
        state = acceptedAs(delta, `v${index + 1}`);
        return delta.units[0];
      });
      expect(steps.at(-1)?.proposedNext.remainingPublishedTax.amount).toBe('0.00');
      expect(sumOfDeltas(steps)).toBe(-original);
    }
  });

  it('#947 F13 #948 F7 a unit outside the original record is an explicit unresolved historical input, never zero', () => {
    const outcome = correct(acceptedTaxTerms([tenAt9999]), [
      unitRequest('o-1', quantity('-11')),
      unitRequest('o-unknown', quantity('-1')),
    ]);

    expect(isUnresolved(outcome)).toBe(true);
    expect(issuesOf(outcome)).toEqual([
      { reason: 'UNIT_NOT_IN_ORIGINAL_RECORD', taxableSupplyUnitId: unitIdOf('o-unknown') },
    ]);
  });

  it('#947 F13-F14 an Accepted state that cannot follow from the original record is unresolved, not repaired', () => {
    const terms = acceptedTaxTerms([tenAt9999]);
    const forged = (
      state: Partial<{ remainingLineBasis: string; remainingPublishedTax: string; remainingQuantity: string }>,
    ) =>
      correct(terms, [
        unitRequest('o-1', quantity('-1'), {
          _tag: 'ACCEPTED',
          state: decodeState({
            remainingLineBasis: exactDecimal(state.remainingLineBasis ?? '699.93'),
            remainingPublishedTax: { amount: state.remainingPublishedTax ?? '146.99', currency: 'CZK' },
            remainingQuantity: exactDecimal(state.remainingQuantity ?? '7'),
            remainingShippingBasis: exactDecimal('0'),
          }),
          stateVersion: 'v1',
        }),
      ]);

    expect(isDelta(forged({}))).toBe(true);
    for (const state of [
      { remainingPublishedTax: '147.00' },
      { remainingQuantity: '11' },
      { remainingLineBasis: '1000', remainingPublishedTax: '210.00' },
      { remainingLineBasis: '10', remainingPublishedTax: '2.10', remainingQuantity: '0' },
      { remainingLineBasis: '999.90', remainingPublishedTax: '209.98', remainingQuantity: '1' },
    ]) {
      const outcome = forged(state);
      expect(isUnresolved(outcome)).toBe(true);
      expect(issuesOf(outcome)).toEqual([
        { reason: 'STATE_INCONSISTENT_WITH_ORIGINAL_RECORD', taxableSupplyUnitId: unitIdOf('o-1') },
      ]);
    }
  });

  it('#946 F16-F17 #948 F27 echoes the expected previous state version opaquely and consumes nothing', () => {
    const terms = acceptedTaxTerms([tenAt9999]);
    const expected = (stateVersion: string): AcceptedCumulativeCorrectionState => ({
      ...acceptedAfterSeven,
      stateVersion,
    });
    const at = (stateVersion: string) =>
      deltaOf(correct(terms, [unitRequest('o-1', quantity('-3'), expected(stateVersion))])).units[0];

    const first = at('billing-state-17');
    const other = at('opaque:any/version');

    expect(at('billing-state-17')).toEqual(first);
    expect(first.expectedPreviousState).toEqual(expected('billing-state-17'));
    expect(other.expectedPreviousState).toEqual(expected('opaque:any/version'));
    expect([other.previous, other.proposedNext, other.taxCorrectionDelta]).toEqual([
      first.previous,
      first.proposedNext,
      first.taxCorrectionDelta,
    ]);
  });

  it('is order-independent and binds the result to its original record, Decision and rounding policy', () => {
    const terms = acceptedTaxTerms([
      { lineValue: '10.01', occurrenceId: 'o-1', quantity: '1' },
      { lineValue: '20.02', occurrenceId: 'o-2', quantity: '2' },
    ]);
    const forward = correct(terms, [unitRequest('o-1', quantity('-1')), unitRequest('o-2', quantity('-1'))]);
    const reversed = correct(terms, [unitRequest('o-2', quantity('-1')), unitRequest('o-1', quantity('-1'))]);

    expect(reversed).toEqual(forward);
    const outcome = deltaOf(forward);
    // H10: the original record of a correction is the accepted Billing Document (the fixtures' default record).
    expect(Schema.is(AuthoritativeOriginalAcceptedRecordSchema.members[1])(outcome.originalRecord)).toBe(true);
    expect(outcome.originalRecord.billingDocumentRef).toBe('invoice-1');
    expect(outcome.originalOrderLineage).toEqual(terms.orderLineage);
    expect(outcome.originalTaxDecisionId).toBe(terms.finalTax.decision.decisionId);
    expect(outcome.taxRoundingPolicy).toEqual(terms.finalTax.result.taxRoundingPolicy);
    expect(outcome.correctionEventRef).toBe('return-1');
    expect(outcome.correctionReason).toBe('CUSTOMER_RETURN');
    expect(outcome.correctionTaxDelta.amount).toBe('-4.20');
    // C-4: a forged delta claiming the Order Snapshot as its original record fails to decode.
    expect(() =>
      Schema.decodeUnknownSync(TaxCorrectionDeltaSchema)({ ...outcome, originalRecord: { _tag: 'ORDER_SNAPSHOT' } }),
    ).toThrow();
  });

  describe('Stage C: H10 baseline (#945-#948)', () => {
    it('C-1 a correction request whose Terms are the Order Snapshot fails to decode (H10)', () => {
      const request = {
        acceptedTaxTerms: acceptedTaxTermsInput([tenAt9999], [tenAt9999], { _tag: 'ORDER_SNAPSHOT' }),
        correctionEventRef: 'return-1',
        correctionReason: 'CUSTOMER_RETURN',
        units: [unitRequest('o-1', quantity('-1'))],
      };

      expect(() => decodeRequest(request)).toThrow(/accepted Billing Document/u);
    });
  });

  it('#948 F9-F16 #948 E accepts only reductions, each original unit once per correction', () => {
    const request = (units: readonly TaxCorrectionUnitRequest[]) => ({
      acceptedTaxTerms: acceptedTaxTermsInput([tenAt9999]),
      correctionEventRef: 'return-1',
      correctionReason: 'CUSTOMER_RETURN',
      units,
    });

    expect(decodeRequest(request([unitRequest('o-1', quantity('-1'))])).units).toHaveLength(1);
    expect(() => decodeRequest(request([unitRequest('o-1', quantity('0'))]))).toThrow();
    expect(() => decodeRequest(request([unitRequest('o-1', quantity('1'))]))).toThrow();
    expect(() => decodeRequest(request([unitRequest('o-1', value('99.99'))]))).toThrow();
    // Two unitRequest entries for the same unit are still rejected: each original unit appears once.
    expect(() =>
      decodeRequest(request([unitRequest('o-1', quantity('-1')), unitRequest('o-1', value('-1'))])),
    ).toThrow();
    // A-6 (the flip): a quantity change and a shipping change for the same unit, in one correction, now decode.
    expect(
      decodeRequest(request([unitRequest('o-1', [quantity('-1'), value('-1', 'SHIPPING_ALLOCATION')])])).units,
    ).toHaveLength(1);
  });

  describe('Stage A: combined goods + shipping change per unit (H5)', () => {
    it('A-1 a combined full goods and shipping reversal in one correction exhausts the unit exactly', () => {
      const terms = stageALineAndShippingTerms();
      expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('22.74');

      const outcome = deltaOf(
        correct(terms, [unitRequest('o-1', [quantity('-2'), value('-10', 'SHIPPING_ALLOCATION')])]),
      );

      expect(outcome.units[0].proposedNext).toEqual({
        remainingLineBasis: exactDecimal('0'),
        remainingPublishedTax: { amount: '0.00', currency: 'CZK' },
        remainingQuantity: exactDecimal('0'),
        remainingShippingBasis: exactDecimal('0'),
      });
      expect(outcome.units[0].taxCorrectionDelta.amount).toBe('-22.74');
    });

    it('A-2 a combined partial goods and shipping reduction is order-independent', () => {
      const terms = stageALineAndShippingTerms();
      for (const changes of [
        [quantity('-1'), value('-4.00', 'SHIPPING_ALLOCATION')],
        [value('-4.00', 'SHIPPING_ALLOCATION'), quantity('-1')],
      ] as const) {
        const outcome = deltaOf(correct(terms, [unitRequest('o-1', changes)]));
        expect(outcome.units[0].proposedNext.remainingLineBasis).toEqual(exactDecimal('50'));
        expect(outcome.units[0].proposedNext.remainingShippingBasis).toEqual(exactDecimal('6'));
        expect(outcome.units[0].proposedNext.remainingPublishedTax.amount).toBe('11.54');
        expect(outcome.units[0].taxCorrectionDelta.amount).toBe('-11.20');
      }
    });

    it('A-3 two goods changes, two shipping changes, an empty array, and the same unit twice all fail to decode', () => {
      expect(() =>
        decodeRequest(
          stageAEncodedRequest([
            {
              changes: [quantity('-1'), value('-1')],
              expectedPreviousState: NO_ACCEPTED_CORRECTION,
              taxableSupplyUnitId: unitIdOf('o-1'),
            },
          ]),
        ),
      ).toThrow();
      expect(() =>
        decodeRequest(
          stageAEncodedRequest([
            {
              changes: [value('-1', 'SHIPPING_ALLOCATION'), value('-2', 'SHIPPING_ALLOCATION')],
              expectedPreviousState: NO_ACCEPTED_CORRECTION,
              taxableSupplyUnitId: unitIdOf('o-1'),
            },
          ]),
        ),
      ).toThrow();
      expect(() =>
        decodeRequest(
          stageAEncodedRequest([
            { changes: [], expectedPreviousState: NO_ACCEPTED_CORRECTION, taxableSupplyUnitId: unitIdOf('o-1') },
          ]),
        ),
      ).toThrow();
      expect(() =>
        decodeRequest(stageAEncodedRequest([unitRequest('o-1', quantity('-1')), unitRequest('o-1', quantity('-1'))])),
      ).toThrow();
    });

    it('A-4 a combined change reports every out-of-bounds component, sorted, and clamps nothing', () => {
      const terms = stageALineAndShippingTerms();

      const outcome = correct(terms, [unitRequest('o-1', [quantity('-3'), value('-11', 'SHIPPING_ALLOCATION')])]);

      expect(isOutOfBounds(outcome)).toBe(true);
      expect(issuesOf(outcome)).toEqual([
        { reason: 'EXCEEDS_REMAINING_BASIS_COMPONENT', taxableSupplyUnitId: unitIdOf('o-1') },
        { reason: 'EXCEEDS_REMAINING_QUANTITY', taxableSupplyUnitId: unitIdOf('o-1') },
      ]);
    });

    it('A-5 a quantity-only change never derives a Shipping refund ("never 1/quantity")', () => {
      const terms = stageALineAndShippingTerms();

      const outcome = deltaOf(correct(terms, [unitRequest('o-1', quantity('-1'))]));

      expect(outcome.units[0].proposedNext.remainingShippingBasis).toEqual(exactDecimal('10'));
      expect(outcome.units[0].proposedNext.remainingPublishedTax.amount).toBe('12.24');
      expect(outcome.units[0].taxCorrectionDelta.amount).toBe('-10.50');
      // The 1/quantity variant (shipping halved to 5) would give tax 11.37 and delta -11.37; that must not happen.
      expect(outcome.units[0].proposedNext.remainingPublishedTax.amount).not.toBe('11.37');
    });
  });

  describe('Stage B: treatment-aware baseline, full reversal, value-change amount basis', () => {
    it('B-1 a SELLER_NOT_VAT_PAYER unit corrects to zero Tax at every step, echoing its treatment', () => {
      const terms = acceptedTaxTerms([{ lineValue: '200.00', nonPayer: true, occurrenceId: 'o-1', quantity: '2' }]);
      expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('0.00');

      const outcome = deltaOf(correct(terms, [unitRequest('o-1', quantity('-2'))]));

      expect(Schema.is(SellerNotVatPayerTreatmentSchema)(outcome.units[0].treatment)).toBe(true);
      expect(outcome.units[0].taxCorrectionDelta.amount).toBe('0.00');
      expect(outcome.units[0].exactTaxContribution).toEqual(exactDecimal('0'));
      expect(outcome.units[0].taxRoundingAdjustment).toEqual(exactDecimal('0'));
      expect(outcome.units[0].proposedNext).toEqual({
        remainingLineBasis: exactDecimal('0'),
        remainingPublishedTax: { amount: '0.00', currency: 'CZK' },
        remainingQuantity: exactDecimal('0'),
        remainingShippingBasis: exactDecimal('0'),
      });
    });

    it('B-2 a SELLER_NOT_VAT_PAYER unit: a GROSS value change is the identity, since no VAT is carved out', () => {
      const terms = acceptedTaxTerms([{ lineValue: '200.00', nonPayer: true, occurrenceId: 'o-1', quantity: '2' }]);

      const afterQuantity = deltaOf(correct(terms, [unitRequest('o-1', quantity('-1'))]));
      expect(afterQuantity.units[0].taxCorrectionDelta.amount).toBe('0.00');
      expect(afterQuantity.units[0].proposedNext.remainingLineBasis).toEqual(exactDecimal('100'));

      // A later value change against the accepted state (not fresh Terms) still converts via amountInBasis, which
      // is the identity for a non-payer treatment regardless of the change's own amountBasis; this exercises
      // `followsFromOriginalRecord` against a non-payer ACCEPTED state with its 0.00 rate-free baseline.
      const afterValue = deltaOf(
        correct(terms, [
          unitRequest('o-1', value('-30', 'LINE_COMMERCIAL_VALUE', 'GROSS'), acceptedAs(afterQuantity, 'v1')),
        ]),
      );
      expect(afterValue.units[0].proposedNext.remainingLineBasis).toEqual(exactDecimal('70'));
      expect(afterValue.units[0].taxCorrectionDelta.amount).toBe('0.00');
    });

    it('B-4 a SELLER_NOT_VAT_PAYER ACCEPTED state that cannot follow from the original record is unresolved', () => {
      const terms = acceptedTaxTerms([{ lineValue: '200.00', nonPayer: true, occurrenceId: 'o-1', quantity: '2' }]);
      const forged: AcceptedCumulativeCorrectionState = {
        _tag: 'ACCEPTED',
        state: decodeState({
          remainingLineBasis: exactDecimal('100'),
          remainingPublishedTax: { amount: '0.01', currency: 'CZK' },
          remainingQuantity: exactDecimal('1'),
          remainingShippingBasis: exactDecimal('0'),
        }),
        stateVersion: 'v1',
      };

      const outcome = correct(terms, [unitRequest('o-1', quantity('-1'), forged)]);

      expect(isUnresolved(outcome)).toBe(true);
      expect(issuesOf(outcome)).toEqual([
        { reason: 'STATE_INCONSISTENT_WITH_ORIGINAL_RECORD', taxableSupplyUnitId: unitIdOf('o-1') },
      ]);
    });

    it('B-5 a SELLER_NOT_VAT_PAYER unit carries no Shipping basis: a Shipping value change is out of bounds', () => {
      const terms = acceptedTaxTerms([{ lineValue: '200.00', nonPayer: true, occurrenceId: 'o-1', quantity: '2' }]);

      const outcome = correct(terms, [unitRequest('o-1', value('-10', 'SHIPPING_ALLOCATION'))]);

      expect(isOutOfBounds(outcome)).toBe(true);
      expect(issuesOf(outcome)).toEqual(exceeds('EXCEEDS_REMAINING_BASIS_COMPONENT'));
    });

    it('B-6 decode enforces both the non-payer and the full-reversal contract invariants', () => {
      const decodeUnitDelta = Schema.decodeUnknownSync(TaxCorrectionUnitDeltaSchema);

      // A real A-1 (payer, full reversal) and B-1 (non-payer) output must positively decode as-is.
      const {
        units: [a1],
      } = deltaOf(
        correct(stageALineAndShippingTerms(), [
          unitRequest('o-1', [quantity('-2'), value('-10', 'SHIPPING_ALLOCATION')]),
        ]),
      );
      expect(() => decodeUnitDelta(a1)).not.toThrow();

      const nonPayerTerms = acceptedTaxTerms([
        { lineValue: '200.00', nonPayer: true, occurrenceId: 'o-1', quantity: '2' },
      ]);
      const {
        units: [b1],
      } = deltaOf(correct(nonPayerTerms, [unitRequest('o-1', quantity('-2'))]));
      expect(() => decodeUnitDelta(b1)).not.toThrow();

      // (1) a forged non-payer unit delta with a non-zero taxCorrectionDelta must throw (SELLER_NOT_VAT_PAYER
      // consequence: contribution, adjustment, delta and both remaining published Tax amounts are all zero).
      expect(() => decodeUnitDelta({ ...b1, taxCorrectionDelta: { amount: '-0.01', currency: 'CZK' } })).toThrow();

      // (1b) the treatment-consequence invariant is distinct from the full-reversal invariant: b1 is a full
      // reversal (QUANTITY -2 leaves nothing remaining), so taxCorrectionDelta -0.01 there is also caught by the
      // full-reversal filter alone. Forge instead from B-2's *partial* non-payer delta (QUANTITY -1, remaining
      // quantity 1, remaining line basis 100 — not a full reversal), so only the treatment filter can catch each
      // conjunct on its own.
      const partialNonPayerTerms = acceptedTaxTerms([
        { lineValue: '200.00', nonPayer: true, occurrenceId: 'o-1', quantity: '2' },
      ]);
      const {
        units: [b2],
      } = deltaOf(correct(partialNonPayerTerms, [unitRequest('o-1', quantity('-1'))]));
      expect(() => decodeUnitDelta(b2)).not.toThrow();

      expect(() => decodeUnitDelta({ ...b2, taxCorrectionDelta: { amount: '-0.01', currency: 'CZK' } })).toThrow();
      expect(() =>
        decodeUnitDelta({
          ...b2,
          proposedNext: { ...b2.proposedNext, remainingPublishedTax: { amount: '0.01', currency: 'CZK' } },
        }),
      ).toThrow();
      expect(() =>
        decodeUnitDelta({
          ...b2,
          previous: { ...b2.previous, remainingPublishedTax: { amount: '0.01', currency: 'CZK' } },
        }),
      ).toThrow();
      expect(() => decodeUnitDelta({ ...b2, exactTaxContribution: exactDecimal('1') })).toThrow();
      expect(() => decodeUnitDelta({ ...b2, taxRoundingAdjustment: exactDecimal('1') })).toThrow();

      // (2) a forged zero-remaining proposedNext whose remainingPublishedTax is not 0.00.
      expect(() =>
        decodeUnitDelta({
          ...a1,
          proposedNext: { ...a1.proposedNext, remainingPublishedTax: { amount: '0.01', currency: 'CZK' } },
        }),
      ).toThrow();

      // (3) a forged zero-remaining proposedNext whose delta is not the exact negation of the previous remaining
      // published Tax (a1's previous.remainingPublishedTax is 22.74, so the delta must be exactly -22.74).
      expect(() => decodeUnitDelta({ ...a1, taxCorrectionDelta: { amount: '-22.73', currency: 'CZK' } })).toThrow();
    });

    it('B-7 a GROSS value change against a NET line converts via the exact rate, both amount bases asserted', () => {
      const terms = acceptedTaxTerms([{ lineValue: '100.00', occurrenceId: 'o-1', quantity: '1' }]);
      expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('21.00');

      const gross = deltaOf(correct(terms, [unitRequest('o-1', value('-50.00', 'LINE_COMMERCIAL_VALUE', 'GROSS'))]));
      expect(gross.units[0].proposedNext.remainingLineBasis).toEqual({ denominator: '121', numerator: '7100' });
      expect(gross.units[0].proposedNext.remainingPublishedTax.amount).toBe('12.32');
      expect(gross.units[0].taxCorrectionDelta.amount).toBe('-8.68');

      const net = deltaOf(correct(terms, [unitRequest('o-1', value('-50.00', 'LINE_COMMERCIAL_VALUE', 'NET'))]));
      expect(net.units[0].proposedNext.remainingLineBasis).toEqual(exactDecimal('50'));
      expect(net.units[0].taxCorrectionDelta.amount).toBe('-10.50');
    });

    it('B-7g the GROSS sibling of B-7: a GROSS change is the identity, a NET change converts up', () => {
      const terms = acceptedTaxTerms([
        { amountBasis: 'GROSS', lineValue: '121.00', occurrenceId: 'o-1', quantity: '1' },
      ]);
      expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('21.00');

      const gross = deltaOf(correct(terms, [unitRequest('o-1', value('-50.00', 'LINE_COMMERCIAL_VALUE', 'GROSS'))]));
      expect(gross.units[0].proposedNext.remainingLineBasis).toEqual(exactDecimal('71'));
      expect(gross.units[0].proposedNext.remainingPublishedTax.amount).toBe('12.32');
      expect(gross.units[0].taxCorrectionDelta.amount).toBe('-8.68');

      const net = deltaOf(correct(terms, [unitRequest('o-1', value('-50.00', 'LINE_COMMERCIAL_VALUE', 'NET'))]));
      expect(net.units[0].proposedNext.remainingLineBasis).toEqual(exactDecimal('60.5'));
      expect(net.units[0].proposedNext.remainingPublishedTax.amount).toBe('10.50');
      expect(net.units[0].taxCorrectionDelta.amount).toBe('-10.50');
    });

    it('B-8 B-7 followed by a full reversal sums to minus the original published Tax', () => {
      const terms = acceptedTaxTerms([{ lineValue: '100.00', occurrenceId: 'o-1', quantity: '1' }]);
      const partial = deltaOf(correct(terms, [unitRequest('o-1', value('-50.00', 'LINE_COMMERCIAL_VALUE', 'GROSS'))]));
      expect(partial.units[0].taxCorrectionDelta.amount).toBe('-8.68');

      const reversed = deltaOf(correct(terms, [unitRequest('o-1', quantity('-1'), acceptedAs(partial, 'v1'))]));
      expect(reversed.units[0].taxCorrectionDelta.amount).toBe('-12.32');
      expect(reversed.units[0].proposedNext.remainingPublishedTax.amount).toBe('0.00');
      expect(sumOfDeltas([...partial.units, ...reversed.units])).toBe(-2100n);
    });

    it('B-9 LEGAL §2 tie 0.14/12 %: [VALUE LINE -0.14 GROSS] on a GROSS 0.28 line gives 0.03 -> 0.02 (-0.01), then -0.02', () => {
      const terms = acceptedTaxTerms([
        { amountBasis: 'GROSS', lineValue: '0.28', occurrenceId: 'o-1', quantity: '2', ratePercent: '12' },
      ]);
      expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('0.03');

      const afterValue = deltaOf(
        correct(terms, [unitRequest('o-1', value('-0.14', 'LINE_COMMERCIAL_VALUE', 'GROSS'))]),
      );
      expect(afterValue.units[0].proposedNext.remainingLineBasis).toEqual(exactDecimal('0.14'));
      expect(afterValue.units[0].proposedNext.remainingPublishedTax.amount).toBe('0.02');
      expect(afterValue.units[0].taxCorrectionDelta.amount).toBe('-0.01');

      const afterQuantity = deltaOf(correct(terms, [unitRequest('o-1', quantity('-2'), acceptedAs(afterValue, 'v1'))]));
      expect(afterQuantity.units[0].proposedNext.remainingPublishedTax.amount).toBe('0.00');
      expect(afterQuantity.units[0].taxCorrectionDelta.amount).toBe('-0.02');

      expect(
        [afterValue.units[0], afterQuantity.units[0]].map(({ taxCorrectionDelta }) => taxCorrectionDelta.amount),
      ).toEqual(['-0.01', '-0.02']);
      expect(sumOfDeltas([afterValue.units[0], afterQuantity.units[0]])).toBe(-3n);
    });

    it('B-9q the quantity-first guard of B-9: [QUANTITY -1] reaches the same 0.02 (-0.01), then -0.02', () => {
      const terms = acceptedTaxTerms([
        { amountBasis: 'GROSS', lineValue: '0.28', occurrenceId: 'o-1', quantity: '2', ratePercent: '12' },
      ]);
      expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('0.03');

      const steps = returnInSteps(terms, 'o-1', ['1', '1']);

      expect(steps.map(({ proposedNext }) => proposedNext.remainingPublishedTax.amount)).toEqual(['0.02', '0.00']);
      expect(steps.map(({ taxCorrectionDelta }) => taxCorrectionDelta.amount)).toEqual(['-0.01', '-0.02']);
    });

    it('B-10 the Unit 11 GROSS quantity row returned one at a time: -1.73, -1.74, -1.73', () => {
      const terms = acceptedTaxTerms([
        { amountBasis: 'GROSS', lineValue: '29.97', occurrenceId: 'o-1', quantity: '3' },
      ]);
      expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('5.20');

      const steps = returnInSteps(terms, 'o-1', ['1', '1', '1']);

      expect(steps.map(({ taxCorrectionDelta }) => taxCorrectionDelta.amount)).toEqual(['-1.73', '-1.74', '-1.73']);
      expect(sumOfDeltas(steps)).toBe(-520n);
    });

    /**
     * IMPL-SPEC Unit 12 worked example (B-11/B-12, LEGAL-FINAL §2 Credits: "Partial credits use a tested allocation
     * rule tied to the original consideration and rate"): A GROSS 121.00 @ 21 %, B GROSS 112.00 @ 12 %, ancillary
     * Shipping 99.00 GROSS. The shares are computed via the real `allocateShippingTaxableBasis` + `grossLineValueWeight`,
     * never hardcoded, and passed through `OriginalUnitInput.shipping` as exact rationals.
     */
    const decodeLine = Schema.decodeUnknownSync(LineCommercialValueBasisSchema);
    const unit12WorkedExampleTerms = () => {
      const weightA = grossLineValueWeight(
        decodeLine({
          _tag: 'LINE_COMMERCIAL_VALUE',
          amount: exactDecimal('121.00'),
          amountBasis: 'GROSS',
          occurrenceId: 'o-1',
          pricingLineRef: 'p-1',
        }),
        '21',
      );
      const weightB = grossLineValueWeight(
        decodeLine({
          _tag: 'LINE_COMMERCIAL_VALUE',
          amount: exactDecimal('112.00'),
          amountBasis: 'GROSS',
          occurrenceId: 'o-2',
          pricingLineRef: 'p-2',
        }),
        '12',
      );
      const allocation = Result.getOrThrow(
        allocateShippingTaxableBasis(
          Schema.decodeSync(ShippingAllocationInputSchema)({
            affectedTaxableSupplyUnits: [
              { grossLineValueWeight: weightA, taxableSupplyUnitId: unitIdOf('o-1') },
              { grossLineValueWeight: weightB, taxableSupplyUnitId: unitIdOf('o-2') },
            ],
            shippingSource: {
              _tag: 'CURRENT',
              amount: { amount: exactDecimal('99.00'), amountBasis: 'GROSS', currency: 'CZK' },
              shippingSourceRef: shippingSourceRefInput,
            },
          }),
        ),
      );
      const shareOf = (occurrenceId: string) => {
        const found = allocation.unitAllocations.find(
          ({ taxableSupplyUnitId }) => taxableSupplyUnitId === unitIdOf(occurrenceId),
        );
        if (found === undefined) {
          throw new Error(`No Shipping allocation for ${occurrenceId}`);
        }
        return found.basisComponent.amount;
      };
      const shareA = shareOf('o-1');
      const shareB = shareOf('o-2');
      expect(shareA).toEqual({ denominator: '233', numerator: '11979' });
      expect(shareB).toEqual({ denominator: '233', numerator: '11088' });

      return {
        shareA,
        shareB,
        terms: acceptedTaxTerms([
          {
            amountBasis: 'GROSS',
            lineValue: '121.00',
            occurrenceId: 'o-1',
            quantity: '1',
            ratePercent: '21',
            shipping: shareA,
          },
          {
            amountBasis: 'GROSS',
            lineValue: '112.00',
            occurrenceId: 'o-2',
            quantity: '1',
            ratePercent: '12',
            shipping: shareB,
          },
        ]),
      };
    };

    it('B-11 IMPL-SPEC worked example: stored tax is A 29.92, B 17.10, and a full withdrawal reverses exactly', () => {
      const { shareA, shareB, terms } = unit12WorkedExampleTerms();
      const byUnit = (id: string) =>
        terms.finalTax.result.units.find(({ taxableSupplyUnitId }) => taxableSupplyUnitId === unitIdOf(id));
      expect(byUnit('o-1')?.publishedTaxAmount.amount).toBe('29.92');
      expect(byUnit('o-2')?.publishedTaxAmount.amount).toBe('17.10');

      const outcome = deltaOf(
        correct(terms, [
          unitRequest('o-1', [quantity('-1'), fullReversal(shareA)]),
          unitRequest('o-2', [quantity('-1'), fullReversal(shareB)]),
        ]),
      );
      const deltaByUnit = (id: string) =>
        outcome.units.find(({ taxableSupplyUnitId }) => taxableSupplyUnitId === unitIdOf(id));
      expect(deltaByUnit('o-1')?.proposedNext.remainingPublishedTax.amount).toBe('0.00');
      expect(deltaByUnit('o-2')?.proposedNext.remainingPublishedTax.amount).toBe('0.00');
      expect(deltaByUnit('o-1')?.taxCorrectionDelta.amount).toBe('-29.92');
      expect(deltaByUnit('o-2')?.taxCorrectionDelta.amount).toBe('-17.10');
      expect(outcome.correctionTaxDelta.amount).toBe('-47.02');
    });

    it('B-12 IMPL-SPEC worked example: a Shipping-only refund on A removes exactly its VAT contribution', () => {
      const { shareA, terms } = unit12WorkedExampleTerms();
      const shippingOnlyRefund: TaxCorrectionChange = {
        _tag: 'VALUE',
        amountBasis: 'GROSS',
        basisComponent: 'SHIPPING_ALLOCATION',
        valueDelta: subtractTaxExactRationals(ZERO_TAX_EXACT_RATIONAL, shareA),
      };

      const outcome = deltaOf(correct(terms, [unitRequest('o-1', shippingOnlyRefund)]));

      // Only A is corrected: B is untouched, and A keeps its whole line 121 with exactly its line VAT 21.00.
      expect(outcome.units.map(({ taxableSupplyUnitId }) => taxableSupplyUnitId)).toEqual([unitIdOf('o-1')]);
      expect(outcome.units[0].proposedNext.remainingLineBasis).toEqual(exactDecimal('121'));
      expect(outcome.units[0].proposedNext.remainingShippingBasis).toEqual(ZERO_TAX_EXACT_RATIONAL);
      expect(outcome.units[0].proposedNext.remainingPublishedTax.amount).toBe('21.00');
      expect(outcome.units[0].taxCorrectionDelta.amount).toBe('-8.92');
    });

    it('B-13 every payer correction delta echoes the original unit treatment', () => {
      const terms = acceptedTaxTerms([{ lineValue: '100.00', occurrenceId: 'o-1', quantity: '1' }]);
      const outcome = deltaOf(correct(terms, [unitRequest('o-1', quantity('-1'))]));
      expect(Schema.is(TaxableTreatmentSchema)(outcome.units[0].treatment)).toBe(true);
      if (Schema.is(TaxableTreatmentSchema)(outcome.units[0].treatment)) {
        expect(outcome.units[0].treatment.ratePercent).toBe('21');
      }
    });

    it('B-14 decode rejects a Shipping value change with amountBasis NET', () => {
      const forged: TaxCorrectionChange = {
        _tag: 'VALUE',
        amountBasis: 'NET',
        basisComponent: 'SHIPPING_ALLOCATION',
        valueDelta: exactDecimal('-1'),
      };
      expect(isSingleChange(forged)).toBe(false);

      // `amountBasis` is a required field of the VALUE member: decode rejects it when missing, not just when wrong.
      expect(() =>
        Schema.decodeUnknownSync(TaxCorrectionChangeSchema)({
          _tag: 'VALUE',
          basisComponent: 'LINE_COMMERCIAL_VALUE',
          valueDelta: exactDecimal('-1'),
        }),
      ).toThrow();
    });
  });

  it('D4 keeps the unresolved historical-input outcome outside the purchase-evaluation TAX_* family', () => {
    expect(Schema.is(TaxNonSuccessOutcomeSchema)({ _tag: TAX_HISTORICAL_INPUT_UNRESOLVED })).toBe(false);
  });

  it('D-2 the declared-purpose outcome union decodes TAX_DEPENDENCY_UNAVAILABLE but rejects other TAX_* non-success', () => {
    const isOutcome = Schema.is(DeclaredTaxPurposeOutcomeSchema);
    expect(isOutcome({ _tag: 'TAX_DEPENDENCY_UNAVAILABLE' })).toBe(true);
    expect(isOutcome({ _tag: 'TAX_STATE_INDETERMINATE' })).toBe(false);
    expect(isOutcome({ _tag: 'TAX_RULE_MISSING' })).toBe(false);
    expect(
      isOutcome({ _tag: TAX_HISTORICAL_INPUT_UNRESOLVED, unresolved: { _tag: 'HISTORY_OWNER_UNAVAILABLE' } }),
    ).toBe(false);
  });
});
