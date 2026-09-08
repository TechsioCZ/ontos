import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import {
  fixtureConfigPath,
  fixturesDirectory,
  listFilesRecursively,
  listFixtureRules,
  runOxlint,
} from './oxlint.mts';

const onlyRule = process.env.RULE;
const rules = listFixtureRules().filter((rule) => onlyRule === undefined || rule === onlyRule);

if (rules.length === 0) {
  it('fixtures exist', () => {
    const suffix = onlyRule === undefined || onlyRule === '' ? '' : ` for ${onlyRule}`;
    expect(rules, `No fixture directories found${suffix}.`).not.toHaveLength(0);
  });
}

const appendValidFailures = (
  fixtureDirectory: string,
  valid: readonly string[],
  byFile: ReadonlyMap<string, number>,
  failures: string[],
): void => {
  for (const file of valid) {
    const key = path.relative(fixtureDirectory, file).replaceAll('\\', '/');
    const count = byFile.get(key) ?? 0;
    if (count !== 0) {
      failures.push(`${key} must not report (false positive: ${count})`);
    }
  }
};

const fixtureFailures = (
  fixtureDirectory: string,
  invalid: readonly string[],
  valid: readonly string[],
  byFile: ReadonlyMap<string, number>,
): string[] => {
  const failures: string[] = [];
  for (const file of invalid) {
    const key = path.relative(fixtureDirectory, file).replaceAll('\\', '/');
    const count = byFile.get(key) ?? 0;
    const expected = /^\/\/\s*expect-count:\s*(?<count>\d+)/u.exec(readFileSync(file, 'utf-8'))
      ?.groups?.count;
    if (expected !== undefined) {
      if (Number(expected) <= 0 || count !== Number(expected)) {
        failures.push(`${key} expected ${expected} positive diagnostics, got ${count}`);
      }
    } else if (count === 0) {
      failures.push(`${key} expected at least one diagnostic`);
    }
  }
  appendValidFailures(fixtureDirectory, valid, byFile, failures);
  return failures;
};

for (const rule of rules) {
  it(`effect-native/${rule} fixtures`, () => {
    const fixtureDirectory = path.join(fixturesDirectory, rule);
    const invalid = listFilesRecursively(path.join(fixtureDirectory, 'invalid'));
    const valid = listFilesRecursively(path.join(fixtureDirectory, 'valid'));
    const paths = [...invalid, ...valid].map((file) => path.relative(fixtureDirectory, file));
    const run = runOxlint(fixtureConfigPath(rule), paths, fixtureDirectory);
    expect(
      !run.stderr.includes('Failed to') && !run.stderr.includes('Error'),
      `oxlint failed for ${rule}:\n${run.stderr}`,
    ).toBe(true);
    const code = `effect-native(${rule})`;
    const byFile = new Map<string, number>();
    for (const diagnostic of run.diagnostics) {
      expect(
        diagnostic.code,
        `unexpected diagnostic ${diagnostic.code} in ${diagnostic.filename}`,
      ).toBe(code);
      const key = diagnostic.filename.replaceAll('\\', '/');
      byFile.set(key, (byFile.get(key) ?? 0) + 1);
    }
    expect(invalid.length, `${rule}: add at least one file under invalid/`).toBeGreaterThan(0);
    expect(valid.length, `${rule}: add at least one file under valid/`).toBeGreaterThan(0);
    expect(run.exitCode, `${rule}: invalid fixtures must make Oxlint fail`).toBe(1);
    expect(run.numberOfFiles, `${rule}: not every fixture was linted`).toBe(
      invalid.length + valid.length,
    );
    const failures = fixtureFailures(fixtureDirectory, invalid, valid, byFile);
    expect(failures, `${rule}:\n${failures.join('\n')}`).toStrictEqual([]);
  });
}
