import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const testsDirectory = dirname(fileURLToPath(import.meta.url));
export const pluginDirectory = resolve(testsDirectory, '..');
export const appRoot = resolve(pluginDirectory, '..', '..', '..');
export const fixturesDirectory = join(testsDirectory, 'fixtures');
const oxlintBinary = join(appRoot, 'node_modules', '.bin', 'oxlint');

export interface Diagnostic {
  readonly code: string;
  readonly filename: string;
  readonly message: string;
  readonly severity: string;
  readonly labels: ReadonlyArray<{
    readonly span: { readonly line: number; readonly column: number };
  }>;
}

export interface LintRun {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
  readonly stderr: string;
  readonly numberOfFiles: number;
}

/** A crashed loader, empty run, or malformed output must never look like zero violations. */
export function parseOxlintOutput(stdout: string, stderr: string, status: number | null): LintRun {
  if (status !== 0 && status !== 1) {
    throw new Error(`Oxlint did not complete (status ${status}):\n${stderr}\n${stdout}`);
  }
  if (stderr.trim() !== '') throw new Error(`Oxlint wrote to stderr:\n${stderr}`);
  let parsed: { diagnostics?: Diagnostic[]; number_of_files?: number };
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`Oxlint did not return a JSON report:\n${stdout}`, { cause });
  }
  if (
    parsed === null ||
    !Array.isArray(parsed.diagnostics) ||
    !Number.isInteger(parsed.number_of_files) ||
    (parsed.number_of_files ?? 0) <= 0
  ) {
    throw new Error(`Oxlint returned an incomplete or empty-file report:\n${stdout}`);
  }
  for (const diagnostic of parsed.diagnostics) {
    if (
      diagnostic === null ||
      typeof diagnostic.code !== 'string' ||
      typeof diagnostic.filename !== 'string' ||
      typeof diagnostic.message !== 'string' ||
      !Array.isArray(diagnostic.labels) ||
      !['error', 'warning'].includes(diagnostic.severity)
    ) {
      throw new Error(`Oxlint returned a malformed diagnostic: ${JSON.stringify(diagnostic)}`);
    }
  }
  const hasErrors = parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if ((status === 0 && hasErrors) || (status === 1 && parsed.diagnostics.length === 0)) {
    throw new Error(`Oxlint exit status ${status} contradicts its diagnostics.`);
  }
  return {
    diagnostics: parsed.diagnostics,
    exitCode: status,
    stderr,
    numberOfFiles: parsed.number_of_files!,
  };
}

/** Run oxlint with a fixture config against the given paths (relative to `cwd`). */
export function runOxlint(
  configPath: string,
  paths: readonly string[],
  cwd: string,
  selectedRule?: string,
): LintRun {
  const fixtureRule =
    selectedRule ??
    (basename(dirname(dirname(configPath))) === 'fixtures'
      ? basename(dirname(configPath))
      : undefined);
  const result = spawnSync(
    oxlintBinary,
    ['-c', configPath, '--format=json', '--disable-nested-config', ...paths],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env, EFFECT_NATIVE_FIXTURE_RULE: fixtureRule },
    },
  );
  if (result.error)
    throw new Error(`Could not execute Oxlint: ${result.error.message}`, { cause: result.error });
  return parseOxlintOutput(result.stdout ?? '', result.stderr ?? '', result.status);
}

export function listFixtureRules(): readonly string[] {
  if (!existsSync(fixturesDirectory)) return [];
  return readdirSync(fixturesDirectory)
    .filter((entry) => statSync(join(fixturesDirectory, entry)).isDirectory())
    .sort();
}

export function listFilesRecursively(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...listFilesRecursively(full));
    else if (!entry.startsWith('.')) files.push(full);
  }
  return files.sort();
}

export function fixtureConfigPath(rule: string): string {
  return join(fixturesDirectory, rule, '.oxlintrc.json');
}

export function relativeToApp(path: string): string {
  return relative(appRoot, path).replaceAll('\\', '/');
}
