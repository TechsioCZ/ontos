import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  TaxDependencyUnavailableSchema,
  TaxInputStaleSchema,
  TaxNonSuccessOutcomeSchema,
  TaxStateIndeterminateSchema,
  taxNotEstablishedOutcome,
} from '../../src/domain/tax-non-success-outcome.ts';
import type { TaxNonSuccessOutcome } from '../../src/domain/tax-non-success-outcome.ts';

const decodeNonSuccess = Schema.decodeUnknownSync(TaxNonSuccessOutcomeSchema);

const everyNonSuccess: readonly TaxNonSuccessOutcome[] = [
  { _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'REVERSE_CHARGE' },
  { _tag: 'TAX_RULE_MISSING' },
  { _tag: 'TAX_RULE_OVERLAP' },
  { _tag: 'TAX_RULE_CONFLICT' },
  { _tag: 'TAX_INPUT_STALE' },
  { _tag: 'TAX_DEPENDENCY_UNAVAILABLE' },
  { _tag: 'TAX_STATE_INDETERMINATE' },
];

describe('Typed Tax non-success outcomes', () => {
  it('#938 A F3-F27 keeps exactly seven distinct Launch non-success codes', () => {
    const codes = everyNonSuccess.map((outcome) => decodeNonSuccess(outcome)._tag);

    expect(new Set(codes).size).toBe(7);
    expect(() => decodeNonSuccess({ _tag: 'ERROR' })).toThrow();
    expect(() => decodeNonSuccess({ _tag: 'TAX_PROVIDER_TIMEOUT' })).toThrow();
  });

  it('#938 F2 #939 F14-F25 non-success outcomes never carry a Tax amount', () => {
    for (const outcome of everyNonSuccess) {
      const decoded = decodeNonSuccess({ ...outcome, taxAmount: { amount: '0.00', currency: 'CZK' } });

      expect(Object.keys(decoded)).not.toContain('taxAmount');
      expect(Object.keys(decoded)).not.toContain('result');
    }
  });

  it('Unit 10 A3 TAX_PREREQUISITE_NOT_MET is not in TaxNonSuccessOutcomeSchema', () => {
    expect(() =>
      decodeNonSuccess({
        _tag: 'TAX_PREREQUISITE_NOT_MET',
        unmetPrerequisite: 'SELLING_LEGAL_ENTITY_CURRENT_CZ_VAT_REGISTRATION',
      }),
    ).toThrow();
  });

  it('#938 F13-F15 F20-F32 an input that cannot be established is stale, unavailable or indeterminate, never negative', () => {
    expect(Schema.is(TaxInputStaleSchema)(taxNotEstablishedOutcome('STALE'))).toBe(true);
    expect(Schema.is(TaxDependencyUnavailableSchema)(taxNotEstablishedOutcome('UNAVAILABLE'))).toBe(true);
    for (const state of ['UNKNOWN', 'UNRESOLVED', 'CONFLICTING', 'UNVERIFIABLE'] as const) {
      expect(Schema.is(TaxStateIndeterminateSchema)(taxNotEstablishedOutcome(state))).toBe(true);
    }
  });
});
