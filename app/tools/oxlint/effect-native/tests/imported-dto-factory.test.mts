import { expect, it } from 'effect-rstest';
import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';

const fixtureRoot = 'tools/oxlint/effect-native/tests/fixtures/no-wide-factory-signature';
const valid = [
  `${fixtureRoot}/valid/packages/probe/src/imported-dto-factory.ts`,
  'verticals/facility-operations/src/routes/[lang]/provoz/bezpecnost/security-model.ts',
];
const invalid = `${fixtureRoot}/invalid/packages/probe/src/imported-non-data-factories.ts`;

it('follows imported schema DTO owners without admitting services, callables, opaque values or cycles', () => {
  const run = runOxlint(fixtureConfigPath('no-wide-factory-signature'), [...valid, invalid], appRoot);
  expect(run.exitCode).toBe(1);
  expect(run.numberOfFiles).toBe(valid.length + 1);
  for (const file of valid) {
    expect(
      run.diagnostics.filter((diagnostic) => diagnostic.filename.replaceAll('\\', '/').endsWith(file)),
      file,
    ).toEqual([]);
  }
  const findings = run.diagnostics.filter((diagnostic) => diagnostic.filename.replaceAll('\\', '/').endsWith(invalid));
  expect(findings).toHaveLength(7);
  expect(findings.every((diagnostic) => diagnostic.code === 'effect-native(no-wide-factory-signature)')).toBe(true);
});
