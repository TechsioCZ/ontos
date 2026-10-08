import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { AcceptedTaxTerms } from '../../src/domain/accepted-tax-terms.ts';
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
import { TAX_HISTORICAL_INPUT_UNRESOLVED } from '../../src/domain/tax-historical-input-outcome.ts';
import { TaxNonSuccessOutcomeSchema } from '../../src/domain/tax-non-success-outcome.ts';
import { acceptedTaxTerms, acceptedTaxTermsInput, unitIdOf } from './tax-correction-fixtures.ts';
import type { OriginalUnitInput } from './tax-correction-fixtures.ts';
import { exactDecimal } from './tax-domain-fixtures.ts';

const decodeRequest = Schema.decodeUnknownSync(TaxCorrectionRequestSchema);
const decodeState = Schema.decodeUnknownSync(CumulativeUnitTaxStateSchema);
const isDelta = Schema.is(TaxCorrectionDeltaSchema);
const isUnresolved = Schema.is(TaxCorrectionHistoricalInputUnresolvedSchema);
const isOutOfBounds = Schema.is(TaxCorrectionOutOfBoundsSchema);

const minorUnits = (amount: string) => BigInt(amount.replace('.', ''));
const sumOfDeltas = (steps: readonly { readonly taxCorrectionDelta: { readonly amount: string } }[]) =>
  steps.reduce((total, { taxCorrectionDelta }) => total + minorUnits(taxCorrectionDelta.amount), 0n);

const quantity = (amount: string): TaxCorrectionChange => ({ _tag: 'QUANTITY', quantityDelta: exactDecimal(amount) });
const value = (amount: string): TaxCorrectionChange => ({ _tag: 'VALUE', valueDelta: exactDecimal(amount) });
const NO_ACCEPTED_CORRECTION: AcceptedCumulativeCorrectionState = { _tag: 'NO_ACCEPTED_CORRECTION' };

const unitRequest = (
  occurrenceId: string,
  change: TaxCorrectionChange,
  expectedPreviousState: AcceptedCumulativeCorrectionState = NO_ACCEPTED_CORRECTION,
): TaxCorrectionUnitRequest => ({ change, expectedPreviousState, taxableSupplyUnitId: unitIdOf(occurrenceId) });

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

/** Units reported by a non-success correction outcome; a delta reports none. */
const issuesOf = (outcome: TaxCorrectionOutcome) =>
  isUnresolved(outcome) || isOutOfBounds(outcome) ? outcome.units : [];

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

const tenAt9999: OriginalUnitInput = { lineValue: '999.90', occurrenceId: 'o-1', quantity: '10' };

const acceptedAfterSeven: AcceptedCumulativeCorrectionState = {
  _tag: 'ACCEPTED',
  state: decodeState({
    remainingBasis: exactDecimal('299.97'),
    remainingPublishedTax: { amount: '62.99', currency: 'CZK' },
    remainingQuantity: exactDecimal('3'),
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
    expect(steps.map(({ proposedNext }) => proposedNext.remainingBasis)).toEqual([
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
    const terms = acceptedTaxTerms([{ lineValue: '100.00', occurrenceId: 'o-1', quantity: '2', shipping: '10.00' }]);
    expect(terms.finalTax.result.units[0].publishedTaxAmount.amount).toBe('23.10');

    const goods = deltaOf(correct(terms, [unitRequest('o-1', quantity('-2'))]));
    expect(goods.units[0].proposedNext.remainingBasis).toEqual(exactDecimal('10'));
    expect(goods.units[0].proposedNext.remainingQuantity).toEqual(exactDecimal('0'));
    expect(goods.units[0].taxCorrectionDelta.amount).toBe('-21.00');

    const shipping = deltaOf(correct(terms, [unitRequest('o-1', value('-10'), acceptedAs(goods, 'v1'))]));
    expect(shipping.units[0].proposedNext.remainingPublishedTax.amount).toBe('0.00');
    expect(shipping.units[0].taxCorrectionDelta.amount).toBe('-2.10');
  });

  it('#948 F10 a value correction without a quantity change keeps the accepted quantity', () => {
    const outcome = deltaOf(correct(acceptedTaxTerms([tenAt9999]), [unitRequest('o-1', value('-99.99'))]));

    expect(outcome.units[0].proposedNext.remainingQuantity).toEqual(exactDecimal('10'));
    expect(outcome.units[0].proposedNext.remainingPublishedTax.amount).toBe('188.98');
    expect(outcome.units[0].taxCorrectionDelta.amount).toBe('-21.00');
  });

  it('#948 F16 already corrected quantity or basis is not consumed twice and nothing is clamped', () => {
    const terms = acceptedTaxTerms([tenAt9999]);
    const quantityOutside = [{ reason: 'QUANTITY_OUTSIDE_ORIGINAL', taxableSupplyUnitId: unitIdOf('o-1') }];

    for (const outcome of [
      correct(terms, [unitRequest('o-1', quantity('-4'), acceptedAfterSeven)]),
      correct(terms, [unitRequest('o-1', quantity('-11'))]),
      correct(terms, [unitRequest('o-1', quantity('1'))]),
    ]) {
      expect(isOutOfBounds(outcome)).toBe(true);
      expect(issuesOf(outcome)).toEqual(quantityOutside);
    }
    const basis = correct(terms, [unitRequest('o-1', value('-1000'))]);
    expect(isOutOfBounds(basis)).toBe(true);
    expect(issuesOf(basis)).toEqual([{ reason: 'BASIS_OUTSIDE_ORIGINAL', taxableSupplyUnitId: unitIdOf('o-1') }]);
    expect(isDelta(correct(terms, [unitRequest('o-1', quantity('3'), acceptedAfterSeven)]))).toBe(true);
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
      state: Partial<{ remainingBasis: string; remainingPublishedTax: string; remainingQuantity: string }>,
    ) =>
      correct(terms, [
        unitRequest('o-1', quantity('-1'), {
          _tag: 'ACCEPTED',
          state: decodeState({
            remainingBasis: exactDecimal(state.remainingBasis ?? '699.93'),
            remainingPublishedTax: { amount: state.remainingPublishedTax ?? '146.99', currency: 'CZK' },
            remainingQuantity: exactDecimal(state.remainingQuantity ?? '7'),
          }),
          stateVersion: 'v1',
        }),
      ]);

    expect(isDelta(forged({}))).toBe(true);
    for (const state of [
      { remainingPublishedTax: '147.00' },
      { remainingQuantity: '11' },
      { remainingBasis: '1000' },
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
    expect(outcome.originalRecord).toEqual(terms.authoritativeRecord);
    expect(outcome.originalTaxDecisionId).toBe(terms.finalTax.decision.decisionId);
    expect(outcome.taxRoundingPolicy).toEqual(terms.finalTax.result.taxRoundingPolicy);
    expect(outcome.correctionEventRef).toBe('return-1');
    expect(outcome.correctionReason).toBe('CUSTOMER_RETURN');
    expect(outcome.correctionTaxDelta.amount).toBe('-4.20');
  });

  it('#948 F10-F16 rejects a zero change and a unit changed twice in one correction', () => {
    const request = (units: readonly TaxCorrectionUnitRequest[]) => ({
      acceptedTaxTerms: acceptedTaxTermsInput([tenAt9999]),
      correctionEventRef: 'return-1',
      correctionReason: 'CUSTOMER_RETURN',
      units,
    });

    expect(decodeRequest(request([unitRequest('o-1', quantity('-1'))])).units).toHaveLength(1);
    expect(() => decodeRequest(request([unitRequest('o-1', quantity('0'))]))).toThrow();
    expect(() =>
      decodeRequest(request([unitRequest('o-1', quantity('-1')), unitRequest('o-1', value('-1'))])),
    ).toThrow();
  });

  it('D4 keeps the unresolved historical-input outcome outside the purchase-evaluation TAX_* family', () => {
    expect(Schema.is(TaxNonSuccessOutcomeSchema)({ _tag: TAX_HISTORICAL_INPUT_UNRESOLVED })).toBe(false);
  });
});
