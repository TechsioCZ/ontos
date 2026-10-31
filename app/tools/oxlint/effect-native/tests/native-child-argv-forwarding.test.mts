import { expect, it } from 'effect-rstest';
import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';

const fixtureRoot = 'tools/oxlint/effect-native/tests/fixtures/no-ad-hoc-argv-in-scripts';
const valid = [
  'scripts/demo/seed-siampark-ops.mts',
  `${fixtureRoot}/valid/scripts/native-child-forwarder.mts`,
  `${fixtureRoot}/valid/scripts/native-child-forwarding-alias.mts`,
];
const invalid = [
  { count: 1, file: 'native-child-filtered-argv.mts' },
  { count: 1, file: 'native-child-mapped-argv.mts' },
  { count: 1, file: 'unknown-child-argv-forwarding.mts' },
  { count: 1, file: 'fake-child-argv-forwarding.mts' },
  { count: 1, file: 'shadowed-child-argv-forwarding.mts' },
  { count: 1, file: 'native-child-stored-slice.mts' },
  { count: 1, file: 'native-child-changed-argv.mts' },
  { count: 1, file: 'native-child-partial-slice.mts' },
  { count: 2, file: 'native-child-interpreted-argv.mts' },
  { count: 1, file: 'shadowed-process-forwarding-control.mts' },
];

it('proves verbatim native child forwarding and retains modified, opaque and shadowed controls', () => {
  const paths = [...valid, ...invalid.map(({ file }) => `${fixtureRoot}/invalid/scripts/${file}`)];
  const run = runOxlint(fixtureConfigPath('no-ad-hoc-argv-in-scripts'), paths, appRoot);
  expect(run.exitCode).toBe(1);
  expect(run.numberOfFiles).toBe(paths.length);
  for (const file of valid) {
    expect(
      run.diagnostics.filter(({ filename }) => filename.replaceAll('\\', '/').endsWith(file)),
      file,
    ).toEqual([]);
  }
  for (const { count, file } of invalid) {
    const reports = run.diagnostics.filter(({ filename }) => filename.replaceAll('\\', '/').endsWith(file));
    expect(reports, file).toHaveLength(count);
    expect(reports.every(({ code }) => code === 'effect-native(no-ad-hoc-argv-in-scripts)')).toBe(true);
  }
});
