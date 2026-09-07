import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { runEffectTestPromise } from '../../packages/core-runtime/src/testing/effect-runtime.ts';
import { auditSteps, runQualityAudit, validateReport } from '../quality-audit.mts';

const FALLOW_CLONES = 'fallow-clones';
const FALLOW_SIMILARITY = 'fallow-similarity';
const FALLOW_HEALTH = 'fallow-health';
const CONFIG_DIRECTORY = 'quality-audit';
const REPORT_DIRECTORY = 'reports';
const KNIP_CONFIG = 'quality-audit/knip.json';
const ProvenanceSchema = Schema.fromJsonString(
  Schema.Struct({
    sourceState: Schema.String,
    workingTreeChanges: Schema.Array(Schema.String),
  }),
);
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
    ['fallow-files', FALLOW_CLONES, FALLOW_SIMILARITY, FALLOW_HEALTH],
  );
  assert.deepEqual(
    auditSteps('/app', '/output', 'knip').map((step) => step.name),
    ['knip'],
  );
  assert.equal(auditSteps('/app', '/output', 'all').length, 6);
});

const createFixture = async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ontos-quality-test-'));
  mkdirSync(path.join(root, CONFIG_DIRECTORY));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, '.codex'));
  writeFileSync(path.join(root, '.codex/caller-owned.txt'), 'keep');
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

await test('real Fallow separates UI penalties from control-flow complexity without hiding branches', async () => {
  const root = await createFixture();
  const output = path.join(root, REPORT_DIRECTORY);
  const props = Array.from({ length: 22 }, (_, index) => `p${index + 1}`).join(', ');
  const branches = Array.from(
    { length: 11 },
    (_, index) => `if (value === ${index + 1}) return ${index + 1};`,
  ).join('\n');
  try {
    writeFileSync(
      path.join(root, 'scripts/metric-example.tsx'),
      `import { useState } from 'react';
export function Panel({ ${props} }: Record<string, string>) {
  useState('one');
  useState('two');
  useState('three');
  return <div>{p1}</div>;
}
export function branchHeavy(value: number) {
  ${branches}
  return 0;
}
`,
    );
    await runFixture(root, output, 'fallow');
    const result = await summary(output);
    const healthDirectory = path.join(result.runDirectory, FALLOW_HEALTH);
    const rows = await runEffectTestPromise(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Array(
            Schema.Struct({
              controlFlowCognitive: Schema.Number,
              exceedsControlFlowLimits: Schema.Boolean,
              name: Schema.String,
              weightedCognitive: Schema.Number,
            }),
          ),
        ),
      )(readFileSync(path.join(healthDirectory, 'complexity.json'), 'utf-8')),
    );
    const panel = rows.find((row) => row.name === 'Panel');
    const branchHeavy = rows.find((row) => row.name === 'branchHeavy');
    assert.ok(panel);
    assert.equal(panel.weightedCognitive, 21);
    assert.equal(panel.controlFlowCognitive, 0);
    assert.equal(panel.exceedsControlFlowLimits, false);
    assert.equal(branchHeavy?.exceedsControlFlowLimits, true);
    const raw = readFileSync(path.join(healthDirectory, 'report.json'), 'utf-8');
    const corrupted = raw.replace(
      /(?<prefix>"cognitive"\s*:\s*)21/u,
      (_match: string, prefix: string) => `${prefix}22`,
    );
    assert.notEqual(corrupted, raw);
    await assert.rejects(validate(FALLOW_HEALTH, corrupted), /contributions disagree/u);
    const wrongCount = raw.replace(
      /"functions_above_threshold"\s*:\s*\d+/u,
      '"functions_above_threshold": 0',
    );
    await assert.rejects(validate(FALLOW_HEALTH, wrongCount), /count disagrees/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('primary clone detectors preserve policy literals while semantic similarity stays advisory', async () => {
  const root = await createFixture();
  const output = path.join(root, REPORT_DIRECTORY);
  const policyFiles = ['policy-read.ts', 'policy-write.ts'];
  try {
    for (const [index, file] of policyFiles.entries()) {
      const policy = Array.from(
        { length: 16 },
        (_, field) =>
          `decision${field}: subject === '${index === 0 ? 'role' : 'admin'}-${field}' ? '${index === 0 ? 'allow' : 'audit'}-${field}' : '${index === 0 ? 'deny' : 'defer'}-${field}'`,
      ).join(',\n');
      writeFileSync(
        path.join(root, 'scripts', file),
        `export function selectPolicy(subject: string) {\nreturn {\n${policy}\n};\n}\n`,
      );
    }
    await runFixture(root, output, 'all');
    const result = await summary(output);
    const schema = Schema.fromJsonString(
      Schema.Struct({
        clone_groups: Schema.Array(
          Schema.Struct({ instances: Schema.Array(Schema.Struct({ file: Schema.String })) }),
        ),
      }),
    );
    await Promise.all(
      [FALLOW_CLONES, FALLOW_SIMILARITY].map(async (name) => {
        const report = await runEffectTestPromise(
          Schema.decodeUnknownEffect(schema)(
            readFileSync(path.join(result.runDirectory, name, 'report.json'), 'utf-8'),
          ),
        );
        const matchesDistinctPolicies = report.clone_groups.some((group) =>
          policyFiles.every((file) =>
            group.instances.some((instance) => path.basename(instance.file) === file),
          ),
        );
        assert.equal(matchesDistinctPolicies, name === FALLOW_SIMILARITY, name);
      }),
    );
    const jscpd = await runEffectTestPromise(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            duplicates: Schema.Array(
              Schema.Struct({
                firstFile: Schema.Struct({ name: Schema.String }),
                secondFile: Schema.Struct({ name: Schema.String }),
              }),
            ),
          }),
        ),
      )(readFileSync(path.join(result.runDirectory, 'jscpd/report.json'), 'utf-8')),
    );
    assert.equal(
      jscpd.duplicates.some((pair) =>
        policyFiles.every((file) =>
          [pair.firstFile.name, pair.secondFile.name].some((name) => path.basename(name) === file),
        ),
      ),
      false,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('real pinned tools report debt successfully and isolate stale reports after invalid config', async () => {
  const root = await createFixture();
  const output = path.join(root, REPORT_DIRECTORY);
  try {
    await runFixture(root, output, 'all');
    const first = await summary(output);
    assert.deepEqual(readdirSync(path.join(root, '.codex')), ['caller-owned.txt']);
    assert.equal(first.status, 'reported');
    assert.equal(first.results.length, 6);
    for (const name of ['knip', 'jscpd', FALLOW_CLONES, FALLOW_HEALTH]) {
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
    assert.deepEqual(readdirSync(path.join(root, '.codex')), ['caller-owned.txt']);
    assert.equal(readFileSync(path.join(root, '.codex/caller-owned.txt'), 'utf-8'), 'keep');
    assert.match(
      readFileSync(path.join(output, 'summary.md'), 'utf-8'),
      /Malformed .*configs\/knip\.json/u,
    );
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
    assert.match(
      readFileSync(path.join(output, 'summary.json'), 'utf-8'),
      /Source inventory: analysis contains no files/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('the CLI handles escaped paths, foreign cwd and untracked source provenance', async () => {
  const root = await createFixture();
  const output = path.join(root, REPORT_DIRECTORY);
  try {
    await runEffectTestPromise(
      Effect.gen(function* initializeFixtureRepository() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.string(ChildProcess.make('git', ['init', '-q', root]));
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const executable = path.join(root, 'scripts/quality audit.mts');
    copyFileSync(path.join(appRoot, 'scripts/quality-audit.mts'), executable);
    for (const file of ['knip-model.mts', 'knip-runtime-model.mts']) {
      copyFileSync(
        path.join(appRoot, CONFIG_DIRECTORY, file),
        path.join(root, CONFIG_DIRECTORY, file),
      );
    }
    const result = spawnSync(process.execPath, [executable, '--tool', 'knip', '--output', output], {
      cwd: tmpdir(),
      encoding: 'utf-8',
      timeout: 60_000,
    });
    assert.equal(
      result.error,
      undefined,
      `CLI spawn failed: ${String(result.error)}\n${result.stdout}\n${result.stderr}`,
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = await summary(output);
    assert.equal(report.status, 'reported');
    const provenance = await runEffectTestPromise(
      Schema.decodeUnknownEffect(ProvenanceSchema)(
        readFileSync(path.join(report.runDirectory, 'provenance.json'), 'utf-8'),
      ),
    );
    assert.equal(provenance.sourceState, 'modified');
    assert.ok(provenance.workingTreeChanges.some((file) => file === '?? scripts/index.ts'));
    assert.ok(!provenance.workingTreeChanges.some((file) => file.startsWith('?? reports/')));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

await test('custom output does not mark clean source provenance as modified', async () => {
  const root = await createFixture();
  const output = path.join(root, REPORT_DIRECTORY);
  try {
    writeFileSync(path.join(root, '.gitignore'), 'node_modules\n.codex\n');
    await runEffectTestPromise(
      Effect.gen(function* commitFixture() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const commands = [
          ['init', '-q'],
          ['add', '.gitignore', 'package.json', CONFIG_DIRECTORY, 'scripts'],
          [
            '-c',
            `core.hooksPath=${path.join(root, '.git/no-hooks')}`,
            '-c',
            'user.name=Audit test',
            '-c',
            'user.email=audit@example.invalid',
            '-c',
            'commit.gpgSign=false',
            'commit',
            '-qm',
            'Fixture source',
          ],
        ];
        yield* Effect.forEach(
          commands,
          (args) =>
            spawner
              .exitCode(ChildProcess.make('git', args, { cwd: root }))
              .pipe(Effect.tap((code) => Effect.sync(() => assert.equal(Number(code), 0)))),
          { concurrency: 1 },
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    await runFixture(root, output, 'jscpd');
    const report = await summary(output);
    const provenance = await runEffectTestPromise(
      Schema.decodeUnknownEffect(ProvenanceSchema)(
        readFileSync(path.join(report.runDirectory, 'provenance.json'), 'utf-8'),
      ),
    );
    assert.equal(provenance.sourceState, 'clean');
    assert.deepEqual(provenance.workingTreeChanges, []);
  } finally {
    rmSync(root, { force: true, recursive: true });
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
    mkdirSync(path.join(root, 'node_modules/knip/bin'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules/knip/bin/knip.js'), 'must never execute');
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
