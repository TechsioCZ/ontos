import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import nodePath from 'node:path';

import { Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  isWorkspaceLintError,
  maxBatchPaths,
  parseBatchResult,
  parseDiscoveredFiles,
  parseOptions,
  partitionFiles,
  runWorkspaceLint,
} from '../../workspace-lint.mts';
import type { ChildResult, Diagnostic, Runtime, WorkspaceLintError, WorkspaceReport } from '../../workspace-lint.mts';
import { oxlintEntryPoint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const tests = 'tools/oxlint/effect-native/tests';
const discoveryFlag = '--debug=files';
const threadsFlag = '--threads=2';
const unmatchedFlag = '--no-error-on-unmatched-pattern';
const jsonFormatFlag = '--format=json';
const fixFlag = '--fix';
const progressFile = 'progress.json';
const appInput = 'apps/one/a.ts';
const verticalInput = 'verticals/two/b.ts';
const rootInput = 'apps/root.ts';
const hiddenInput = 'apps/.hidden.ts';
const fixtureRoot = '/fixture';
const ignoredInput = 'apps/ignored/a.ts';

const CheckpointProgress = Schema.Struct({
  batches: Schema.Array(Schema.Struct({ complete: Schema.Boolean })),
  complete: Schema.Boolean,
  number_of_selected_files: Schema.Number,
});
const readCheckpointProgress = (file: string) =>
  Schema.decodeUnknownSync(CheckpointProgress)(JSON.parse(readFileSync(file, 'utf-8')));
const diagnosticIdentity = (diagnostic: Diagnostic): string =>
  JSON.stringify([diagnostic.filename, diagnostic.code, diagnostic.message, diagnostic.severity, diagnostic.labels]);
const options = { fix: false, threads: 2 };
const scope = ['apps', 'verticals', 'packages', 'scripts', `${tests}/*.test.mts`];
const emptyPrefix = 'No files found to lint. Please check your paths and ignore patterns.\n';

const put = (cwd: string, path: string, content = 'debugger;\n'): void => {
  const full = nodePath.join(cwd, path);
  mkdirSync(nodePath.dirname(full), { recursive: true });
  writeFileSync(full, content);
};

const workspace = (cwd: string, files: readonly string[] = []): void => {
  for (const directory of ['apps', 'verticals', 'packages', 'scripts', tests]) {
    mkdirSync(nodePath.join(cwd, directory), { recursive: true });
  }
  for (const file of files) {
    put(cwd, file);
  }
};

const lintDiagnostic = (filename: string, severity: 'error' | 'warning' = 'error'): Diagnostic => ({
  code: 'eslint(no-debugger)',
  filename,
  labels: [],
  message: 'Unexpected debugger statement',
  severity,
});

const result = (
  diagnostics: readonly Diagnostic[] = [],
  files = 1,
  status = diagnostics.some((d) => d.severity === 'error') ? 1 : 0,
): ChildResult => ({
  status,
  stderr: '',
  stdout: JSON.stringify({
    diagnostics,
    number_of_files: files,
    number_of_rules: 1,
    start_time: 0,
    threads_count: 2,
  }),
});

const discovery = (files: readonly string[]): ChildResult => ({
  status: 0,
  stderr: '',
  stdout: files.length === 0 ? '' : `${files.join('\n')}\n`,
});

const mockRuntime = (
  cwd: string,
  files: readonly string[],
  lint: (args: readonly string[]) => ChildResult,
): Runtime => {
  let discovered = false;
  return {
    cwd,
    entryPoint: oxlintEntryPoint,
    runChild: (_node, args, childCwd) => {
      expect(childCwd).toBe(cwd);
      if (args.includes(discoveryFlag)) {
        expect(discovered).toBe(false);
        expect(args).toEqual([oxlintEntryPoint, threadsFlag, discoveryFlag, unmatchedFlag, ...scope]);
        discovered = true;
        return discovery(files);
      }
      expect(discovered).toBe(true);
      return lint(args);
    },
  };
};

const caught = (run: () => WorkspaceReport): WorkspaceLintError => {
  try {
    run();
  } catch (error) {
    if (isWorkspaceLintError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected workspace lint to fail.');
};

it('accepts only canonical CLI controls and defaults to one fewer available CPU', () => {
  expect(parseOptions([])).toEqual({ fix: false, threads: Math.max(1, availableParallelism() - 1) });
  expect(parseOptions([fixFlag, '--threads=3', jsonFormatFlag, '--report', progressFile])).toEqual({
    fix: true,
    report: progressFile,
    threads: 3,
  });
  expect(parseOptions(['--threads', '1', '--report=progress.json']).threads).toBe(1);
  for (const args of [
    ['--threads=0'],
    ['--threads=-1'],
    ['--threads=1.5'],
    ['--threads=9007199254740992'],
    ['--threads'],
    ['--report'],
    ['--report='],
    ['--report', fixFlag],
    ['--format=stylish'],
    ['--config=other.json'],
    ['--disable-nested-config'],
    ['--filter=warning'],
    ['apps'],
    ['--'],
  ]) {
    expect(() => parseOptions(args)).toThrow();
  }
});

it('partitions only native-selected filenames without applying extension or ignore rules', () => {
  const files = [
    'apps/one/deep/source.ts',
    rootInput,
    hiddenInput,
    'apps/native-selected.bin',
    'verticals/owner/main.mts',
    'packages/shared/index.cts',
    'scripts/subtree/job.mjs',
    'scripts/root.cjs',
    `${tests}/policy.test.mts`,
  ];
  const batches = partitionFiles(files);
  expect(batches.flatMap((batch) => batch.paths).toSorted()).toEqual(files.toSorted());
  expect(batches.find((batch) => batch.id === 'apps/one')?.paths).toEqual(['apps/one/deep/source.ts']);
  expect(batches.find((batch) => batch.id === 'apps/(root files)')?.paths).toEqual([
    hiddenInput,
    'apps/native-selected.bin',
    rootInput,
  ]);
  expect(batches.find((batch) => batch.id === `${tests}/*.test.mts`)?.paths).toEqual([`${tests}/policy.test.mts`]);
  expect(partitionFiles([])).toEqual([]);
});

it('caps large nested workspaces, root files, and policy tests at the configured disjoint operand limit', () => {
  const files: string[] = [];
  for (let index = 0; index < maxBatchPaths * 2 + 7; index += 1) {
    files.push(`verticals/large/src/group-${index % 5}/deep/file-${index}.ts`);
  }
  for (let index = 0; index < maxBatchPaths + 1; index += 1) {
    files.push(`scripts/root-${index}.mts`, `${tests}/policy-${index}.test.mts`);
  }
  const batches = partitionFiles(files);
  expect(batches.every((batch) => batch.paths.length > 0 && batch.paths.length <= maxBatchPaths)).toBe(true);
  const actual = batches.flatMap((batch) => batch.paths);
  expect(actual.length).toBe(new Set(actual).size);
  expect(actual.toSorted()).toEqual(files.toSorted());
  expect(batches.filter((batch) => batch.id.startsWith('verticals/large')).length).toBe(3);
  expect(batches.filter((batch) => batch.id.startsWith('scripts/(root files)')).length).toBe(2);
  expect(batches.filter((batch) => batch.id.startsWith(tests)).length).toBe(2);
});

it('validates native file-list framing, source scope, existence, uniqueness, and discovery exit status', () => {
  withTemporaryWorkspace((cwd) => {
    const files = ['apps/one/source with spaces.ts', `${tests}/policy.test.mts`];
    workspace(cwd, [...files, 'tools/unrelated/source.ts', `${tests}/nested/excluded.test.mts`]);
    expect(parseDiscoveredFiles(discovery(files), cwd)).toEqual(files);
    expect(parseDiscoveredFiles(discovery([nodePath.join(cwd, files[0])]), cwd)).toEqual([files[0]]);
    expect(parseDiscoveredFiles(discovery([]), cwd)).toEqual([]);
    for (const bad of [
      { ...discovery(files), status: 1 },
      { ...discovery(files), status: null },
      { ...discovery(files), signal: 'SIGKILL' },
      { ...discovery(files), error: new Error('spawn failed') },
      { ...discovery(files), stderr: 'plugin failed' },
      { ...discovery(files), stderr: '\n' },
      discovery([files[0], files[0]]),
      discovery(['tools/unrelated/source.ts']),
      discovery([`${tests}/nested/excluded.test.mts`]),
      discovery(['apps/missing.ts']),
      discovery(['apps/one']),
      discovery([files[0], '', files[1]]),
      discovery(['loader failed']),
      discovery(['../outside.ts']),
    ]) {
      expect(() => parseDiscoveredFiles(bad, cwd)).toThrow();
    }
  });
});

it('uses one native discovery and sequential pinned Node children with exact args, config scope, cwd, and fix forwarding', () => {
  withTemporaryWorkspace((cwd) => {
    const files = [appInput, 'apps/one/clean.ts', verticalInput];
    workspace(cwd, files);
    const batches = partitionFiles(files);
    let discoveries = 0;
    let next = 0;
    const report = runWorkspaceLint(
      { ...options, fix: true },
      {
        cwd,
        entryPoint: oxlintEntryPoint,
        runChild: (node, args, childCwd) => {
          expect(node).toBe(process.execPath);
          expect(childCwd).toBe(cwd);
          if (args.includes(discoveryFlag)) {
            expect(args).toEqual([oxlintEntryPoint, threadsFlag, discoveryFlag, unmatchedFlag, ...scope]);
            discoveries += 1;
            return discovery(files);
          }
          expect(discoveries).toBe(1);
          expect(args).toEqual([
            oxlintEntryPoint,
            threadsFlag,
            jsonFormatFlag,
            unmatchedFlag,
            fixFlag,
            ...batches[next].paths,
          ]);
          const current = next;
          next += 1;
          return current === 0
            ? result([lintDiagnostic(files[0]), lintDiagnostic(files[0])], 2)
            : result([lintDiagnostic(files[2], 'warning')]);
        },
      },
    );
    expect(discoveries).toBe(1);
    expect(next).toBe(2);
    expect(report.complete).toBe(true);
    expect(report.exitCode).toBe(1);
    expect(report.number_of_files).toBe(3);
    expect(report.number_of_selected_files).toBe(3);
    expect(report.files_with_diagnostics).toBe(2);
    expect(report.number_of_diagnostics).toBe(2);
    expect(report.batches.every((batch) => batch.complete)).toBe(true);
  });
});

it('writes incomplete checkpoints after discovery and each batch, then a complete coverage report', () => {
  withTemporaryWorkspace((cwd) => {
    const files = [appInput, verticalInput];
    workspace(cwd, files);
    let next = 0;
    const report = runWorkspaceLint(
      { ...options, report: progressFile },
      mockRuntime(cwd, files, () => {
        const checkpoint = readCheckpointProgress(nodePath.join(cwd, progressFile));
        expect(checkpoint.complete).toBe(false);
        expect(checkpoint.number_of_selected_files).toBe(2);
        expect(checkpoint.batches.filter((batch) => batch.complete).length).toBe(next);
        next += 1;
        return result();
      }),
    );
    expect(readFileSync(nodePath.join(cwd, progressFile), 'utf-8')).toBe(`${JSON.stringify(report, null, 2)}\n`);
  });
});

it('fails an empty discovery, an all-skipped run, or any gap between selected and linted file counts', () => {
  withTemporaryWorkspace((cwd) => {
    const files = [appInput, verticalInput];
    workspace(cwd, files);
    const emptyDiscovery = caught(() =>
      runWorkspaceLint(
        options,
        mockRuntime(cwd, [], () => {
          throw new Error('No lint child expected');
        }),
      ),
    );
    expect(emptyDiscovery.message).toMatch(/skipped every file/u);
    let next = 0;
    const incomplete = caught(() =>
      runWorkspaceLint(
        options,
        mockRuntime(cwd, files, () => {
          const current = next;
          next += 1;
          return result([], current === 0 ? 0 : 1);
        }),
      ),
    );
    expect(next).toBe(2);
    expect(incomplete.report.complete).toBe(false);
    expect(incomplete.report.number_of_files).toBe(1);
    expect(incomplete.report.number_of_selected_files).toBe(2);
    expect(incomplete.message).toMatch(/coverage is incomplete/u);
    const exaggerated = caught(() =>
      runWorkspaceLint(
        options,
        mockRuntime(cwd, files, () => result([], 2)),
      ),
    );
    expect(exaggerated.message).toMatch(/exceeds selected operands/u);
    const allSkipped = caught(() =>
      runWorkspaceLint(
        options,
        mockRuntime(cwd, files, () => result([], 0)),
      ),
    );
    expect(allSkipped.report.exitCode).toBe(2);
    expect(allSkipped.message).toMatch(/skipped every file/u);
  });
});

it('aborts broken children, retains earlier diagnostics in the failed checkpoint, and starts no later batch', () => {
  withTemporaryWorkspace((cwd) => {
    const files = [appInput, 'packages/three/c.ts', verticalInput];
    workspace(cwd, files);
    for (const bad of [
      { ...result(), signal: 'SIGKILL', status: null },
      { ...result(), status: 2 },
      { ...result(), error: new Error('spawn failed') },
      { ...result(), stderr: 'plugin failed' },
      { ...result(), stdout: '' },
      { ...result(), stdout: 'loader failed\n{}' },
      { ...result(), stdout: 'null' },
      { ...result(), stdout: '{}' },
      { ...result(), stdout: '{"diagnostics":[]}' },
    ]) {
      let calls = 0;
      const failure = caught(() =>
        runWorkspaceLint(
          { ...options, report: 'failed.json' },
          mockRuntime(cwd, files, () => {
            const current = calls;
            calls += 1;
            return current === 0 ? result([lintDiagnostic(files[0])]) : bad;
          }),
        ),
      );
      expect(calls).toBe(2);
      expect(failure.report.complete).toBe(false);
      expect(failure.report.number_of_diagnostics).toBe(1);
      expect(failure.report.batches.map((batch) => batch.complete)).toEqual([true, false, false]);
      expect(readFileSync(nodePath.join(cwd, 'failed.json'), 'utf-8')).toBe(
        `${JSON.stringify(failure.report, null, 2)}\n`,
      );
    }
  });
});

it('reports exact malformed diagnostics and rejects contradictory counts, foreign filenames, and inconsistent exits', () => {
  const batch = { id: 'apps/one', paths: [appInput] };
  const valid = lintDiagnostic(appInput);
  for (const value of [
    null,
    {},
    { ...valid, code: null },
    { ...valid, code: '' },
    { ...valid, labels: null },
    { ...valid, severity: 'note' },
    { ...valid, labels: [{ span: { column: 1, line: 1 } }] },
  ]) {
    const stdout = JSON.stringify({ diagnostics: [value], number_of_files: 1 });
    try {
      parseBatchResult({ status: 1, stderr: '', stdout }, batch, fixtureRoot);
    } catch (error) {
      if (!Predicate.isError(error)) {
        throw error;
      }
      expect(error.message).toContain(JSON.stringify(value));
      continue;
    }
    throw new Error('Malformed diagnostic must fail with its exact value.');
  }
  for (const bad of [
    result([valid], 0),
    result([valid], 1, 0),
    result([], 1, 1),
    result([lintDiagnostic('verticals/other/a.ts')]),
    result([], -1),
    result([], 1.5),
  ]) {
    expect(() => parseBatchResult(bad, batch, fixtureRoot)).toThrow();
  }
});

it('accepts only the exact zero-file prefix plus successful empty JSON, retaining all-skipped failure', () => {
  const batch = { id: 'apps/ignored', paths: [ignoredInput] };
  const stdout = `${emptyPrefix}${result([], 0).stdout}\n`;
  const empty = { status: 0, stderr: '', stdout };
  expect(parseBatchResult(empty, batch, fixtureRoot)).toEqual({ diagnostics: [], number_of_files: 0 });
  for (const bad of [
    { ...empty, status: 1 },
    { ...empty, status: 2 },
    { ...empty, status: null },
    { ...empty, stderr: '\n' },
    { ...empty, stdout: emptyPrefix },
    { ...empty, stdout: `${emptyPrefix}${result([], 1).stdout}` },
    { ...empty, stdout: `${emptyPrefix}${result([lintDiagnostic(ignoredInput)]).stdout}` },
    { ...empty, stdout: `${stdout}plugin crashed` },
    { ...empty, stdout: `${emptyPrefix}plugin crashed` },
  ]) {
    expect(() => parseBatchResult(bad, batch, fixtureRoot)).toThrow();
  }
  withTemporaryWorkspace((cwd) => {
    const files = [ignoredInput];
    workspace(cwd, files);
    const failure = caught(() =>
      runWorkspaceLint(
        options,
        mockRuntime(cwd, files, () => empty),
      ),
    );
    expect(failure.report.complete).toBe(false);
    expect(failure.message).toMatch(/skipped every file/u);
  });
});

it('preserves malformed stdout bytes and accepts core reports without informational native metadata', () => {
  const batch = { id: 'apps/one', paths: [appInput] };
  const stdout = 'No files found\n\nUnexpected suffix\u001B[0m';
  let rejected = false;
  try {
    parseBatchResult({ status: 0, stderr: '', stdout }, batch, fixtureRoot);
  } catch (error) {
    rejected = true;
    if (!Predicate.isError(error)) {
      throw error;
    }
    expect(error.message).toContain(JSON.stringify(stdout));
  }
  expect(rejected).toBe(true);
  const core = { diagnostics: [lintDiagnostic(appInput)], number_of_files: 1 };
  for (const report of [core, { ...core, number_of_rules: null, start_time: 0.012, threads_count: 2 }]) {
    expect(parseBatchResult({ status: 1, stderr: '', stdout: JSON.stringify(report) }, batch, fixtureRoot)).toEqual(
      core,
    );
  }
});

it('collects uncoded syntax errors and later diagnostics while aborting explicit native infrastructure failures', () => {
  withTemporaryWorkspace((cwd) => {
    const files = ['apps/one/invalid.ts', 'verticals/two/source.ts'];
    workspace(cwd, files);
    const syntax: Diagnostic = {
      filename: files[0],
      labels: [{ span: { column: 2, length: 1, line: 1, offset: 1 } }],
      message: 'Expected a semicolon',
      severity: 'error',
    };
    let calls = 0;
    const report = runWorkspaceLint(
      options,
      mockRuntime(cwd, files, () => {
        const current = calls;
        calls += 1;
        return current === 0 ? result([syntax]) : result([lintDiagnostic(files[1])]);
      }),
    );
    expect(calls).toBe(2);
    expect(report.complete).toBe(true);
    expect(report.exitCode).toBe(1);
    expect(report.number_of_diagnostics).toBe(2);
    expect(report.diagnostics[0]).toEqual(syntax);
    for (const message of [
      'Error running JS plugin.\nFile path: /fixture/apps/one/invalid.ts\nTypeError: plugin crashed',
      'Failed to load JS plugin: missing',
      'Failed to setup JS plugins config: invalid',
      'Failed to setup JS plugin options: invalid',
      'Failed to initialize type-aware linting: unavailable',
    ]) {
      let failureCalls = 0;
      const failure = caught(() =>
        runWorkspaceLint(
          options,
          mockRuntime(cwd, files, () => {
            failureCalls += 1;
            return result([{ ...syntax, message }]);
          }),
        ),
      );
      expect(failureCalls).toBe(1);
      expect(failure.report.complete).toBe(false);
      expect(failure.report.exitCode).toBe(2);
      expect(failure.message).toContain(JSON.stringify({ ...syntax, message }));
    }
  });
});

it('matches monolithic native diagnostics and selected file counts across nested config, syntax errors, ignores, and a large workspace', () => {
  withTemporaryWorkspace((cwd) => {
    workspace(cwd);
    put(
      cwd,
      '.oxlintrc.json',
      JSON.stringify({
        categories: { correctness: 'off' },
        ignorePatterns: ['**/ignored.ts', 'verticals/ignored/**'],
        rules: { 'no-debugger': 'error' },
      }),
    );
    put(cwd, 'apps/one/.oxlintrc.json', JSON.stringify({ rules: { 'no-console': 'error', 'no-debugger': 'off' } }));
    put(cwd, 'apps/one/nested.ts', 'console.log("nested policy");\ndebugger;\n');
    for (const file of [
      'apps/two/visible.ts',
      'apps/two/ignored.ts',
      rootInput,
      hiddenInput,
      'verticals/ignored/ignored.ts',
      'packages/shared/source.ts',
      'packages/shared/node_modules/ignored/source.ts',
      'scripts/root.mts',
      `${tests}/included.test.mts`,
      `${tests}/helper.mts`,
      `${tests}/nested/excluded.test.mts`,
      'tools/unrelated/excluded.ts',
    ]) {
      put(cwd, file);
    }
    put(cwd, 'apps/two/invalid.ts', 'export const = ;\n');
    put(cwd, 'apps/metadata.json', '{"notSource":true}');
    for (let index = 0; index < maxBatchPaths + 1; index += 1) {
      put(cwd, `packages/shared/deep/parity-${index}.ts`);
    }
    const bounded = runWorkspaceLint(options, { cwd, entryPoint: oxlintEntryPoint });
    const monolithic = spawnSync(
      process.execPath,
      [oxlintEntryPoint, threadsFlag, jsonFormatFlag, unmatchedFlag, ...scope],
      { cwd, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 },
    );
    expect(monolithic.error).toBeUndefined();
    expect(monolithic.signal).toBeNull();
    const whole = parseBatchResult(
      { status: monolithic.status, stderr: monolithic.stderr, stdout: monolithic.stdout },
      { id: 'monolithic', paths: ['apps', 'verticals', 'packages', 'scripts', `${tests}/included.test.mts`] },
      cwd,
    );
    expect(bounded.complete).toBe(true);
    expect(bounded.exitCode).toBe(monolithic.status);
    expect(bounded.number_of_files).toBe(whole.number_of_files);
    expect(bounded.number_of_selected_files).toBe(whole.number_of_files);
    expect(bounded.diagnostics.map(diagnosticIdentity).toSorted()).toEqual(
      whole.diagnostics.map(diagnosticIdentity).toSorted(),
    );
    expect(bounded.diagnostics.some((d) => d.filename === 'apps/two/invalid.ts' && d.severity === 'error')).toBe(true);
    expect(
      bounded.diagnostics.some((d) => d.filename === 'apps/one/nested.ts' && d.code?.includes('no-console') === true),
    ).toBe(true);
    expect(bounded.batches.every((batch) => batch.paths.length <= maxBatchPaths)).toBe(true);
    expect(bounded.batches.filter((batch) => batch.id.startsWith('packages/shared')).length).toBe(2);
    expect(bounded.batches.flatMap((batch) => batch.paths).some((file) => file.endsWith('/ignored.ts'))).toBe(false);
  });
});
