import { Cause, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { validateQualityAuditSummary } from '../quality-audit-gate.mts';
import { validateReport } from '../quality-audit.mts';

const EXPECTED_PROOF_VALUE = 'Expected a defined proof value';
const EXPECTED_EFFECT_FAILURE = 'Expected the Effect to fail';

const FALLOW_FILES = 'fallow-files';
const FALLOW_SIMILARITY = 'fallow-similarity';
const FALLOW_HEALTH = 'fallow-health';
interface FixtureCoverage {
  analyzedFiles?: number;
  analyzedFunctions?: number;
  controlFlowFindings?: number;
  discoveredFiles?: number;
  findingCounts?: Schema.Json;
  modeledUsages?: number;
  nativeFindingCounts?: Schema.Json;
  processed?: number;
  tokenEligibleFiles: number;
  total?: number;
  uiOnlyFindings?: number;
  weightedFindings?: number;
  workspaces?: string[];
}
const names = ['knip', 'jscpd', FALLOW_FILES, 'fallow-clones', FALLOW_SIMILARITY, FALLOW_HEALTH];
const clean = () => ({
  results: names.map((name) => {
    const coverage: FixtureCoverage = { tokenEligibleFiles: 2 };
    if (name === 'knip') {
      Object.assign(coverage, {
        findingCounts: { exports: 0, unlisted: 0 },
        modeledUsages: 0,
        nativeFindingCounts: { exports: 0, unlisted: 0 },
        processed: 2,
        total: 2,
        workspaces: ['.'],
      });
    }
    if (name === FALLOW_FILES) {
      Object.assign(coverage, { discoveredFiles: 2 });
    }
    if (name === FALLOW_HEALTH) {
      Object.assign(coverage, {
        analyzedFiles: 2,
        analyzedFunctions: 2,
        controlFlowFindings: 0,
        uiOnlyFindings: 0,
        weightedFindings: 0,
      });
    }
    return {
      advisory: name === FALLOW_SIMILARITY,
      coverage,
      diagnostic: '',
      files: 2,
      findings: 0,
      name,
      status: 'reported',
    };
  }),
  status: 'reported',
});
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const validate = Effect.fn(function* mergedScenario1(summary: ReturnType<typeof clean> | Schema.Json) {
  return yield* encode(summary).pipe(Effect.flatMap(validateQualityAuditSummary));
});

it.effect(
  'complete clean summary succeeds; semantic and UI-only findings remain advisory',
  Effect.fn(function* mergedScenario2() {
    yield* validate(clean());
    const summary = clean();
    const semantic = summary.results.find(({ name }) => name === FALLOW_SIMILARITY);
    const health = summary.results.find(({ name }) => name === FALLOW_HEALTH);
    expect(semantic && health).toBeTruthy();
    if (!(semantic && health)) {
      throw new Error(EXPECTED_PROOF_VALUE);
    }
    semantic.findings = 19;
    health.coverage.uiOnlyFindings = 2;
    health.coverage.weightedFindings = 2;
    yield* validate(summary);
  }),
);

const positiveReports = [
  [
    'knip',
    `${JSON.stringify({ issues: [] })}\n${JSON.stringify({ coverage: { processed: 2, total: 2 }, findingCounts: { exports: 1, unlisted: 0 }, workspaces: ['.'] })}`,
  ],
  [
    'jscpd',
    JSON.stringify({
      duplicates: [
        {
          firstFile: { name: 'a.ts', start: 1 },
          lines: 12,
          secondFile: { name: 'b.ts', start: 1 },
          tokens: 110,
        },
      ],
      statistics: { total: { clones: 1, sources: 2 } },
    }),
  ],
  [
    'fallow-clones',
    JSON.stringify({
      clone_groups: [
        {
          fingerprint: 'same-body',
          instances: [
            { end_line: 12, file: 'a.ts', start_line: 1 },
            { end_line: 12, file: 'b.ts', start_line: 1 },
          ],
          line_count: 12,
          token_count: 110,
        },
      ],
      kind: 'dupes',
      schema_version: 9,
      stats: { clone_groups: 1, total_files: 2 },
      version: '3.22.0',
    }),
  ],
  [
    FALLOW_HEALTH,
    JSON.stringify({
      findings: [
        {
          cognitive: 0,
          contributions: [{ kind: 'if', metric: 'cyclomatic', weight: 10 }],
          cyclomatic: 11,
          line: 1,
          name: 'branchHeavy',
          path: 'a.ts',
        },
      ],
      kind: 'health',
      schema_version: 11,
      summary: {
        files_analyzed: 2,
        functions_above_threshold: 1,
        functions_analyzed: 2,
        max_cognitive_threshold: 15,
        max_crap_threshold: 0,
        max_cyclomatic_threshold: 10,
      },
      version: '3.22.0',
    }),
  ],
] as const;
for (const [name, source] of positiveReports) {
  it.effect(
    `${name} real-positive analyzer report rejects through the normalized gate`,
    Effect.fn(function* mergedScenario3() {
      const normalized = yield* validateReport(name, source);
      const summary = clean();
      const result = summary.results.find((entry) => entry.name === name);
      expect(result).toBeTruthy();
      if (!result) {
        throw new Error(EXPECTED_PROOF_VALUE);
      }
      Object.assign(result, normalized);
      if (name === 'knip') {
        Object.assign(result.coverage, {
          modeledUsages: 0,
          nativeFindingCounts: result.coverage.findingCounts,
        });
      }
      yield* Effect.matchCause(validate(summary), {
        onFailure: (cause) =>
          expect(String(Cause.squash(cause))).toMatch(new RegExp(`Quality audit gate failed: ${name}=1`, 'u')),
        onSuccess: () => {
          throw new Error(EXPECTED_EFFECT_FAILURE);
        },
      });
    }),
  );
}

it.effect(
  'calibrated modeled consumers do not reintroduce native Knip findings',
  Effect.fn(function* mergedScenario5() {
    const summary = clean();
    const knip = summary.results.find(({ name }) => name === 'knip');
    expect(knip).toBeTruthy();
    if (!knip) {
      throw new Error(EXPECTED_PROOF_VALUE);
    }
    knip.coverage.modeledUsages = 4;
    knip.coverage.nativeFindingCounts = { exports: 0, unlisted: 4 };
    yield* validate(summary);
    knip.coverage.modeledUsages = 5;
    yield* Effect.matchCause(validate(summary), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/inconsistent/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
  }),
);

it.effect(
  'partial, duplicate, unknown, failed and empty reports fail closed',
  Effect.fn(function* mergedScenario8() {
    yield* Effect.matchCause(validate({}), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/Malformed/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* Effect.matchCause(validate({ ...clean(), status: 'error' }), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/Malformed/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* Effect.matchCause(validate({ results: [], status: 'reported' }), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/six unique/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* Effect.all(
      names.map(
        Effect.fn(function* mergedScenario6(name) {
          const summary = clean();
          yield* Effect.matchCause(
            validate({
              ...summary,
              results: summary.results.filter((entry) => entry.name !== name),
            }),
            {
              onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/six unique/u),
              onSuccess: () => {
                throw new Error(EXPECTED_EFFECT_FAILURE);
              },
            },
          );
          const result = summary.results.find((entry) => entry.name === name);
          expect(result).toBeTruthy();
          if (!result) {
            throw new Error(EXPECTED_PROOF_VALUE);
          }
          yield* Effect.matchCause(validate({ ...summary, results: [...summary.results, result] }), {
            onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/six unique/u),
            onSuccess: () => {
              throw new Error(EXPECTED_EFFECT_FAILURE);
            },
          });
          result.status = 'error';
          yield* Effect.matchCause(validate(summary), {
            onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/Malformed/u),
            onSuccess: () => {
              throw new Error(EXPECTED_EFFECT_FAILURE);
            },
          });
          result.status = 'reported';
          result.files = 0;
          yield* Effect.matchCause(validate(summary), {
            onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/Malformed/u),
            onSuccess: () => {
              throw new Error(EXPECTED_EFFECT_FAILURE);
            },
          });
        }),
      ),
      { concurrency: 'unbounded' },
    );
    const summary = clean();
    const [first] = summary.results;
    first.name = 'unknown';
    yield* Effect.matchCause(validate(summary), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/Malformed/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* Effect.all(
      ['', '{broken', 'null', '{"status":"reported","results":{}}'].map(
        Effect.fn(function* mergedScenario7(source) {
          yield* Effect.matchCause(validateQualityAuditSummary(source), {
            onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/Malformed/u),
            onSuccess: () => {
              throw new Error(EXPECTED_EFFECT_FAILURE);
            },
          });
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect(
  'invalid counts, flags, diagnostics and inconsistent coverage cannot imply clean',
  Effect.fn(function* mergedScenario12() {
    yield* Effect.all(
      names.map(
        Effect.fn(function* mergedScenario10(name) {
          yield* Effect.all(
            [-1, 0.5, null, '0', undefined, Number.NaN, Number.POSITIVE_INFINITY].map(
              Effect.fn(function* mergedScenario9(invalid) {
                const summary = clean();
                const result = summary.results.find((entry) => entry.name === name);
                expect(result).toBeTruthy();
                if (!result) {
                  throw new Error(EXPECTED_PROOF_VALUE);
                }
                Object.assign(result, { findings: invalid });
                yield* Effect.matchCause(validate(summary), {
                  onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/Malformed/u),
                  onSuccess: () => {
                    throw new Error(EXPECTED_EFFECT_FAILURE);
                  },
                });
              }),
            ),
            { concurrency: 'unbounded' },
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
    yield* Effect.all(
      [
        { advisory: true },
        { diagnostic: 'analysis failed' },
        { coverage: {} },
        { coverage: { tokenEligibleFiles: -1 } },
        { coverage: { tokenEligibleFiles: 1 } },
      ].map(
        Effect.fn(function* mergedScenario11(patch) {
          const summary = clean();
          const result = summary.results.find(({ name }) => name === 'jscpd');
          expect(result).toBeTruthy();
          if (!result) {
            throw new Error(EXPECTED_PROOF_VALUE);
          }
          Object.assign(result, patch);
          yield* Effect.matchCause(validate(summary), {
            onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/Malformed|inconsistent/u),
            onSuccess: () => {
              throw new Error(EXPECTED_EFFECT_FAILURE);
            },
          });
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect(
  'six-result duplicate and inconsistent normalization fail closed',
  Effect.fn(function* mergedScenario14() {
    const duplicate = clean();
    const [, repeated] = duplicate.results;
    duplicate.results[0] = repeated;
    yield* Effect.matchCause(validate(duplicate), {
      onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/six unique/u),
      onSuccess: () => {
        throw new Error(EXPECTED_EFFECT_FAILURE);
      },
    });
    yield* Effect.all(
      [
        ['knip', { findingCounts: {}, nativeFindingCounts: {} }],
        ['knip', { processed: 1 }],
        ['knip', { total: 3 }],
        ['knip', { workspaces: [] }],
        ['knip', { findingCounts: { exports: -1, unlisted: 0 } }],
        [FALLOW_HEALTH, { controlFlowFindings: 1 }],
        [FALLOW_HEALTH, { analyzedFunctions: 0 }],
        [FALLOW_HEALTH, { weightedFindings: 1 }],
        [FALLOW_HEALTH, { uiOnlyFindings: -1 }],
        [FALLOW_FILES, { discoveredFiles: 0 }],
      ].map(
        Effect.fn(function* mergedScenario13([name, coverage]) {
          const summary = clean();
          const result = summary.results.find((entry) => entry.name === name);
          expect(result).toBeTruthy();
          if (!result) {
            throw new Error(EXPECTED_PROOF_VALUE);
          }
          Object.assign(result.coverage, coverage);
          yield* Effect.matchCause(validate(summary), {
            onFailure: (cause) => expect(String(Cause.squash(cause))).toMatch(/Malformed|inconsistent/u),
            onSuccess: () => {
              throw new Error(EXPECTED_EFFECT_FAILURE);
            },
          });
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);
