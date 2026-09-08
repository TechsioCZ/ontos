import { expect, it } from 'effect-rstest';

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

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { auditSteps, runQualityAudit, validateReport } from '../quality-audit.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const FALLOW_CLONES = 'fallow-clones';
const FALLOW_SIMILARITY = 'fallow-similarity';
const FALLOW_HEALTH = 'fallow-health';
const CONFIG_DIRECTORY = 'quality-audit';
const REPORT_DIRECTORY = 'reports';
const SUMMARY_FILE = 'summary.json';
const GITIGNORE_FILE = '.gitignore';
const KNIP_CONFIG = 'quality-audit/knip.json';
const PACKAGE_JSON = 'package.json';
const CALLER_OWNED_FILE = 'caller-owned.txt';
const ProvenanceSchema = Schema.fromJsonString(
  Schema.Struct({
    sourceState: Schema.String,
    workingTreeChanges: Schema.Array(Schema.String),
  }),
);
const appRoot = path.resolve(import.meta.dirname, '../..');
const includesPolicyFiles = (
  instances: readonly { readonly file: string }[],
  policyFiles: readonly string[],
) => {
  const names = new Set(instances.map((instance) => path.basename(instance.file)));
  return policyFiles.every((file) => names.has(file));
};

const reportSchema = Schema.fromJsonString(Schema.Unknown);
const encodeReport = Schema.encodeEffect(reportSchema);

it.effect(
  'report-only analysis accepts findings and rejects empty or malformed reports',
  Effect.fn(function* testEffect3() {
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
    expect(yield* validateReport('jscpd', yield* encodeReport(report))).toEqual({
      coverage: { tokenEligibleFiles: 2 },
      files: 2,
      findings: 1,
    });
    const emptyReportError = yield* Effect.flip(validateReport('jscpd', '{}'));
    expect(emptyReportError.message).toMatch(/Malformed analyzer report/u);
    const malformedReportError = yield* Effect.flip(validateReport('jscpd', '{broken'));
    expect(malformedReportError.message).toMatch(/Malformed analyzer report/u);
    const emptySourceError = yield* Effect.flip(
      validateReport(
        'jscpd',
        yield* encodeReport({ duplicates: [], statistics: { total: { clones: 0, sources: 0 } } }),
      ),
    );
    expect(emptySourceError.message).toMatch(/no files/u);
    const cloneCountError = yield* Effect.flip(
      validateReport(
        'jscpd',
        yield* encodeReport({ ...report, statistics: { total: { clones: 0, sources: 2 } } }),
      ),
    );
    expect(cloneCountError.message).toMatch(/count disagrees/u);
  }),
);

it.effect(
  'Knip coverage is mandatory and findings count categories rather than files',
  Effect.fn(function* testEffect4() {
    const findings = yield* encodeReport({ issues: [] });
    const coverage = yield* encodeReport({
      coverage: { processed: 12, total: 12 },
      findingCounts: { exports: 4, files: 2 },
      workspaces: ['.'],
    });
    expect(yield* validateReport('knip', `${findings}\n${coverage}`)).toEqual({
      coverage: {
        findingCounts: { exports: 4, files: 2 },
        processed: 12,
        total: 12,
        workspaces: ['.'],
      },
      files: 12,
      findings: 6,
    });
    const missingCoverageError = yield* Effect.flip(validateReport('knip', findings));
    expect(missingCoverageError.message).toMatch(/coverage records/u);
    const emptyCoverageError = yield* Effect.flip(
      validateReport(
        'knip',
        `${findings}\n${yield* encodeReport({ coverage: { processed: 0, total: 0 }, findingCounts: {}, workspaces: ['.'] })}`,
      ),
    );
    expect(emptyCoverageError.message).toMatch(/no files/u);
  }),
);

it.effect(
  'Fallow rejects missing discovery, unsupported schema and incomplete workspaces',
  Effect.fn(function* testEffect5() {
    const report = {
      clone_groups: [],
      kind: 'dupes',
      schema_version: 9,
      stats: { clone_groups: 0, total_files: 2 },
      version: '3.22.0',
    };
    expect(yield* validateReport(FALLOW_CLONES, yield* encodeReport(report))).toEqual({
      coverage: { tokenEligibleFiles: 2 },
      files: 2,
      findings: 0,
    });
    const unsupportedSchemaError = yield* Effect.flip(
      validateReport(FALLOW_CLONES, yield* encodeReport({ ...report, schema_version: 10 })),
    );
    expect(unsupportedSchemaError.message).toMatch(/Malformed analyzer report/u);
    const incompleteWorkspaceError = yield* Effect.flip(
      validateReport(
        FALLOW_CLONES,
        yield* encodeReport({
          ...report,
          workspace_diagnostics: [
            { kind: 'invalid-package-json', message: 'invalid package', path: 'packages/broken' },
          ],
        }),
      ),
    );
    expect(incompleteWorkspaceError.message).toMatch(/incomplete workspace/u);
    const fileCountError = yield* Effect.flip(
      validateReport('fallow-files', yield* encodeReport({ file_count: 2, files: ['a.ts'] })),
    );
    expect(fileCountError.message).toMatch(/count disagrees/u);
  }),
);

it('tool selection preserves the complete Fallow group', () => {
  expect(auditSteps('/app', '/output', 'fallow').map((step) => step.name)).toEqual([
    'fallow-files',
    FALLOW_CLONES,
    FALLOW_SIMILARITY,
    FALLOW_HEALTH,
  ]);
  expect(auditSteps('/app', '/output', 'knip').map((step) => step.name)).toEqual(['knip']);
  expect(auditSteps('/app', '/output', 'all').length).toBe(6);
});

const createFixture = () =>
  Effect.gen(function* testEffect6() {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'ontos-quality-test-'))),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    );
    mkdirSync(path.join(root, CONFIG_DIRECTORY));
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, '.codex'));
    writeFileSync(path.join(root, '.codex/caller-owned.txt'), 'keep');
    symlinkSync(path.join(appRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    writeFileSync(
      path.join(root, PACKAGE_JSON),
      yield* encodeReport({ name: 'quality-test', private: true, type: 'module' }),
    );
    for (const name of ['scope.json', 'fallow.json', 'jscpd.json', 'knip-reporter.mts']) {
      copyFileSync(
        path.join(appRoot, CONFIG_DIRECTORY, name),
        path.join(root, CONFIG_DIRECTORY, name),
      );
    }
    writeFileSync(
      path.join(root, KNIP_CONFIG),
      yield* encodeReport({
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
    writeFileSync(
      path.join(root, 'scripts/dead.ts'),
      body.replace('calculate', 'unusedCalculation'),
    );
    return root;
  });

const runFixture = (root: string, output: string, tool: 'all' | 'knip' | 'jscpd' | 'fallow') =>
  runQualityAudit(root, output, tool).pipe(Effect.provide(NodeServices.layer));

const SummarySchema = Schema.Struct({
  mode: Schema.Literal('report-only'),
  results: Schema.Array(
    Schema.Struct({
      coverage: Schema.Record(Schema.String, Schema.Json),
      diagnostic: Schema.String,
      directory: Schema.String,
      files: Schema.Number,
      findings: Schema.Number,
      name: Schema.String,
      status: Schema.String,
    }),
  ),
  runDirectory: Schema.String,
  status: Schema.String,
});
const summary = (output: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(SummarySchema))(
    readFileSync(path.join(output, SUMMARY_FILE), 'utf-8'),
  );

it.live(
  'real Fallow separates UI penalties from control-flow complexity without hiding branches',
  Effect.fn(function* testEffect9() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    const props = Array.from({ length: 22 }, (_, index) => `p${index + 1}`).join(', ');
    const branches = Array.from(
      { length: 11 },
      (_, index) => `if (value === ${index + 1}) return ${index + 1};`,
    ).join('\n');
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
    yield* runFixture(root, output, 'fallow');
    const result = yield* summary(output);
    const healthDirectory = path.join(result.runDirectory, FALLOW_HEALTH);
    const rows = yield* Schema.decodeUnknownEffect(
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
    )(readFileSync(path.join(healthDirectory, 'complexity.json'), 'utf-8'));
    const panel = rows.find((row) => row.name === 'Panel');
    const branchHeavy = rows.find((row) => row.name === 'branchHeavy');
    expect(panel).toBeDefined();
    if (panel === undefined) {
      throw new Error('Expected panel to be present');
    }
    expect(panel.weightedCognitive).toBe(21);
    expect(panel.controlFlowCognitive).toBe(0);
    expect(panel.exceedsControlFlowLimits).toBe(false);
    expect(branchHeavy?.exceedsControlFlowLimits).toBe(true);
    const raw = readFileSync(path.join(healthDirectory, 'report.json'), 'utf-8');
    const corrupted = raw.replace(
      /(?<prefix>"cognitive"\s*:\s*)21/u,
      (_match: string, prefix: string) => `${prefix}22`,
    );
    expect(corrupted).not.toBe(raw);
    const contributionsError = yield* Effect.flip(validateReport(FALLOW_HEALTH, corrupted));
    expect(contributionsError.message).toMatch(/contributions disagree/u);
    const wrongCount = raw.replace(
      /"functions_above_threshold"\s*:\s*\d+/u,
      '"functions_above_threshold": 0',
    );
    const thresholdCountError = yield* Effect.flip(validateReport(FALLOW_HEALTH, wrongCount));
    expect(thresholdCountError.message).toMatch(/count disagrees/u);
  }),
);

it.live(
  'primary clone detectors preserve policy literals while semantic similarity stays advisory',
  Effect.fn(function* testEffect10() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    const policyFiles = ['policy-read.ts', 'policy-write.ts'];
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
    yield* runFixture(root, output, 'all');
    const result = yield* summary(output);
    const schema = Schema.fromJsonString(
      Schema.Struct({
        clone_groups: Schema.Array(
          Schema.Struct({ instances: Schema.Array(Schema.Struct({ file: Schema.String })) }),
        ),
      }),
    );
    yield* Effect.all(
      [FALLOW_CLONES, FALLOW_SIMILARITY].map((name) =>
        Effect.gen(function* testEffect11() {
          const report = yield* Schema.decodeUnknownEffect(schema)(
            readFileSync(path.join(result.runDirectory, name, 'report.json'), 'utf-8'),
          );
          const matchesDistinctPolicies = report.clone_groups.some((group) =>
            includesPolicyFiles(group.instances, policyFiles),
          );
          expect(matchesDistinctPolicies, name).toBe(name === FALLOW_SIMILARITY);
        }),
      ),
      { concurrency: 'unbounded' },
    );
    const jscpd = yield* Schema.decodeUnknownEffect(
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
    )(readFileSync(path.join(result.runDirectory, 'jscpd/report.json'), 'utf-8'));
    expect(
      jscpd.duplicates.some((pair) =>
        policyFiles.every((file) =>
          [pair.firstFile.name, pair.secondFile.name].some((name) => path.basename(name) === file),
        ),
      ),
    ).toBe(false);
  }),
);

it.live(
  'real pinned tools report debt successfully and isolate stale reports after invalid config',
  Effect.fn(function* testEffect12() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    yield* runFixture(root, output, 'all');
    const first = yield* summary(output);
    expect(readdirSync(path.join(root, '.codex'))).toEqual([CALLER_OWNED_FILE]);
    expect(first.status).toBe('reported');
    expect(first.results.length).toBe(6);
    for (const name of ['knip', 'jscpd', FALLOW_CLONES, FALLOW_HEALTH]) {
      expect(
        first.results.some((row) => row.name === name && row.findings > 0),
        `${name} must report injected debt`,
      ).toBe(true);
    }
    writeFileSync(path.join(root, 'quality-audit/jscpd.json'), '{invalid unrelated config');
    yield* runFixture(root, output, 'knip');
    writeFileSync(path.join(root, KNIP_CONFIG), '{invalid');
    const invalidConfigError = yield* Effect.flip(runFixture(root, output, 'knip'));
    expect(invalidConfigError.message).toMatch(/analysis failed/u);
    const second = yield* summary(output);
    expect(second.status).toBe('error');
    expect(second.runDirectory).not.toBe(first.runDirectory);
    expect(second.results[0]?.status).toBe('error');
    expect(readdirSync(path.join(root, '.codex'))).toEqual([CALLER_OWNED_FILE]);
    expect(readFileSync(path.join(root, '.codex/caller-owned.txt'), 'utf-8')).toBe('keep');
    expect(readFileSync(path.join(output, 'summary.md'), 'utf-8')).toMatch(
      /Malformed .*configs\/knip\.json/u,
    );
    expect(
      readFileSync(path.join(first.runDirectory, 'knip/report.ndjson'), 'utf-8').length > 0,
    ).toBe(true);
  }),
);

it.live(
  'missing binaries and an empty source scope fail with preserved summaries',
  Effect.fn(function* testEffect13() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    rmSync(path.join(root, 'node_modules'));
    const missingBinaryError = yield* Effect.flip(runFixture(root, output, 'knip'));
    expect(missingBinaryError.message).toMatch(/analysis failed/u);
    const missing = yield* summary(output);
    expect(missing.status).toBe('error');
    const failedDirectory = path.join(missing.runDirectory, 'knip');
    expect(missing.results).toEqual([
      {
        coverage: {},
        diagnostic: readFileSync(
          path.join(failedDirectory, 'validation-error.txt'),
          'utf-8',
        ).trimEnd(),
        directory: failedDirectory,
        files: 0,
        findings: 0,
        name: 'knip',
        status: 'error',
      },
    ]);
    expect(readFileSync(path.join(missing.runDirectory, 'knip/metadata.json'), 'utf-8')).toMatch(
      /Missing pinned local binary/u,
    );
    writeFileSync(
      path.join(root, 'quality-audit/scope.json'),
      yield* encodeReport({ exclude: [], patterns: ['absent/**/*.ts'] }),
    );
    const emptyScopeError = yield* Effect.flip(runFixture(root, output, 'jscpd'));
    expect(emptyScopeError.message).toMatch(/analysis failed/u);
    const empty = yield* summary(output);
    expect(empty.results).toEqual([
      {
        coverage: {},
        diagnostic: 'QualityAuditError: Source inventory: analysis contains no files',
        directory: empty.runDirectory,
        files: 0,
        findings: 0,
        name: 'setup',
        status: 'error',
      },
    ]);
    expect(readFileSync(path.join(output, SUMMARY_FILE), 'utf-8')).toMatch(
      /Source inventory: analysis contains no files/u,
    );
  }),
);

it.live(
  'the CLI handles forced CI colors, escaped paths, foreign cwd and untracked source provenance',
  Effect.fn(function* testEffect14() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    yield* Effect.gen(function* initializeFixtureRepository() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* spawner.string(ChildProcess.make('git', ['init', '-q', root]));
    }).pipe(Effect.provide(NodeServices.layer));
    mkdirSync(path.join(root, 'scripts/shared'), { recursive: true });
    copyFileSync(
      path.join(appRoot, 'scripts/shared/ultramodern-wrapper-source.mts'),
      path.join(root, 'scripts/shared/ultramodern-wrapper-source.mts'),
    );
    const executable = path.join(root, 'scripts/quality audit.mts');
    copyFileSync(path.join(appRoot, 'scripts/quality-audit.mts'), executable);
    copyFileSync(
      path.join(appRoot, 'scripts/quality-cli-lifecycle.mts'),
      path.join(root, 'scripts/quality-cli-lifecycle.mts'),
    );
    for (const file of ['knip-model.mts', 'knip-runtime-model.mts']) {
      copyFileSync(
        path.join(appRoot, CONFIG_DIRECTORY, file),
        path.join(root, CONFIG_DIRECTORY, file),
      );
    }
    const result = yield* collectToolingProcess(
      ChildProcess.make(process.execPath, [executable, '--tool', 'knip', '--output', output], {
        cwd: tmpdir(),
        env: { CI: 'true', FORCE_COLOR: '1', GITHUB_ACTIONS: 'true', NO_COLOR: '1' },
        extendEnv: true,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      }),
    ).pipe(Effect.scoped, Effect.timeout('60 seconds'), Effect.provide(NodeServices.layer));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = yield* summary(output);
    expect(report.status).toBe('reported');
    expect(readFileSync(path.join(report.runDirectory, 'knip/stderr.txt'), 'utf-8')).toBe('');
    const provenance = yield* Schema.decodeUnknownEffect(ProvenanceSchema)(
      readFileSync(path.join(report.runDirectory, 'provenance.json'), 'utf-8'),
    );
    expect(provenance.sourceState).toBe('modified');
    expect(provenance.workingTreeChanges.some((file) => file === '?? scripts/index.ts')).toBe(true);
    expect(!provenance.workingTreeChanges.some((file) => file.startsWith('?? reports/'))).toBe(
      true,
    );
  }),
);

it.live(
  'output inside a source root fails before creating analyzer snapshots',
  Effect.fn(function* testEffect15() {
    const root = yield* createFixture();
    const output = path.join(root, 'scripts/reports');
    const sourceOutputError = yield* Effect.flip(runFixture(root, output, 'all'));
    expect(sourceOutputError.message).toMatch(/analysis failed/u);
    const report = yield* summary(output);
    expect(report.results[0]?.name).toBe('setup');
    expect(readFileSync(path.join(output, 'summary.md'), 'utf-8')).toMatch(
      /output directory outside configured source roots/u,
    );
    expect(readdirSync(report.runDirectory)).toEqual([]);
    expect(readdirSync(path.join(root, '.codex'))).toEqual([CALLER_OWNED_FILE]);
  }),
);

it.live(
  'symlink output cannot place snapshots in source roots but permits report targets',
  Effect.fn(function* testEffect16() {
    const root = yield* createFixture();
    const output = path.join(root, 'reports-link');
    const sourceOutput = path.join(root, 'scripts/reports');
    const safeOutput = path.join(root, REPORT_DIRECTORY);
    mkdirSync(sourceOutput);
    symlinkSync(sourceOutput, output, 'dir');
    const symlinkOutputError = yield* Effect.flip(runFixture(root, output, 'all'));
    expect(symlinkOutputError.message).toMatch(/analysis failed/u);
    const rejected = yield* summary(output);
    expect(rejected.results[0]?.name).toBe('setup');
    expect(rejected.results[0]?.diagnostic ?? '').toMatch(
      /output directory outside configured source roots/u,
    );
    expect(readdirSync(rejected.runDirectory)).toEqual([]);
    expect(readdirSync(path.join(root, '.codex'))).toEqual([CALLER_OWNED_FILE]);

    rmSync(output);
    mkdirSync(safeOutput);
    symlinkSync(safeOutput, output, 'dir');
    yield* runFixture(root, output, 'jscpd');
    const accepted = yield* summary(output);
    expect(accepted.status).toBe('reported');
  }),
);

it.live(
  'custom output does not mark clean source provenance as modified',
  Effect.fn(function* testEffect17() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    writeFileSync(path.join(root, GITIGNORE_FILE), 'node_modules\n.codex\n');
    yield* Effect.gen(function* commitFixture() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const commands = [
        ['init', '-q'],
        ['add', GITIGNORE_FILE, PACKAGE_JSON, CONFIG_DIRECTORY, 'scripts'],
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
            .pipe(Effect.map((code) => expect(Number(code)).toBe(0))),
        { concurrency: 1 },
      );
    }).pipe(Effect.provide(NodeServices.layer));
    yield* runFixture(root, output, 'jscpd');
    const report = yield* summary(output);
    const provenance = yield* Schema.decodeUnknownEffect(ProvenanceSchema)(
      readFileSync(path.join(report.runDirectory, 'provenance.json'), 'utf-8'),
    );
    expect(provenance.sourceState).toBe('clean');
    expect(provenance.workingTreeChanges).toEqual([]);
  }),
);

it.live(
  'narrowed workspace and Fallow source discovery produce coverage errors',
  Effect.fn(function* testEffect18() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    mkdirSync(path.join(root, 'packages/omitted'), { recursive: true });
    writeFileSync(
      path.join(root, 'packages/omitted/package.json'),
      yield* encodeReport({ name: 'omitted', private: true }),
    );
    const narrowedWorkspaceError = yield* Effect.flip(runFixture(root, output, 'knip'));
    expect(narrowedWorkspaceError.message).toMatch(/analysis failed/u);
    const narrowed = yield* summary(output);
    expect(narrowed.results[0]?.status).toBe('reported');
    expect(narrowed.results.at(-1)?.name).toBe('coverage');
    expect(narrowed.results.at(-1)?.diagnostic ?? '').toMatch(/Knip workspace coverage mismatch/u);
    expect(
      narrowed.results.some((result) => result.name === 'coverage' && result.status === 'error'),
    ).toBe(true);
    writeFileSync(
      path.join(root, 'quality-audit/fallow.json'),
      yield* encodeReport({ ignorePatterns: ['scripts/**', 'node_modules/**', 'packages/**'] }),
    );
    const omittedSourceError = yield* Effect.flip(runFixture(root, output, 'fallow'));
    expect(omittedSourceError.message).toMatch(/analysis failed/u);
    const omitted = yield* summary(output);
    expect(
      omitted.results.some((result) => result.name === 'coverage' && result.status === 'error'),
    ).toBe(true);
    expect(readFileSync(path.join(omitted.runDirectory, 'coverage.json'), 'utf-8')).toMatch(
      /scripts\/index.ts/u,
    );
  }),
);

it.live(
  'a selected tool with the wrong installed version fails before launch',
  Effect.fn(function* testEffect19() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    // Replace only the fixture's symlink; never mutate the shared installed dependencies.
    rmSync(path.join(root, 'node_modules'));
    mkdirSync(path.join(root, 'node_modules/knip/bin'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules/knip/bin/knip.js'), 'must never execute');
    writeFileSync(
      path.join(root, 'node_modules/knip/package.json'),
      yield* encodeReport({ version: '0.0.0' }),
    );
    const versionError = yield* Effect.flip(runFixture(root, output, 'knip'));
    expect(versionError.message).toMatch(/analysis failed/u);
    const mismatch = yield* summary(output);
    expect(readFileSync(path.join(mismatch.runDirectory, 'knip/metadata.json'), 'utf-8')).toMatch(
      /Expected knip 6\.34\.0, found 0\.0\.0/u,
    );
    expect(readFileSync(path.join(mismatch.runDirectory, 'knip/stdout.txt'), 'utf-8')).toBe('');
  }),
);

it.live(
  'jscpd accepts only its config banner and preserves additional diagnostics on failure',
  Effect.fn(function* testAnalyzerDiagnostics() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    // Replace only the fixture symlink, retaining the real installed tools unchanged.
    rmSync(path.join(root, 'node_modules'));
    const toolDirectory = path.join(root, 'node_modules/jscpd');
    mkdirSync(toolDirectory, { recursive: true });
    writeFileSync(
      path.join(toolDirectory, PACKAGE_JSON),
      yield* encodeReport({ type: 'module', version: '5.1.2' }),
    );
    const report = yield* encodeReport({
      duplicates: [],
      statistics: { total: { clones: 0, sources: 2 } },
    });
    const warning = 'Warning: unable to parse scripts/dead.ts';
    for (const diagnostic of ['', `${warning}\n`]) {
      writeFileSync(
        path.join(toolDirectory, 'run-jscpd.js'),
        [
          "import { writeFileSync } from 'node:fs';",
          "import path from 'node:path';",
          "console.error('Using config from ' + process.argv[3]);",
          `process.stderr.write(${JSON.stringify(diagnostic)});`,
          `writeFileSync(path.join(process.argv[5], 'jscpd-report.json'), ${JSON.stringify(report)});`,
        ].join('\n'),
      );
      if (diagnostic) {
        const issue = yield* Effect.flip(runFixture(root, output, 'jscpd'));
        expect(issue.message).toMatch(/analysis failed/u);
      } else {
        yield* runFixture(root, output, 'jscpd');
      }
      const result = yield* summary(output);
      const directory = path.join(result.runDirectory, 'jscpd');
      expect(result.status).toBe(diagnostic ? 'error' : 'reported');
      expect(readFileSync(path.join(directory, 'stderr.txt'), 'utf-8')).toBe(
        `Using config from ${result.runDirectory}/jscpd.config.json\n${diagnostic}`,
      );
      expect(readFileSync(path.join(directory, 'jscpd-report.json'), 'utf-8')).toBe(report);
      if (diagnostic) {
        expect(result.results[0]?.diagnostic).toMatch(/Analyzer emitted diagnostics/u);
        expect(readFileSync(path.join(directory, 'validation-error.txt'), 'utf-8')).toMatch(
          /Analyzer emitted diagnostics/u,
        );
      }
    }
  }),
);

it.live('external report directories preserve valid Fallow exclusions and source coverage', () =>
  Effect.gen(function* externalReportDirectory() {
    const root = yield* createFixture();
    const output = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'ontos-external-report-'))),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    );
    const generatedTypes = path.join(root, 'apps/shell/@mf-types/remote');
    mkdirSync(generatedTypes, { recursive: true });
    writeFileSync(path.join(root, GITIGNORE_FILE), '**/@mf-types/\n');
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const initialized = yield* spawner.exitCode(
      ChildProcess.make('git', ['init', '-q'], { cwd: root }),
    );
    expect(Number(initialized)).toBe(0);
    writeFileSync(
      path.join(generatedTypes, 'index.d.ts'),
      'export declare const remoteComponent: unknown;\n',
    );
    yield* runQualityAudit(root, output, 'fallow');
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SummarySchema))(
      readFileSync(path.join(output, SUMMARY_FILE), 'utf-8'),
    );
    expect(result.status).toBe('reported');
    expect(result.results.length).toBe(4);
    expect(result.results.every((row) => row.status === 'reported' && row.files > 0)).toBeTruthy();
    const coverage = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          extra: Schema.Array(Schema.String),
          intendedSources: Schema.Number,
          missing: Schema.Array(Schema.String),
        }),
      ),
    )(readFileSync(path.join(result.runDirectory, 'coverage.json'), 'utf-8'));
    // Two authored fixture sources plus the copied Knip reporter, not remote declarations.
    expect(coverage).toEqual({ extra: [], intendedSources: 3, missing: [] });
    expect(
      result.results.some((row) => row.name === FALLOW_HEALTH && row.findings > 0),
    ).toBeTruthy();
    expect(readFileSync(path.join(result.runDirectory, 'configs/fallow.json'), 'utf-8')).toBe(
      readFileSync(path.join(root, 'quality-audit/fallow.json'), 'utf-8'),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
