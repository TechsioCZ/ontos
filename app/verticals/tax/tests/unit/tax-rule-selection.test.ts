import { DateTime, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { selectApplicableTaxRuleRevision } from '../../src/domain/tax-rule-selection.ts';
import type { CompleteTaxRuleState, TaxRuleRevisionState } from '../../src/domain/tax-rule-selection.ts';
import { TaxRelevantTimeSchema } from '../../src/domain/tax-time.ts';

const instant = (value: string) => DateTime.makeUnsafe(value);
const taxRelevantTime = Schema.decodeUnknownSync(TaxRelevantTimeSchema);

const boundary = '2026-01-01T00:00:00.000Z';
const beforeBoundary = '2025-12-31T23:59:59.999Z';
const ruleId = '00000000-0000-4000-8000-000000000001';

const revision = (
  revisionId: string,
  overrides: Partial<Omit<TaxRuleRevisionState, 'revisionId'>> = {},
): TaxRuleRevisionState => ({
  compositionKind: 'EXCLUSIVE',
  correctedBy: [],
  effectiveFrom: instant('2025-01-01T00:00:00.000Z'),
  effectiveTo: Option.none(),
  endedEffectiveTo: Option.none(),
  ratePercent: '21',
  revisionId,
  revisionNumber: 1,
  taxRuleId: ruleId,
  treatmentCategory: 'TAXABLE',
  ...overrides,
});

const state = (...revisions: readonly TaxRuleRevisionState[]): CompleteTaxRuleState => ({
  predicateFingerprint: 'a'.repeat(64),
  revisions,
});

const select = (completeState: CompleteTaxRuleState | undefined, at: string) =>
  selectApplicableTaxRuleRevision({ completeState, taxRelevantTime: taxRelevantTime(at) });

const selectedId = (selection: ReturnType<typeof select>) =>
  selection.kind === 'SELECTED' ? selection.revision.revisionId : selection.outcome._tag;

const r1 = revision('r1', { effectiveTo: Option.some(instant(boundary)) });
const r2 = revision('r2', { effectiveFrom: instant(boundary), ratePercent: '12', revisionNumber: 2 });

describe('Tax Rule selection', () => {
  it('#929 F4-F6 boundary: T == effective_from of R2 selects R2, the instant before selects R1', () => {
    expect(selectedId(select(state(r1, r2), beforeBoundary))).toBe('r1');
    const atBoundary = select(state(r1, r2), boundary);
    expect(selectedId(atBoundary)).toBe('r2');
    expect(atBoundary.kind === 'SELECTED' && atBoundary.ratePercent).toBe('12');
    expect(atBoundary.kind === 'SELECTED' && atBoundary.ref).toEqual({ revision: 2, taxRuleId: ruleId });
  });

  it('#929 F10 T == effective_to excludes the ended revision and a later gap is TAX_RULE_MISSING (#930 F1)', () => {
    expect(selectedId(select(state(r1), boundary))).toBe('TAX_RULE_MISSING');
  });

  it('#929 F8-F9 a future revision is not applicable before its effective_from', () => {
    const future = revision('future', { effectiveFrom: instant('2027-01-01T00:00:00.000Z'), revisionNumber: 9 });
    expect(selectedId(select(state(r1, future), beforeBoundary))).toBe('r1');
    expect(selectedId(select(state(r1, future), '2026-06-01T00:00:00.000Z'))).toBe('TAX_RULE_MISSING');
  });

  it('#929 F2 #930 F8 an end fact shortens the period without mutating the revision', () => {
    const ended = revision('ended', { endedEffectiveTo: Option.some(instant(boundary)) });
    expect(selectedId(select(state(ended), beforeBoundary))).toBe('ended');
    expect(selectedId(select(state(ended), boundary))).toBe('TAX_RULE_MISSING');
  });

  it('#930 F2 two exclusive revisions with the same meaning at T are TAX_RULE_OVERLAP, never a winner', () => {
    const duplicate = revision('duplicate', { ratePercent: '21.00', revisionNumber: 2 });
    const selection = select(state(revision('r1'), duplicate), boundary);
    expect(selectedId(selection)).toBe('TAX_RULE_OVERLAP');
    expect(selection.kind === 'NOT_SELECTED' && selection.applicable.map(({ revisionId }) => revisionId)).toEqual([
      'r1',
      'duplicate',
    ]);
  });

  it('#930 F3 incompatible rates at T without a governing composition are TAX_RULE_CONFLICT', () => {
    const competing = revision('competing', { ratePercent: '12', taxRuleId: '00000000-0000-4000-8000-000000000002' });
    expect(selectedId(select(state(revision('r1'), competing), boundary))).toBe('TAX_RULE_CONFLICT');
  });

  it('#930 F8 a confirmed correction covering T excludes the wrong revision and returns provenance', () => {
    const wrong = revision('wrong', { correctedBy: ['correcting'] });
    const correcting = revision('correcting', {
      effectiveFrom: instant(boundary),
      ratePercent: '12',
      revisionNumber: 2,
    });
    const corrected = select(state(wrong, correcting), boundary);
    expect(selectedId(corrected)).toBe('correcting');
    expect(corrected.excludedByCorrection).toEqual([{ correctingRevisionId: 'correcting', wrongRevisionId: 'wrong' }]);
    // Before the correcting revision is effective, the wrong revision remains the only applicable meaning.
    const before = select(state(wrong, correcting), beforeBoundary);
    expect(selectedId(before)).toBe('wrong');
    expect(before.excludedByCorrection).toEqual([]);
  });

  it('#929 F13 F18 #907 F59 selection is deterministic and ignores insertion order and revision number', () => {
    const current = revision('current', { revisionNumber: 1 });
    const highest = revision('highest', { effectiveFrom: instant('2030-01-01T00:00:00.000Z'), revisionNumber: 99 });
    const forward = select(state(current, highest, r1), '2026-06-01T00:00:00.000Z');
    const reversed = select(state(r1, highest, current), '2026-06-01T00:00:00.000Z');
    expect(selectedId(forward)).toBe('current');
    expect(reversed).toEqual(forward);
  });

  it('#929 F17 #930 F7 #942 F12 F15 without complete owner state the outcome is TAX_STATE_INDETERMINATE, never missing', () => {
    expect(selectedId(select(undefined, boundary))).toBe('TAX_STATE_INDETERMINATE');
  });
});
