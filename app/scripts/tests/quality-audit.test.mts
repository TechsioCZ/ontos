import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { runEffectTestPromise } from '../../packages/core-runtime/src/testing/effect-runtime.ts';
import { auditSteps, runQualityAudit, validateReport } from '../quality-audit.mts';

const FALLOW_CLONES = 'fallow-clones';
const CONFIG_DIRECTORY = 'quality-audit';
const REPORT_DIRECTORY = 'reports';
const KNIP_CONFIG = 'quality-audit/knip.json';
const appRoot = path.resolve(import.meta.dirname, '../..');
const reportSchema = Schema.fromJsonString(Schema.Unknown);
const stringify = async (value: Schema.Json) =>
  await runEffectTestPromise(Schema.encodeEffect(reportSchema)(value));
const validate = async (name: string, source: string) =>
  await runEffectTestPromise(validateReport(name, source));

await test('report-only analysis accepts findings and rejects empty or malformed reports', async () => {
  const report = {
    duplicates: [
      {
        firstFile: { name: 'a.ts', start: 1 },
        lines: 12,
        secondFile: { name: 'b.ts', start: 1 },
        tokens: 110,
      },
    ],
    statistics: { total: { clones: 1, sources: 2 } },
  };
  assert.deepEqual(await validate('jscpd', await stringify(report)), {
    coverage: { tokenEligibleFiles: 2 },
    files: 2,
    findings: 1,
  });
  await assert.rejects(validate('jscpd', '{}'), /Malformed analyzer report/u);
  await assert.rejects(validate('jscpd', '{broken'), /Malformed analyzer report/u);
  await assert.rejects(
    validate(
      'jscpd',
      await stringify({ duplicates: [], statistics: { total: { clones: 0, sources: 0 } } }),
    ),
    /no files/u,
  );
  await assert.rejects(
    validate(
      'jscpd',
      await stringify({ ...report, statistics: { total: { clones: 0, sources: 2 } } }),
    ),
    /count disagrees/u,
  );
});

await test('Knip coverage is mandatory and findings count categories rather than files', async () => {
  const findings = await stringify({ issues: [] });
  const coverage = await stringify({
    coverage: { processed: 12, total: 12 },
    findingCounts: { exports: 4, files: 2 },
    workspaces: ['.'],
  });
  assert.deepEqual(await validate('knip', `${findings}\n${coverage}`), {
    coverage: {
      findingCounts: { exports: 4, files: 2 },
      processed: 12,
      total: 12,
      workspaces: ['.'],
    },
    files: 12,
    findings: 6,
  });
  await assert.rejects(validate('knip', findings), /coverage records/u);
  await assert.rejects(
    validate(
      'knip',
      `${findings}\n${await stringify({ coverage: { processed: 0, total: 0 }, findingCounts: {}, workspaces: ['.'] })}`,
    ),
    /no files/u,
  );
});

await test('Fallow rejects missing discovery, unsupported schema and incomplete workspaces', async () => {
  const report = {
    clone_groups: [],
    kind: 'dupes',
    schema_version: 9,
    stats: { clone_groups: 0, total_files: 2 },
    version: '3.22.0',
  };
  assert.deepEqual(await validate(FALLOW_CLONES, await stringify(report)), {
    coverage: { tokenEligibleFiles: 2 },
    files: 2,
    findings: 0,
  });
  await assert.rejects(
    validate(FALLOW_CLONES, await stringify({ ...report, schema_version: 10 })),
    /Malformed analyzer report/u,
  );
  await assert.rejects(
    validate(
      FALLOW_CLONES,
      await stringify({
        ...report,
        workspace_diagnostics: [
          { kind: 'invalid-package-json', message: 'invalid package', path: 'packages/broken' },
        ],
      }),
    ),
    /incomplete workspace/u,
  );
  await assert.rejects(
    validate('fallow-files', await stringify({ file_count: 2, files: ['a.ts'] })),
    /count disagrees/u,
  );
});

await test('tool selection preserves the complete Fallow group', () => {
  assert.deepEqual(
    auditSteps('/app', '/output', 'fallow').map((step) => step.name),
    ['fallow-files', FALLOW_CLONES, 'fallow-health'],
  );
  assert.deepEqual(
    auditSteps('/app', '/output', 'knip').map((step) => step.name),
    ['knip'],
  );
  assert.equal(auditSteps('/app', '/output', 'all').length, 5);
});

const createFixture = async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ontos-quality-test-'));
  mkdirSync(path.join(root, CONFIG_DIRECTORY));
  mkdirSync(path.join(root, 'scripts'));
  symlinkSync(path.join(appRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  writeFileSync(
    path.join(root, 'package.json'),
    await stringify({ name: 'quality-test', private: true, type: 'module' }),
  );
  for (const name of ['scope.json', 'fallow.json', 'jscpd.json', 'knip-reporter.mts']) {
    copyFileSync(
      path.join(appRoot, CONFIG_DIRECTORY, name),
      path.join(root, CONFIG_DIRECTORY, name),
    );
  }
  writeFileSync(
    path.join(root, KNIP_CONFIG),
    await stringify({
      entry: ['scripts/index.ts'],
      lefthook: false,
      node: false,
      project: ['scripts/**/*.ts'],
    }),
  );
  const branches = Array.from(
    { length: 15 },
    (_, index) => `if (input > ${index}) result += input * ${index};`,
  ).join('\n');
  const body = `export function calculate(input: number) {\nlet result = input;\n${branches}\nreturn result;\n}\n`;
  writeFileSync(path.join(root, 'scripts/index.ts'), body);
  writeFileSync(path.join(root, 'scripts/dead.ts'), body.replace('calculate', 'unusedCalculation'));
  return root;
};

const runFixture = async (
  root: string,
  output: string,
  tool: 'all' | 'knip' | 'jscpd' | 'fallow',
) =>
  await runEffectTestPromise(
    runQualityAudit(root, output, tool).pipe(Effect.provide(NodeServices.layer)),
  );

const SummarySchema = Schema.Struct({
  mode: Schema.Literal('report-only'),
  results: Schema.Array(
    Schema.Struct({ findings: Schema.Number, name: Schema.String, status: Schema.String }),
  ),
  runDirectory: Schema.String,
  status: Schema.String,
});
const summary = async (output: string) =>
  await runEffectTestPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(SummarySchema))(
      readFileSync(path.join(output, 'summary.json'), 'utf-8'),
    ),
  );

await test('real pinned tools report debt successfully and isolate stale reports after invalid config', async () => {
  const root = await createFixture();
  const output = path.join(root, REPORT_DIRECTORY);
  try {
    await runFixture(root, output, 'all');
    const first = await summary(output);
    assert.equal(first.status, 'reported');
    assert.equal(first.results.length, 5);
    for (const name of ['knip', 'jscpd', FALLOW_CLONES, 'fallow-health']) {
      assert.ok(
        first.results.some((row) => row.name === name && row.findings > 0),
        `${name} must report injected debt`,
      );
    }
    writeFileSync(path.join(root, 'quality-audit/jscpd.json'), '{invalid unrelated config');
    await runFixture(root, output, 'knip');
    writeFileSync(path.join(root, KNIP_CONFIG), '{invalid');
    await assert.rejects(runFixture(root, output, 'knip'), /analysis failed/u);
    const second = await summary(output);
    assert.equal(second.status, 'error');
    assert.notEqual(second.runDirectory, first.runDirectory);
    assert.equal(second.results[0]?.status, 'error');
    assert.ok(readFileSync(path.join(second.runDirectory, 'knip/stderr.txt'), 'utf-8').length > 0);
    assert.ok(
      readFileSync(path.join(first.runDirectory, 'knip/report.ndjson'), 'utf-8').length > 0,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('missing binaries and an empty source scope fail with preserved summaries', async () => {
  const root = await createFixture();
  const output = path.join(root, REPORT_DIRECTORY);
  try {
    rmSync(path.join(root, 'node_modules'));
    await assert.rejects(runFixture(root, output, 'knip'), /analysis failed/u);
    const missing = await summary(output);
    assert.equal(missing.status, 'error');
    assert.match(
      readFileSync(path.join(missing.runDirectory, 'knip/metadata.json'), 'utf-8'),
      /Missing pinned local binary/u,
    );
    writeFileSync(
      path.join(root, 'quality-audit/scope.json'),
      await stringify({ exclude: [], patterns: ['absent/**/*.ts'] }),
    );
    await assert.rejects(runFixture(root, output, 'jscpd'), /analysis failed/u);
    const empty = await summary(output);
    assert.equal(empty.results[0]?.name, 'setup');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('the CLI resolves the application root independently of invocation directory', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'ontos-quality-cwd-'));
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(appRoot, 'scripts/quality-audit.mts'), '--tool', 'knip', '--output', output],
      { cwd: tmpdir(), encoding: 'utf-8', timeout: 60_000 },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(readFileSync(path.join(output, 'summary.json'), 'utf-8'), /"reported"/u);
  } finally {
    rmSync(output, { force: true, recursive: true });
  }
});

await test('narrowed workspace and Fallow source discovery produce coverage errors', async () => {
  const root = await createFixture();
  const output = path.join(root, REPORT_DIRECTORY);
  try {
    mkdirSync(path.join(root, 'packages/omitted'), { recursive: true });
    writeFileSync(
      path.join(root, 'packages/omitted/package.json'),
      await stringify({ name: 'omitted', private: true }),
    );
    await assert.rejects(runFixture(root, output, 'knip'), /analysis failed/u);
    const narrowed = await summary(output);
    assert.ok(
      narrowed.results.some((result) => result.name === 'coverage' && result.status === 'error'),
    );
    writeFileSync(
      path.join(root, 'quality-audit/fallow.json'),
      await stringify({ ignorePatterns: ['scripts/**', 'node_modules/**', 'packages/**'] }),
    );
    await assert.rejects(runFixture(root, output, 'fallow'), /analysis failed/u);
    const omitted = await summary(output);
    assert.ok(
      omitted.results.some((result) => result.name === 'coverage' && result.status === 'error'),
    );
    assert.match(
      readFileSync(path.join(omitted.runDirectory, 'coverage.json'), 'utf-8'),
      /scripts\/index.ts/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('a selected tool with the wrong installed version fails before launch', async () => {
  const root = await createFixture();
  const output = path.join(root, REPORT_DIRECTORY);
  try {
    // Replace only the fixture's symlink; never mutate the shared installed dependencies.
    rmSync(path.join(root, 'node_modules'));
    mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules/knip'));
    writeFileSync(path.join(root, 'node_modules/.bin/knip'), 'must never execute');
    writeFileSync(
      path.join(root, 'node_modules/knip/package.json'),
      await stringify({ version: '0.0.0' }),
    );
    await assert.rejects(runFixture(root, output, 'knip'), /analysis failed/u);
    const mismatch = await summary(output);
    assert.match(
      readFileSync(path.join(mismatch.runDirectory, 'knip/metadata.json'), 'utf-8'),
      /Expected knip 6\.34\.0, found 0\.0\.0/u,
    );
    assert.equal(readFileSync(path.join(mismatch.runDirectory, 'knip/stdout.txt'), 'utf-8'), '');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
