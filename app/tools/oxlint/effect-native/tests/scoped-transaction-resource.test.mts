import { expect, it } from 'effect-rstest';
import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';

const root = 'tools/oxlint/effect-native/tests/fixtures/no-sequential-independent-yields';
const fixtures = [
  { count: 0, file: 'valid/packages/probe/src/scoped-transaction-resource.ts' },
  { count: 11, file: 'invalid/packages/probe/src/unproved-transaction-resource.ts' },
  { count: 4, file: 'invalid/packages/probe/src/transaction-binding-controls.ts' },
  { count: 1, file: 'invalid/packages/probe/src/remote-after-transaction-pair.ts' },
] as const;

it('proves shared transaction queries without treating opaque or independent remote reads as ordered', () => {
  const run = runOxlint(
    fixtureConfigPath('no-sequential-independent-yields'),
    fixtures.map(({ file }) => `${root}/${file}`),
    appRoot,
  );
  expect(run.exitCode).toBe(1);
  expect(run.numberOfFiles).toBe(fixtures.length);
  for (const { count, file } of fixtures) {
    const findings = run.diagnostics.filter(({ filename }) => filename.replaceAll('\\', '/').endsWith(file));
    expect(findings, file).toHaveLength(count);
    expect(findings.every(({ code }) => code === 'effect-native(no-sequential-independent-yields)')).toBe(true);
    if (file.endsWith('remote-after-transaction-pair.ts')) {
      expect(findings[0]?.message).toContain('third');
    }
  }
});
