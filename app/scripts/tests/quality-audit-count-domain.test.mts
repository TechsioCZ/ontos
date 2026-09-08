import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Result, Schema } from 'effect';
import { KnipModelEvidenceSchema } from '../../quality-audit/knip-model.mts';
import { makeEffectTestCallback } from '../../packages/core-runtime/src/testing/effect-runtime.ts';
import { validateReport } from '../quality-audit.mts';
import { validateQualityAuditSummary } from '../quality-audit-gate.mts';

void test('audit evidence requires finite nonnegative integer source positions', () => {
  const evidence = {
    kind: 'entry',
    line: 0,
    reason: 'fixture',
    source: 'fixture.mts',
    target: 'fixture.mts',
    workspace: '.',
  };
  const valid = Schema.is(KnipModelEvidenceSchema);
  assert.equal(valid(evidence), true);
  assert.equal(valid({ ...evidence, column: 0, line: 1 }), true);
  for (const value of [Number.NaN, Infinity, -Infinity, -1, 0.5]) {
    assert.equal(valid({ ...evidence, line: value }), false);
    assert.equal(valid({ ...evidence, column: value }), false);
  }
});

void test(
  'audit and gate reject nonfinite, negative and fractional report counts',
  makeEffectTestCallback(
    Effect.gen(function* invalidCountReports() {
      for (const count of ['1e400', '-1e400', '-1', '0.5']) {
        const audit = yield* validateReport(
          'jscpd',
          `{"duplicates":[],"statistics":{"total":{"clones":0,"sources":${count}}}}`,
        ).pipe(Effect.result);
        assert.equal(Result.isFailure(audit), true);
        const gate = yield* validateQualityAuditSummary(
          `{"status":"reported","results":[{"name":"jscpd","status":"reported","diagnostic":"","advisory":false,"files":${count},"findings":0,"coverage":{"tokenEligibleFiles":${count}}}]}`,
        ).pipe(Effect.result);
        assert.equal(Result.isFailure(gate), true);
        if (Result.isFailure(gate)) {
          assert.match(gate.failure.message, /Malformed audit summary/u);
        }
      }
    }),
  ),
);
