import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { fixtureConfigPath, fixturesDirectory, runOxlint } from './oxlint.mts';

const rule = 'no-effect-provide-in-library';
const cases = [
  { count: 0, file: 'valid/layer-captured-dependency.ts' },
  { count: 0, file: 'valid/layer-captured-namespace.ts' },
  { count: 0, file: 'valid/layer-captured-direct-imports.ts' },
  { count: 0, file: 'valid/layer-captured-aliased-imports.ts' },
  { count: 1, file: 'invalid/layer-capture-outside-layer.ts' },
  { count: 1, file: 'invalid/layer-capture-fake-layer.ts' },
  { count: 1, file: 'invalid/layer-capture-fake-gen.ts' },
  { count: 1, file: 'invalid/layer-capture-wrong-tag.ts' },
  { count: 1, file: 'invalid/layer-capture-other-provider.ts' },
  { count: 2, file: 'invalid/layer-capture-parameter-injection.ts' },
  { count: 3, file: 'invalid/layer-capture-mutable.ts' },
  { count: 1, file: 'invalid/layer-capture-mutated-native-alias.ts' },
  { count: 1, file: 'invalid/layer-capture-after-return.ts' },
  { count: 2, file: 'invalid/layer-capture-shadowed.ts' },
  { count: 3, file: 'invalid/layer-capture-runtime-reentry.ts' },
  { count: 2, file: 'invalid/layer-capture-not-returned-service.ts' },
];

it('allows only dependencies captured by a native Layer construction for its returned service', () => {
  const run = runOxlint(
    fixtureConfigPath(rule),
    cases.map(({ file }) => file),
    path.join(fixturesDirectory, rule),
  );
  expect(run.exitCode).toBe(1);
  expect(run.numberOfFiles).toBe(cases.length);
  let expected = 0;
  for (const { count } of cases) {
    expected += count;
  }
  expect(run.diagnostics).toHaveLength(expected);
  for (const { count, file } of cases) {
    const findings = run.diagnostics.filter(({ filename }) => filename.replaceAll('\\', '/').endsWith(file));
    expect(findings, file).toHaveLength(count);
    expect(findings.every(({ code }) => code === 'effect-native(no-effect-provide-in-library)')).toBe(true);
  }
});
