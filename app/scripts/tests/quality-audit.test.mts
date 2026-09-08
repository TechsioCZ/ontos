import { expect, it } from '@app/effect-rstest';

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

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { auditSteps, runQualityAudit, validateReport } from '../quality-audit.mts';

const FALLOW_CLONES = 'fallow-clones';
const FALLOW_SIMILARITY = 'fallow-similarity';
const FALLOW_HEALTH = 'fallow-health';
const CONFIG_DIRECTORY = 'quality-audit';
const REPORT_DIRECTORY = 'reports';
const KNIP_CONFIG = 'quality-audit/knip.json';
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
const stringify = (value: Schema.Json) =>
  Effect.gen(function* testEffect1() {
    return yield* Schema.encodeEffect(reportSchema)(value);
  });
const validate = (name: string, source: string) =>
  Effect.gen(function* testEffect2() {
    return yield* validateReport(name, source);
  });

it.live(
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
    expect(yield* validate('jscpd', yield* stringify(report))).toEqual({
      coverage: { tokenEligibleFiles: 2 },
      files: 2,
      findings: 1,
    });
    yield* validate('jscpd', '{}').pipe(
      Effect.flip,
      Effect.map((error) =>
        expect(() => {
          throw error;
        }).toThrow(/Malformed analyzer report/u),
      ),
    );
    yield* validate('jscpd', '{broken').pipe(
      Effect.flip,
      Effect.map((error) =>
        expect(() => {
          throw error;
        }).toThrow(/Malformed analyzer report/u),
      ),
    );
    yield* validate(
      'jscpd',
      yield* stringify({ duplicates: [], statistics: { total: { clones: 0, sources: 0 } } }),
    ).pipe(
      Effect.flip,
      Effect.map((error) =>
        expect(() => {
          throw error;
        }).toThrow(/no files/u),
      ),
    );
    yield* validate(
      'jscpd',
      yield* stringify({ ...report, statistics: { total: { clones: 0, sources: 2 } } }),
    ).pipe(
      Effect.flip,
      Effect.map((error) =>
        expect(() => {
          throw error;
        }).toThrow(/count disagrees/u),
      ),
    );
  }),
);

it.live(
  'Knip coverage is mandatory and findings count categories rather than files',
  Effect.fn(function* testEffect4() {
    const findings = yield* stringify({ issues: [] });
    const coverage = yield* stringify({
      coverage: { processed: 12, total: 12 },
      findingCounts: { exports: 4, files: 2 },
      workspaces: ['.'],
    });
    expect(yield* validate('knip', `${findings}\n${coverage}`)).toEqual({
      coverage: {
        findingCounts: { exports: 4, files: 2 },
        processed: 12,
        total: 12,
        workspaces: ['.'],
      },
      files: 12,
      findings: 6,
    });
    yield* validate('knip', findings).pipe(
      Effect.flip,
      Effect.map((error) =>
        expect(() => {
          throw error;
        }).toThrow(/coverage records/u),
      ),
    );
    yield* validate(
      'knip',
      `${findings}\n${yield* stringify({ coverage: { processed: 0, total: 0 }, findingCounts: {}, workspaces: ['.'] })}`,
    ).pipe(
      Effect.flip,
      Effect.map((error) =>
        expect(() => {
          throw error;
        }).toThrow(/no files/u),
      ),
    );
  }),
);

it.live(
  'Fallow rejects missing discovery, unsupported schema and incomplete workspaces',
  Effect.fn(function* testEffect5() {
    const report = {
      clone_groups: [],
      kind: 'dupes',
      schema_version: 9,
      stats: { clone_groups: 0, total_files: 2 },
      version: '3.22.0',
    };
    expect(yield* validate(FALLOW_CLONES, yield* stringify(report))).toEqual({
      coverage: { tokenEligibleFiles: 2 },
      files: 2,
      findings: 0,
    });
    yield* validate(FALLOW_CLONES, yield* stringify({ ...report, schema_version: 10 })).pipe(
      Effect.flip,
      Effect.map((error) =>
        expect(() => {
          throw error;
        }).toThrow(/Malformed analyzer report/u),
      ),
    );
    yield* validate(
      FALLOW_CLONES,
      yield* stringify({
        ...report,
        workspace_diagnostics: [
          { kind: 'invalid-package-json', message: 'invalid package', path: 'packages/broken' },
        ],
      }),
    ).pipe(
      Effect.flip,
      Effect.map((error) =>
        expect(() => {
          throw error;
        }).toThrow(/incomplete workspace/u),
      ),
    );
    yield* validate('fallow-files', yield* stringify({ file_count: 2, files: ['a.ts'] })).pipe(
      Effect.flip,
      Effect.map((error) =>
        expect(() => {
          throw error;
        }).toThrow(/count disagrees/u),
      ),
    );
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
    const root = mkdtempSync(path.join(tmpdir(), 'ontos-quality-test-'));
    mkdirSync(path.join(root, CONFIG_DIRECTORY));
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, '.codex'));
    writeFileSync(path.join(root, '.codex/caller-owned.txt'), 'keep');
    symlinkSync(path.join(appRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    writeFileSync(
      path.join(root, 'package.json'),
      yield* stringify({ name: 'quality-test', private: true, type: 'module' }),
    );
    for (const name of ['scope.json', 'fallow.json', 'jscpd.json', 'knip-reporter.mts']) {
      copyFileSync(
        path.join(appRoot, CONFIG_DIRECTORY, name),
        path.join(root, CONFIG_DIRECTORY, name),
      );
    }
    writeFileSync(
      path.join(root, KNIP_CONFIG),
      yield* stringify({
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
  Effect.gen(function* testEffect7() {
    return yield* runQualityAudit(root, output, tool).pipe(Effect.provide(NodeServices.layer));
  });

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
  Effect.gen(function* testEffect8() {
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SummarySchema))(
      readFileSync(path.join(output, 'summary.json'), 'utf-8'),
    );
  });

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
      yield* validate(FALLOW_HEALTH, corrupted).pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(() => {
            throw error;
          }).toThrow(/contributions disagree/u),
        ),
      );
      const wrongCount = raw.replace(
        /"functions_above_threshold"\s*:\s*\d+/u,
        '"functions_above_threshold": 0',
      );
      yield* validate(FALLOW_HEALTH, wrongCount).pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(() => {
            throw error;
          }).toThrow(/count disagrees/u),
        ),
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);

it.live(
  'primary clone detectors preserve policy literals while semantic similarity stays advisory',
  Effect.fn(function* testEffect10() {
    const root = yield* createFixture();
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
            [pair.firstFile.name, pair.secondFile.name].some(
              (name) => path.basename(name) === file,
            ),
          ),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);

it.live(
  'real pinned tools report debt successfully and isolate stale reports after invalid config',
  Effect.fn(function* testEffect12() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    try {
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
      yield* runFixture(root, output, 'knip').pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(() => {
            throw error;
          }).toThrow(/analysis failed/u),
        ),
      );
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
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);

it.live(
  'missing binaries and an empty source scope fail with preserved summaries',
  Effect.fn(function* testEffect13() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    try {
      rmSync(path.join(root, 'node_modules'));
      yield* runFixture(root, output, 'knip').pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(() => {
            throw error;
          }).toThrow(/analysis failed/u),
        ),
      );
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
        yield* stringify({ exclude: [], patterns: ['absent/**/*.ts'] }),
      );
      yield* runFixture(root, output, 'jscpd').pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(() => {
            throw error;
          }).toThrow(/analysis failed/u),
        ),
      );
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
      expect(readFileSync(path.join(output, 'summary.json'), 'utf-8')).toMatch(
        /Source inventory: analysis contains no files/u,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);

it.live(
  'the CLI handles escaped paths, foreign cwd and untracked source provenance',
  Effect.fn(function* testEffect14() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    try {
      yield* Effect.gen(function* initializeFixtureRepository() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.string(ChildProcess.make('git', ['init', '-q', root]));
      }).pipe(Effect.provide(NodeServices.layer));
      const executable = path.join(root, 'scripts/quality audit.mts');
      copyFileSync(path.join(appRoot, 'scripts/quality-audit.mts'), executable);
      for (const file of ['knip-model.mts', 'knip-runtime-model.mts']) {
        copyFileSync(
          path.join(appRoot, CONFIG_DIRECTORY, file),
          path.join(root, CONFIG_DIRECTORY, file),
        );
      }
      const result = spawnSync(
        process.execPath,
        [executable, '--tool', 'knip', '--output', output],
        {
          cwd: tmpdir(),
          encoding: 'utf-8',
          timeout: 60_000,
        },
      );
      expect(
        result.error,
        `CLI spawn failed: ${String(result.error)}\n${result.stdout}\n${result.stderr}`,
      ).toBe(undefined);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const report = yield* summary(output);
      expect(report.status).toBe('reported');
      const provenance = yield* Schema.decodeUnknownEffect(ProvenanceSchema)(
        readFileSync(path.join(report.runDirectory, 'provenance.json'), 'utf-8'),
      );
      expect(provenance.sourceState).toBe('modified');
      expect(provenance.workingTreeChanges.some((file) => file === '?? scripts/index.ts')).toBe(
        true,
      );
      expect(!provenance.workingTreeChanges.some((file) => file.startsWith('?? reports/'))).toBe(
        true,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);

it.live(
  'output inside a source root fails before creating analyzer snapshots',
  Effect.fn(function* testEffect15() {
    const root = yield* createFixture();
    const output = path.join(root, 'scripts/reports');
    try {
      yield* runFixture(root, output, 'all').pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(() => {
            throw error;
          }).toThrow(/analysis failed/u),
        ),
      );
      const report = yield* summary(output);
      expect(report.results[0]?.name).toBe('setup');
      expect(readFileSync(path.join(output, 'summary.md'), 'utf-8')).toMatch(
        /output directory outside configured source roots/u,
      );
      expect(readdirSync(report.runDirectory)).toEqual([]);
      expect(readdirSync(path.join(root, '.codex'))).toEqual([CALLER_OWNED_FILE]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);

it.live(
  'symlink output cannot place snapshots in source roots but permits report targets',
  Effect.fn(function* testEffect16() {
    const root = yield* createFixture();
    const output = path.join(root, 'reports-link');
    const sourceOutput = path.join(root, 'scripts/reports');
    const safeOutput = path.join(root, REPORT_DIRECTORY);
    try {
      mkdirSync(sourceOutput);
      symlinkSync(sourceOutput, output, 'dir');
      yield* runFixture(root, output, 'all').pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(() => {
            throw error;
          }).toThrow(/analysis failed/u),
        ),
      );
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
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);

it.live(
  'custom output does not mark clean source provenance as modified',
  Effect.fn(function* testEffect17() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    try {
      writeFileSync(path.join(root, '.gitignore'), 'node_modules\n.codex\n');
      yield* Effect.gen(function* commitFixture() {
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
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);

it.live(
  'narrowed workspace and Fallow source discovery produce coverage errors',
  Effect.fn(function* testEffect18() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    try {
      mkdirSync(path.join(root, 'packages/omitted'), { recursive: true });
      writeFileSync(
        path.join(root, 'packages/omitted/package.json'),
        yield* stringify({ name: 'omitted', private: true }),
      );
      yield* runFixture(root, output, 'knip').pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(() => {
            throw error;
          }).toThrow(/analysis failed/u),
        ),
      );
      const narrowed = yield* summary(output);
      expect(narrowed.results[0]?.status).toBe('reported');
      expect(narrowed.results.at(-1)?.name).toBe('coverage');
      expect(narrowed.results.at(-1)?.diagnostic ?? '').toMatch(
        /Knip workspace coverage mismatch/u,
      );
      expect(
        narrowed.results.some((result) => result.name === 'coverage' && result.status === 'error'),
      ).toBe(true);
      writeFileSync(
        path.join(root, 'quality-audit/fallow.json'),
        yield* stringify({ ignorePatterns: ['scripts/**', 'node_modules/**', 'packages/**'] }),
      );
      yield* runFixture(root, output, 'fallow').pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(() => {
            throw error;
          }).toThrow(/analysis failed/u),
        ),
      );
      const omitted = yield* summary(output);
      expect(
        omitted.results.some((result) => result.name === 'coverage' && result.status === 'error'),
      ).toBe(true);
      expect(readFileSync(path.join(omitted.runDirectory, 'coverage.json'), 'utf-8')).toMatch(
        /scripts\/index.ts/u,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);

it.live(
  'a selected tool with the wrong installed version fails before launch',
  Effect.fn(function* testEffect19() {
    const root = yield* createFixture();
    const output = path.join(root, REPORT_DIRECTORY);
    try {
      // Replace only the fixture's symlink; never mutate the shared installed dependencies.
      rmSync(path.join(root, 'node_modules'));
      mkdirSync(path.join(root, 'node_modules/knip/bin'), { recursive: true });
      writeFileSync(path.join(root, 'node_modules/knip/bin/knip.js'), 'must never execute');
      writeFileSync(
        path.join(root, 'node_modules/knip/package.json'),
        yield* stringify({ version: '0.0.0' }),
      );
      yield* runFixture(root, output, 'knip').pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(() => {
            throw error;
          }).toThrow(/analysis failed/u),
        ),
      );
      const mismatch = yield* summary(output);
      expect(readFileSync(path.join(mismatch.runDirectory, 'knip/metadata.json'), 'utf-8')).toMatch(
        /Expected knip 6\.34\.0, found 0\.0\.0/u,
      );
      expect(readFileSync(path.join(mismatch.runDirectory, 'knip/stdout.txt'), 'utf-8')).toBe('');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }),
);
