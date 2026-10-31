import path from 'node:path';
import { expect, it } from 'effect-rstest';
import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';

const root = 'tools/oxlint/anti-slop/tests/fixtures/no-known-value-widening';
const valid = [
  `${root}/valid/owner-contract.ts`,
  `${root}/valid/owner-mapped-types.ts`,
  `${root}/valid/indexed-owner-types.ts`,
];
const invalid = `${root}/invalid/open-and-erased-mapped-types.ts`;

it('retains owner evidence through homomorphic maps while rejecting open dictionaries and erased values', () => {
  const run = runOxlint(path.join(testsDirectory, 'known-value-widening.config.ts'), [...valid, invalid], appRoot);
  expect(run.exitCode).toBe(1);
  expect(run.numberOfFiles).toBe(valid.length + 1);
  for (const file of valid) {
    expect(
      run.diagnostics.filter((diagnostic) => diagnostic.filename.replaceAll('\\', '/').endsWith(file)),
      file,
    ).toEqual([]);
  }
  const findings = run.diagnostics.filter((diagnostic) => diagnostic.filename.replaceAll('\\', '/').endsWith(invalid));
  expect(findings).toHaveLength(9);
  expect(findings.every((diagnostic) => diagnostic.code === 'anti-slop(no-known-value-widening)')).toBe(true);
});
