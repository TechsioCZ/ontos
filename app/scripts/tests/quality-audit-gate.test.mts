import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { runEffectTestPromise } from '../../packages/core-runtime/src/testing/effect-runtime.ts';
import { validateQualityAuditSummary } from '../quality-audit-gate.mts';
import { validateReport } from '../quality-audit.mts';

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
const validate = async (summary: ReturnType<typeof clean> | Schema.Json) =>
  await runEffectTestPromise(encode(summary).pipe(Effect.flatMap(validateQualityAuditSummary)));

await test('complete clean summary succeeds; semantic and UI-only findings remain advisory', async () => {
  await validate(clean());
  const summary = clean();
  const semantic = summary.results.find(({ name }) => name === FALLOW_SIMILARITY);
  const health = summary.results.find(({ name }) => name === FALLOW_HEALTH);
  assert.ok(semantic && health);
  semantic.findings = 19;
  health.coverage.uiOnlyFindings = 2;
  health.coverage.weightedFindings = 2;
  await validate(summary);
});

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
await Promise.all(
  positiveReports.map(async ([name, source]) => {
    await test(`${name} real-positive analyzer report rejects through the normalized gate`, async () => {
      const normalized = await runEffectTestPromise(validateReport(name, source));
      const summary = clean();
      const result = summary.results.find((entry) => entry.name === name);
      assert.ok(result);
      Object.assign(result, normalized);
      if (name === 'knip') {
        Object.assign(result.coverage, {
          modeledUsages: 0,
          nativeFindingCounts: result.coverage.findingCounts,
        });
      }
      await assert.rejects(
        validate(summary),
        new RegExp(`Quality audit gate failed: ${name}=1`, 'u'),
      );
    });
  }),
);

await test('calibrated modeled consumers do not reintroduce native Knip findings', async () => {
  const summary = clean();
  const knip = summary.results.find(({ name }) => name === 'knip');
  assert.ok(knip);
  knip.coverage.modeledUsages = 4;
  knip.coverage.nativeFindingCounts = { exports: 0, unlisted: 4 };
  await validate(summary);
  knip.coverage.modeledUsages = 5;
  await assert.rejects(validate(summary), /inconsistent/u);
});

await test('partial, duplicate, unknown, failed and empty reports fail closed', async () => {
  await assert.rejects(validate({}), /Malformed/u);
  await assert.rejects(validate({ ...clean(), status: 'error' }), /Malformed/u);
  await assert.rejects(validate({ results: [], status: 'reported' }), /six unique/u);
  await Promise.all(
    names.map(async (name) => {
      const summary = clean();
      await assert.rejects(
        validate({ ...summary, results: summary.results.filter((entry) => entry.name !== name) }),
        /six unique/u,
      );
      const result = summary.results.find((entry) => entry.name === name);
      assert.ok(result);
      await assert.rejects(
        validate({ ...summary, results: [...summary.results, result] }),
        /six unique/u,
      );
      result.status = 'error';
      await assert.rejects(validate(summary), /Malformed/u);
      result.status = 'reported';
      result.files = 0;
      await assert.rejects(validate(summary), /Malformed/u);
    }),
  );
  const summary = clean();
  const [first] = summary.results;
  first.name = 'unknown';
  await assert.rejects(validate(summary), /Malformed/u);
  await Promise.all(
    ['', '{broken', 'null', '{"status":"reported","results":{}}'].map(async (source) => {
      await assert.rejects(runEffectTestPromise(validateQualityAuditSummary(source)), /Malformed/u);
    }),
  );
});

await test('invalid counts, flags, diagnostics and inconsistent coverage cannot imply clean', async () => {
  await Promise.all(
    names.map(async (name) => {
      await Promise.all(
        [-1, 0.5, null, '0', undefined, Number.NaN, Number.POSITIVE_INFINITY].map(
          async (invalid) => {
            const summary = clean();
            const result = summary.results.find((entry) => entry.name === name);
            assert.ok(result);
            Object.assign(result, { findings: invalid });
            await assert.rejects(validate(summary), /Malformed/u);
          },
        ),
      );
    }),
  );
  await Promise.all(
    [
      { advisory: true },
      { diagnostic: 'analysis failed' },
      { coverage: {} },
      { coverage: { tokenEligibleFiles: -1 } },
      { coverage: { tokenEligibleFiles: 1 } },
    ].map(async (patch) => {
      const summary = clean();
      const result = summary.results.find(({ name }) => name === 'jscpd');
      assert.ok(result);
      Object.assign(result, patch);
      await assert.rejects(validate(summary), /Malformed|inconsistent/u);
    }),
  );
});

await test('six-result duplicate and inconsistent normalization fail closed', async () => {
  const duplicate = clean();
  const [, repeated] = duplicate.results;
  duplicate.results[0] = repeated;
  await assert.rejects(validate(duplicate), /six unique/u);
  await Promise.all(
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
    ].map(async ([name, coverage]) => {
      const summary = clean();
      const result = summary.results.find((entry) => entry.name === name);
      assert.ok(result);
      Object.assign(result.coverage, coverage);
      await assert.rejects(validate(summary), /Malformed|inconsistent/u);
    }),
  );
});
