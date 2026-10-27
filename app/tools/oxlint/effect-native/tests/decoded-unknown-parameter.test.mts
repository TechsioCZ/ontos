import path from 'node:path';
import { expect, it } from 'effect-rstest';
import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';

const fixtureRoot = 'tools/oxlint/anti-slop/tests/fixtures/no-unknown-parameters';
const valid = `${fixtureRoot}/owner-boundaries.ts`;
const invalid = `${fixtureRoot}/unproved-boundaries.ts`;

it('proves owner storage/error decoders without accepting unknown, fake, opaque or escaped raw inputs', () => {
  const run = runOxlint(path.join(testsDirectory, 'decoded-unknown-parameter.config.ts'), [valid, invalid], appRoot);
  expect(run.exitCode).toBe(1);
  expect(run.numberOfFiles).toBe(2);
  expect(run.diagnostics.filter(({ filename }) => filename.replaceAll('\\', '/').endsWith(valid))).toEqual([]);
  const reports = run.diagnostics.filter(({ filename }) => filename.replaceAll('\\', '/').endsWith(invalid));
  expect(reports).toHaveLength(11);
  expect(reports.every(({ code }) => code === 'anti-slop(no-unknown-parameters)')).toBe(true);
  expect(reports.every(({ message }) => message.includes('`input`'))).toBe(true);
});

it('proves native Effect schema boundaries while retaining raw escapes and Promise counterexamples', () => {
  const validEffect = `${fixtureRoot}/native-effect-boundaries.ts`;
  const invalidEffect = `${fixtureRoot}/unproved-effect-boundaries.ts`;
  const run = runOxlint(
    path.join(testsDirectory, 'decoded-unknown-parameter.config.ts'),
    [validEffect, invalidEffect],
    appRoot,
  );
  expect(run.exitCode).toBe(1);
  expect(run.numberOfFiles).toBe(2);
  expect(run.diagnostics.filter(({ filename }) => filename.replaceAll('\\', '/').endsWith(validEffect))).toEqual([]);
  const reports = run.diagnostics.filter(({ filename }) => filename.replaceAll('\\', '/').endsWith(invalidEffect));
  expect(reports).toHaveLength(8);
  expect(reports.every(({ code }) => code === 'anti-slop(no-unknown-parameters)')).toBe(true);
  expect(reports.every(({ message }) => message.includes('`rawAction`'))).toBe(true);
});
