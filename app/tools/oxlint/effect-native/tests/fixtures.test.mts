import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

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
  test('fixtures exist', () =>
    assert.fail(`No fixture directories found${onlyRule ? ` for ${onlyRule}` : ''}.`));
}

for (const rule of rules) {
  test(`effect-native/${rule} fixtures`, () => {
    const fixtureDirectory = join(fixturesDirectory, rule);
    const invalid = listFilesRecursively(join(fixtureDirectory, 'invalid'));
    const valid = listFilesRecursively(join(fixtureDirectory, 'valid'));
    const paths = [...invalid, ...valid].map((file) => relative(fixtureDirectory, file));
    const run = runOxlint(fixtureConfigPath(rule), paths, fixtureDirectory);
    assert.ok(
      !run.stderr.includes('Failed to') && !run.stderr.includes('Error'),
      `oxlint failed for ${rule}:\n${run.stderr}`,
    );
    const code = `effect-native(${rule})`;
    const byFile = new Map<string, number>();
    for (const diagnostic of run.diagnostics) {
      assert.equal(
        diagnostic.code,
        code,
        `unexpected diagnostic ${diagnostic.code} in ${diagnostic.filename}`,
      );
      const key = diagnostic.filename.replaceAll('\\', '/');
      byFile.set(key, (byFile.get(key) ?? 0) + 1);
    }
    assert.ok(invalid.length > 0, `${rule}: add at least one file under invalid/`);
    assert.ok(valid.length > 0, `${rule}: add at least one file under valid/`);
    assert.equal(run.exitCode, 1, `${rule}: invalid fixtures must make Oxlint fail`);
    assert.equal(
      run.numberOfFiles,
      invalid.length + valid.length,
      `${rule}: not every fixture was linted`,
    );
    const failures: string[] = [];
    for (const file of invalid) {
      const key = relative(fixtureDirectory, file).replaceAll('\\', '/');
      const count = byFile.get(key) ?? 0;
      const expected = /^\/\/\s*expect-count:\s*(\d+)/u.exec(readFileSync(file, 'utf8'))?.[1];
      if (expected !== undefined) {
        if (Number(expected) <= 0 || count !== Number(expected)) {
          failures.push(`${key} expected ${expected} positive diagnostics, got ${count}`);
        }
      } else if (count === 0) {
        failures.push(`${key} expected at least one diagnostic`);
      }
    }
    for (const file of valid) {
      const key = relative(fixtureDirectory, file).replaceAll('\\', '/');
      const count = byFile.get(key) ?? 0;
      if (count !== 0) failures.push(`${key} must not report (false positive: ${count})`);
    }
    assert.deepEqual(failures, [], `${rule}:\n${failures.join('\n')}`);
  });
}
