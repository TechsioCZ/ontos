import { existsSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';

const fixtureRoot = 'tools/oxlint/anti-slop/effect/fixtures/no-service-constructor-imports/transaction-bound-factory';
const valid = ['owner.ts', 'valid-reference.ts'];
const invalid = [
  'invalid-constructor.ts',
  'invalid-escape.ts',
  'invalid-lookalike.ts',
  'invalid-eager-argument.ts',
  'invalid-handler-slot.ts',
];
const ruleCode = 'anti-slop-effect(no-service-constructor-imports)';

it('accepts Core transaction-bound factory references while rejecting constructors, escapes and foreign slots', () => {
  const files = [...valid, ...invalid].map((file) => `${fixtureRoot}/${file}`);
  for (const file of files) {
    expect(existsSync(nodePath.join(appRoot, file)), `Missing native factory fixture: ${file}`).toBe(true);
  }
  const run = runOxlint(nodePath.join(testsDirectory, 'native-service-factory-import.config.ts'), files, appRoot);
  expect(run.exitCode).toBe(1);
  expect(run.numberOfFiles).toBe(files.length);
  expect(run.diagnostics).toHaveLength(invalid.length);
  for (const file of valid) {
    const diagnostics = run.diagnostics.filter(({ filename }) =>
      filename.replaceAll('\\', '/').endsWith(`${fixtureRoot}/${file}`),
    );
    expect(diagnostics, file).toEqual([]);
  }
  for (const file of invalid) {
    const codes = run.diagnostics
      .filter(({ filename }) => filename.replaceAll('\\', '/').endsWith(`${fixtureRoot}/${file}`))
      .map(({ code }) => code);
    expect(codes, file).toEqual([ruleCode]);
  }
});
