import { spawnSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Predicate, Schema } from 'effect';

export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const scopeRoots = ['apps', 'verticals', 'packages', 'scripts'] as const;
const testsDirectory = 'tools/oxlint/effect-native/tests';
export const maxBatchPaths = 512;

export interface Batch {
  readonly id: string;
  readonly paths: readonly string[];
}

export interface Options {
  readonly fix: boolean;
  readonly threads: number;
  readonly report?: string;
}

export function parseOptions(args: readonly string[]): Options {
  let fix = false;
  let threads = Math.max(1, availableParallelism() - 1);
  let report: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--fix') fix = true;
    else if (arg === '--format=json') continue;
    else if (arg === '--threads' || arg.startsWith('--threads=')) {
      const value = arg === '--threads' ? args[++index] : arg.slice('--threads='.length);
      if (!value || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('--threads requires a positive integer.');
      }
      threads = Number(value);
    } else if (arg === '--report' || arg.startsWith('--report=')) {
      const value = arg === '--report' ? args[++index] : arg.slice('--report='.length);
      if (!value || value.startsWith('--')) throw new Error('--report requires a path.');
      report = value;
    } else throw new Error(`Unknown workspace lint argument: ${arg}`);
  }
  return { fix, threads, ...(report === undefined ? {} : { report }) };
}

/** Partition the native-selected file list without reproducing native traversal or ignores. */
export function partitionFiles(files: readonly string[]): readonly Batch[] {
  const groups = new Map<string, string[]>();
  for (const file of [...files].sort()) {
    const parts = file.split('/');
    const id = file.startsWith(`${testsDirectory}/`)
      ? `${testsDirectory}/*.test.mts`
      : parts.length === 2
        ? `${parts[0]}/(root files)`
        : `${parts[0]}/${parts[1]}`;
    const group = groups.get(id) ?? [];
    group.push(file);
    groups.set(id, group);
  }
  const batches: Batch[] = [];
  for (const [id, paths] of groups) {
    for (let offset = 0; offset < paths.length; offset += maxBatchPaths) {
      batches.push({
        id: offset === 0 ? id : `${id}#${offset / maxBatchPaths + 1}`,
        paths: paths.slice(offset, offset + maxBatchPaths),
      });
    }
  }
  return batches;
}

export interface Diagnostic {
  readonly code?: string;
  readonly filename: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly labels: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface ChildResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal?: string | null;
  readonly error?: Error;
}

interface ChildReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly number_of_files: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function diagnostic(value: unknown): value is Diagnostic {
  if (
    !record(value) ||
    (value.code !== undefined && (typeof value.code !== 'string' || value.code.length === 0)) ||
    typeof value.filename !== 'string' ||
    value.filename.length === 0 ||
    typeof value.message !== 'string' ||
    (value.severity !== 'error' && value.severity !== 'warning') ||
    !Array.isArray(value.labels)
  )
    return false;
  return value.labels.every((label) => {
    if (!record(label) || !record(label.span)) return false;
    return (
      nonnegativeInteger(label.span.offset) &&
      nonnegativeInteger(label.span.length) &&
      nonnegativeInteger(label.span.line) &&
      label.span.line > 0 &&
      nonnegativeInteger(label.span.column) &&
      label.span.column > 0
    );
  });
}

function localFilename(cwd: string, filename: string): string {
  return relative(cwd, resolve(cwd, filename)).replaceAll('\\', '/');
}

export function parseDiscoveredFiles(result: ChildResult, cwd: string): readonly string[] {
  if (result.error || result.signal || result.status !== 0 || result.stderr !== '') {
    throw new Error(
      `Oxlint file discovery did not complete: ${result.error?.message ?? result.signal ?? result.status}; stderr=${JSON.stringify(result.stderr)}; stdout=${JSON.stringify(result.stdout)}`,
    );
  }
  const files: string[] = [];
  const unique = new Set<string>();
  const lines = result.stdout === '' ? [] : result.stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const file = localFilename(cwd, line);
    const inScope =
      scopeRoots.some((root) => file.startsWith(`${root}/`)) ||
      (file.startsWith(`${testsDirectory}/`) &&
        !file.slice(testsDirectory.length + 1).includes('/') &&
        file.endsWith('.test.mts'));
    if (!line || line.includes('\0') || !inScope || unique.has(file)) {
      throw new Error(`Oxlint file discovery returned an invalid or duplicate filename: ${JSON.stringify(line)}`);
    }
    // Validate native line framing with file metadata only; never read source contents.
    if (!statSync(resolve(cwd, line)).isFile())
      throw new Error(`Oxlint file discovery returned a non-file: ${JSON.stringify(line)}`);
    unique.add(file);
    files.push(file);
  }
  return files;
}

export function parseBatchResult(result: ChildResult, batch: Batch, cwd: string): ChildReport {
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`Oxlint did not complete ${batch.id}: ${result.error?.message ?? result.signal ?? result.status}`);
  }
  if (result.stderr.trim() !== '') throw new Error(`Oxlint stderr in ${batch.id}: ${result.stderr}`);
  // The pinned native zero-file protocol is this exact prefix followed by a JSON report.
  const emptyPrefix = 'No files found to lint. Please check your paths and ignore patterns.\n';
  const prefixed = result.stdout.startsWith(emptyPrefix);
  if (prefixed && (result.status !== 0 || result.stderr !== '')) {
    throw new Error(`Oxlint zero-file prefix contradicts exit/stderr in ${batch.id}: ${JSON.stringify(result.stdout)}`);
  }
  const payload = prefixed ? result.stdout.slice(emptyPrefix.length) : result.stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new Error(`Oxlint returned non-JSON output for ${batch.id}: ${JSON.stringify(result.stdout)}`, { cause });
  }
  // Rule totals and timing are informational and can vary with nested config.
  // Completion is established by file coverage, valid diagnostics, and the exit status.
  if (!record(parsed) || !Array.isArray(parsed.diagnostics) || !nonnegativeInteger(parsed.number_of_files))
    throw new Error(`Oxlint returned a malformed report for ${batch.id}: ${JSON.stringify(parsed)}`);
  if (prefixed && (parsed.number_of_files !== 0 || parsed.diagnostics.length !== 0)) {
    throw new Error(`Oxlint zero-file prefix contradicts its report in ${batch.id}: ${JSON.stringify(parsed)}`);
  }
  const diagnostics: Diagnostic[] = [];
  for (const value of parsed.diagnostics) {
    if (!diagnostic(value))
      throw new Error(`Oxlint returned a malformed diagnostic for ${batch.id}: ${JSON.stringify(value)}`);
    // Native parser diagnostics can omit a rule code. Infrastructure failures have their
    // own pinned message prefixes and must stop the run rather than become lint findings.
    if (
      /^(?:Error running JS plugin\.|Failed to load JS plugin:|Failed to setup JS plugins? (?:config|options):|Failed to initialize type-aware linting:)/u.test(
        value.message,
      )
    ) {
      throw new Error(`Oxlint infrastructure failure in ${batch.id}: ${JSON.stringify(value)}`);
    }
    const filename = localFilename(cwd, value.filename);
    if (!batch.paths.some((path) => filename === path || filename.startsWith(`${path}/`))) {
      throw new Error(`Oxlint reported a file outside batch ${batch.id}: ${value.filename}`);
    }
    diagnostics.push(value);
  }
  const filesWithDiagnostics = new Set(diagnostics.map((value) => localFilename(cwd, value.filename))).size;
  if (filesWithDiagnostics > parsed.number_of_files) {
    throw new Error(`Oxlint file count contradicts diagnostics in ${batch.id}.`);
  }
  const errors = diagnostics.some((value) => value.severity === 'error');
  if ((result.status === 0 && errors) || (result.status === 1 && !errors)) {
    throw new Error(`Oxlint exit status contradicts diagnostics in ${batch.id}.`);
  }
  return { diagnostics, number_of_files: parsed.number_of_files };
}

interface BatchProgress extends Batch {
  readonly complete: boolean;
  readonly number_of_files?: number;
  readonly diagnostics?: number;
  readonly exitCode?: number;
}

export interface WorkspaceReport {
  readonly complete: boolean;
  readonly exitCode: number;
  readonly scope: readonly string[];
  readonly batches: readonly BatchProgress[];
  readonly number_of_files: number;
  readonly number_of_selected_files: number;
  readonly files_with_diagnostics: number;
  readonly number_of_diagnostics: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly failure?: string;
}

export class WorkspaceLintError extends Error {
  readonly report: WorkspaceReport;

  constructor(message: string, report: WorkspaceReport, cause: unknown) {
    super(message, { cause });
    this.name = 'WorkspaceLintError';
    this.report = report;
  }
}

export const isWorkspaceLintError = Schema.is(Schema.instanceOf(WorkspaceLintError));

type RunChild = (node: string, args: readonly string[], cwd: string) => ChildResult;

export interface Runtime {
  readonly cwd?: string;
  readonly node?: string;
  readonly entryPoint?: string;
  readonly runChild?: RunChild;
}

function nativeChild(node: string, args: readonly string[], cwd: string): ChildResult {
  const result = spawnSync(node, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
  };
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** One child at a time so each compiler and AST allocation ends before the next batch. */
export function runWorkspaceLint(options: Options, runtime: Runtime = {}): WorkspaceReport {
  const cwd = resolve(runtime.cwd ?? appRoot);
  const node = runtime.node ?? process.execPath;
  const runChild = runtime.runChild ?? nativeChild;
  const progress: BatchProgress[] = [];
  const unique = new Map<string, Diagnostic>();
  let files = 0;
  let selectedFiles = 0;
  let lintExitCode = 0;
  const snapshot = (complete: boolean, failure?: string): WorkspaceReport => ({
    complete,
    exitCode: complete ? lintExitCode : 2,
    scope: [...scopeRoots, `${testsDirectory}/*.test.mts`],
    batches: [...progress],
    number_of_files: files,
    number_of_selected_files: selectedFiles,
    files_with_diagnostics: new Set([...unique.values()].map((value) => localFilename(cwd, value.filename))).size,
    number_of_diagnostics: unique.size,
    diagnostics: [...unique.values()],
    ...(failure === undefined ? {} : { failure }),
  });
  const checkpoint = (report: WorkspaceReport): void => {
    if (options.report !== undefined)
      writeFileSync(resolve(cwd, options.report), `${JSON.stringify(report, null, 2)}\n`);
  };
  let current = 'scope';
  try {
    checkpoint(snapshot(false));
    const entryPoint =
      runtime.entryPoint ??
      join(dirname(createRequire(join(cwd, 'package.json')).resolve('oxlint/package.json')), 'bin/oxlint');
    current = 'native file discovery';
    const discovered = parseDiscoveredFiles(
      runChild(
        node,
        [
          entryPoint,
          `--threads=${options.threads}`,
          '--debug=files',
          '--no-error-on-unmatched-pattern',
          ...scopeRoots,
          `${testsDirectory}/*.test.mts`,
        ],
        cwd,
      ),
      cwd,
    );
    selectedFiles = discovered.length;
    if (selectedFiles === 0) throw new Error('Oxlint skipped every file in the canonical scope.');
    const batches = partitionFiles(discovered);
    progress.push(...batches.map((batch) => ({ ...batch, complete: false })));
    checkpoint(snapshot(false));
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index];
      current = batch.id;
      const args = [
        entryPoint,
        `--threads=${options.threads}`,
        '--format=json',
        '--no-error-on-unmatched-pattern',
        ...(options.fix ? ['--fix'] : []),
        ...batch.paths,
      ];
      const result = runChild(node, args, cwd);
      const parsed = parseBatchResult(result, batch, cwd);
      if (parsed.number_of_files > batch.paths.length) {
        throw new Error(
          `Oxlint file count exceeds selected operands in ${batch.id}: ${parsed.number_of_files} > ${batch.paths.length}.`,
        );
      }
      files += parsed.number_of_files;
      lintExitCode = Math.max(lintExitCode, result.status ?? 2);
      for (const value of parsed.diagnostics) {
        unique.set(stableKey({ ...value, filename: localFilename(cwd, value.filename) }), value);
      }
      progress[index] = {
        ...batch,
        complete: true,
        number_of_files: parsed.number_of_files,
        diagnostics: parsed.diagnostics.length,
        exitCode: result.status ?? 2,
      };
      checkpoint(snapshot(false));
    }
    if (files === 0) throw new Error('Oxlint skipped every file in the canonical scope.');
    if (files !== selectedFiles)
      throw new Error(`Oxlint coverage is incomplete: selected ${selectedFiles} files but linted ${files}.`);
    const report = snapshot(true);
    checkpoint(report);
    return report;
  } catch (cause) {
    const message = `Workspace lint failed at ${current}: ${Predicate.isError(cause) ? cause.message : String(cause)}`;
    const report = snapshot(false, message);
    try {
      checkpoint(report);
    } catch (checkpointError) {
      throw new WorkspaceLintError(message, report, new AggregateError([cause, checkpointError]));
    }
    throw new WorkspaceLintError(message, report, cause);
  }
}

// Importing this module in the test project must not start linting.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const report = runWorkspaceLint(parseOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.exitCode;
  } catch (cause) {
    if (isWorkspaceLintError(cause)) process.stdout.write(`${JSON.stringify(cause.report, null, 2)}\n`);
    process.stderr.write(`${Predicate.isError(cause) ? cause.message : String(cause)}\n`);
    process.exitCode = 2;
  }
}
