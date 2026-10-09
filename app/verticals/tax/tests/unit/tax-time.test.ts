import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  EffectivePeriodSchema,
  OrderCommitmentTimeSchema,
  TaxEvaluationTimeSchema,
  TaxRelevantTimeSchema,
  finalLaunchOrderTaxRelevantTime,
  isWithinEffectivePeriod,
} from '../../shared/domain/tax-kernel/tax-time.ts';

const taxRelevantTime = Schema.decodeUnknownSync(TaxRelevantTimeSchema);
const taxEvaluationTime = Schema.decodeUnknownSync(TaxEvaluationTimeSchema);
const orderCommitmentTime = Schema.decodeUnknownSync(OrderCommitmentTimeSchema);
const effectivePeriod = Schema.decodeUnknownSync(EffectivePeriodSchema);

const boundary = '2026-01-01T00:00:00.000Z';
const beforeBoundary = '2025-12-31T23:59:59.999Z';
const r1 = effectivePeriod({ effectiveFrom: '2025-01-01T00:00:00.000Z', effectiveTo: boundary });
const r2 = effectivePeriod({ effectiveFrom: boundary });

describe('Tax time', () => {
  it('#941 F5 #929 F4-F6 F10 revision ending at T is excluded and revision starting at T is included', () => {
    expect(isWithinEffectivePeriod(r1, taxRelevantTime(boundary))).toBe(false);
    expect(isWithinEffectivePeriod(r2, taxRelevantTime(boundary))).toBe(true);
  });

  it('#929 F4-F6 before the boundary the ending revision applies and the starting one does not', () => {
    expect(isWithinEffectivePeriod(r1, taxRelevantTime(beforeBoundary))).toBe(true);
    expect(isWithinEffectivePeriod(r2, taxRelevantTime(beforeBoundary))).toBe(false);
  });

  it('#929 F7-F9 a future open-ended revision is not applicable before effective_from', () => {
    const future = effectivePeriod({ effectiveFrom: '2027-01-01T00:00:00.000Z' });

    expect(isWithinEffectivePeriod(future, taxRelevantTime('2026-12-31T23:59:59.999Z'))).toBe(false);
    expect(isWithinEffectivePeriod(future, taxRelevantTime('2100-01-01T00:00:00.000Z'))).toBe(true);
  });

  it('#929 F4 #941 F5 membership compares instants, not offset notation', () => {
    expect(isWithinEffectivePeriod(r2, taxRelevantTime('2026-01-01T01:00:00+01:00'))).toBe(true);
    expect(isWithinEffectivePeriod(r1, taxRelevantTime('2026-01-01T00:59:59+01:00'))).toBe(true);
  });

  it('#929 F4-F10 #941 F5 an inverted or empty Effective Period is not representable', () => {
    expect(() => effectivePeriod({ effectiveFrom: boundary, effectiveTo: beforeBoundary })).toThrow();
    expect(() => effectivePeriod({ effectiveFrom: boundary, effectiveTo: boundary })).toThrow();
  });

  it('#941 F2-F4 F10 #907 F155-F156 final Launch Order Tax-Relevant Time is exactly Order Commitment Time T', () => {
    const t = orderCommitmentTime(beforeBoundary);
    const evaluatedAfterBoundary = taxEvaluationTime('2026-01-01T00:00:05.000Z');
    const relevant = finalLaunchOrderTaxRelevantTime(t);

    expect(DateTime.toEpochMillis(relevant)).toBe(DateTime.toEpochMillis(t));
    expect(DateTime.isGreaterThan(evaluatedAfterBoundary, relevant)).toBe(true);
    expect(isWithinEffectivePeriod(r1, relevant)).toBe(true);
    expect(isWithinEffectivePeriod(r2, relevant)).toBe(false);
  });

  it('#941 F1 #929 F11-F12 #907 F142-F143 Tax Evaluation Time is a distinct type that cannot select rule effectivity', () => {
    const evaluation = taxEvaluationTime(boundary);
    const relevant = taxRelevantTime(boundary);

    // @ts-expect-error Tax Evaluation Time is not a Tax-Relevant Time even when the instants coincide.
    const evaluationAsSelector: Parameters<typeof isWithinEffectivePeriod>[1] = evaluation;

    expect(DateTime.toEpochMillis(evaluationAsSelector)).toBe(DateTime.toEpochMillis(relevant));
  });
});
