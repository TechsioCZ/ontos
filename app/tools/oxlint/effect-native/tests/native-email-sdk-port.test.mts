import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';

const root = 'tools/oxlint/effect-native/tests/fixtures/no-promise-shaped-port';
const valid = [
  'packages/email-delivery/src/cloudflare.ts',
  `${root}/valid/packages/email-delivery/src/native-email-binding.ts`,
];
const invalid = [
  { count: 1, file: 'exported-local-mail-bypass.ts' },
  { count: 3, file: 'cloudflare.ts' },
  { count: 1, file: 'native-email-lookalike.ts' },
  { count: 1, file: 'native-email-unbridged.ts' },
  { count: 1, file: 'native-email-wrong-receiver.ts' },
];

it('keeps native email Promise types in the SDK and reports local lookalikes even after a converted call', () => {
  const files = [...valid, ...invalid.map(({ file }) => `${root}/invalid/packages/email-delivery/src/${file}`)];
  const run = runOxlint(fixtureConfigPath('no-promise-shaped-port'), files, appRoot);
  expect(run.exitCode).toBe(1);
  expect(run.numberOfFiles).toBe(files.length);
  const reportsOf = (file: string) =>
    run.diagnostics.filter(({ filename }) => {
      const normalized = filename.replaceAll('\\', '/');
      return normalized === file || normalized === `${appRoot.replaceAll('\\', '/')}/${file}`;
    });
  for (const file of valid) {
    expect(reportsOf(file), file).toEqual([]);
  }
  for (const { count, file } of invalid) {
    const suffix = `${root}/invalid/packages/email-delivery/src/${file}`;
    const findings = reportsOf(suffix);
    expect(findings, file).toHaveLength(count);
    expect(findings.every(({ code }) => code === 'effect-native(no-promise-shaped-port)')).toBe(true);
  }
});
