import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { KnipModelEvidenceSchema } from '../../quality-audit/knip-model.mts';
import { validateQualityAuditSummary } from '../quality-audit-gate.mts';
import { validateReport } from '../quality-audit.mts';

it('audit evidence requires finite nonnegative integer source positions', () => {
  const evidence = {
    kind: 'entry',
    line: 0,
    reason: 'fixture',
    source: 'fixture.mts',
    target: 'fixture.mts',
    workspace: '.',
  };
  const valid = Schema.is(KnipModelEvidenceSchema);
  expect(valid(evidence)).toBe(true);
  expect(valid({ ...evidence, column: 0, line: 1 })).toBe(true);
  for (const value of [Number.NaN, Infinity, -Infinity, -1, 0.5]) {
    expect(valid({ ...evidence, line: value })).toBe(false);
    expect(valid({ ...evidence, column: value })).toBe(false);
  }
});

it.effect(
  'audit and gate reject nonfinite, negative and fractional report counts',
  () =>
    Effect.gen(function* invalidCountReports() {
      for (const count of ['1e400', '-1e400', '-1', '0.5']) {
        const audit = yield* validateReport(
          'jscpd',
          `{"duplicates":[],"statistics":{"total":{"clones":0,"sources":${count}}}}`
        ).pipe(Effect.result);
        expect(Result.isFailure(audit)).toBe(true);
        const gate = yield* validateQualityAuditSummary(
          `{"status":"reported","results":[{"name":"jscpd","status":"reported","diagnostic":"","advisory":false,"files":${count},"findings":0,"coverage":{"tokenEligibleFiles":${count}}}]}`
        ).pipe(Effect.result);
        expect(Result.isFailure(gate)).toBe(true);
        if (Result.isFailure(gate)) {
          expect(gate.failure.message).toMatch(/Malformed audit summary/u);
        }
      }
    })
);
