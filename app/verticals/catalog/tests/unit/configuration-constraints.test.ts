import { describe, expect, it } from 'effect-rstest';

import {
  evaluateCompatibilityRules,
  evaluateMeasuredConstraint,
} from '../../shared/domain/configuration-constraints.ts';
import type { MeasuredConstraint } from '../../shared/domain/configuration-constraints.ts';

const length: MeasuredConstraint = {
  completeness: 'COMPLETE',
  maximum: { amount: '120', inclusive: true },
  minimum: { amount: '60', inclusive: true },
  revision: 3,
  ruleId: 'length-rule',
  step: { amount: '1', base: '60' },
  unit: 'cm',
};

describe('configuration constraints', () => {
  it('honors explicit interval inclusivity and an independently anchored step', () => {
    expect(evaluateMeasuredConstraint({ amount: '120', unit: 'cm' }, length).status).toBe('VALID');
    expect(
      evaluateMeasuredConstraint(
        { amount: '120', unit: 'cm' },
        {
          ...length,
          maximum: { amount: '120', inclusive: false },
        },
      ),
    ).toMatchObject({ code: 'MAXIMUM', status: 'INVALID' });
    expect(evaluateMeasuredConstraint({ amount: '83.5', unit: 'cm' }, length)).toMatchObject({
      code: 'OFF_STEP',
      status: 'INVALID',
    });
    expect(evaluateMeasuredConstraint({ amount: '83.5', unit: 'cm' }, { ...length, step: null }).status).toBe('VALID');
  });

  it('uses exact, evidenced unit conversions without rounding or input mutation', () => {
    const value = { amount: '1200', unit: 'mm' };
    const conversions = [{ denominator: '10', evidenceId: 'unit-rev-7', from: 'mm', numerator: '1', to: 'cm' }];
    expect(evaluateMeasuredConstraint(value, length, conversions).status).toBe('VALID');
    expect(value).toEqual({ amount: '1200', unit: 'mm' });
    expect(evaluateMeasuredConstraint({ amount: '835', unit: 'mm' }, length, conversions)).toMatchObject({
      code: 'OFF_STEP',
      status: 'INVALID',
    });
    expect(evaluateMeasuredConstraint(value, length)).toMatchObject({ code: 'INCOMPATIBLE_UNIT', status: 'INVALID' });
  });

  it('does not choose a conflicting evidenced conversion by input order', () => {
    const value = { amount: '1200', unit: 'mm' };
    const correct = { denominator: '10', evidenceId: 'unit-rev-7', from: 'mm', numerator: '1', to: 'cm' };
    const conflicting = { denominator: '5', evidenceId: 'unit-rev-8', from: 'mm', numerator: '1', to: 'cm' };
    for (const conversions of [
      [correct, conflicting],
      [conflicting, correct],
    ]) {
      expect(evaluateMeasuredConstraint(value, length, conversions)).toMatchObject({
        code: 'AMBIGUOUS_UNIT_CONVERSION',
        status: 'INDETERMINATE',
      });
    }
  });

  it('distinguishes confirmed absence from unknown or malformed deciding rules', () => {
    expect(evaluateMeasuredConstraint({ amount: '8', unit: 'cm' }, null).status).toBe('INDETERMINATE');
    expect(
      evaluateMeasuredConstraint({ amount: '83', unit: 'cm' }, { ...length, completeness: 'UNKNOWN' }).status,
    ).toBe('INDETERMINATE');
    expect(
      evaluateMeasuredConstraint({ amount: '130', unit: 'cm' }, { ...length, completeness: 'UNKNOWN' }).status,
    ).toBe('INVALID');
    expect(
      evaluateMeasuredConstraint({ amount: '83', unit: 'cm' }, { ...length, step: { amount: '0', base: '60' } }).status,
    ).toBe('INDETERMINATE');
  });

  it('rejects individually admissible values when their closed combination is forbidden', () => {
    const selected = {
      length: { amount: '110', kind: 'MEASURED_VALUE', unit: 'cm' },
      mounting: { choiceId: 'A', kind: 'SINGLE_CHOICE' },
    } as const;
    const rule = {
      choiceId: 'A',
      choiceKey: 'mounting',
      kind: 'CHOICE_MEASURED_MAXIMUM',
      maximum: { amount: '100', inclusive: true },
      measuredKey: 'length',
      revision: 2,
      ruleId: 'mounting-A-max',
      unit: 'cm',
    } as const;
    expect(evaluateCompatibilityRules(selected, [rule], 'COMPLETE')).toMatchObject({
      code: 'INCOMPATIBLE_COMBINATION',
      status: 'INVALID',
    });
    expect(
      evaluateCompatibilityRules(
        { ...selected, length: { amount: '83', kind: 'MEASURED_VALUE', unit: 'cm' } },
        [rule],
        'COMPLETE',
      ).status,
    ).toBe('VALID');
    expect(evaluateCompatibilityRules(selected, [], 'UNKNOWN').status).toBe('INDETERMINATE');
    expect(evaluateCompatibilityRules(selected, [], 'COMPLETE').status).toBe('VALID');
    expect(selected.length.amount).toBe('110');
  });

  it('rejects exact forbidden choice tuples regardless of rule order', () => {
    const selected = {
      color: { choiceId: 'black', kind: 'SINGLE_CHOICE' },
      mounting: { choiceId: 'A', kind: 'SINGLE_CHOICE' },
    } as const;
    const forbidden = {
      choices: { color: 'black', mounting: 'A' },
      kind: 'FORBIDDEN_CHOICE_COMBINATION',
      revision: 1,
      ruleId: 'pair',
    } as const;
    expect(evaluateCompatibilityRules(selected, [forbidden], 'COMPLETE').status).toBe('INVALID');
    expect(evaluateCompatibilityRules(selected, [forbidden], 'UNKNOWN').status).toBe('INVALID');
  });
});
