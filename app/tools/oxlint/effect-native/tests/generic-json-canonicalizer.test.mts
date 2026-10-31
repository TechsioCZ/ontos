import path from 'node:path';
import { expect, it } from 'effect-rstest';
import { appRoot, runOxlint, testsDirectory } from './oxlint.mts';

const fixtureRoot = 'tools/oxlint/effect-native/tests/fixtures/no-native-json-stringify';
const valid = [
  `${fixtureRoot}/valid/verticals/probe/src/generic-json-snapshot.ts`,
  `${fixtureRoot}/valid/verticals/probe/src/generic-json-snapshot-with-absence.ts`,
];
const invalid = [
  `${fixtureRoot}/invalid/verticals/probe/src/mutating-json-snapshot.ts`,
  `${fixtureRoot}/invalid/verticals/probe/src/entity-guessing-json-snapshot.ts`,
  `${fixtureRoot}/invalid/verticals/probe/src/shadowed-json-snapshot.ts`,
];

it('proves generic JSON canonicalization without accepting mutation, entity keys or shadowed globals', () => {
  const run = runOxlint(
    path.join(testsDirectory, 'generic-json-canonicalizer.config.ts'),
    [...valid, ...invalid],
    appRoot,
  );
  expect(run.exitCode).toBe(1);
  expect(run.numberOfFiles).toBe(valid.length + invalid.length);
  for (const file of valid) {
    expect(
      run.diagnostics.filter((diagnostic) => diagnostic.filename.replaceAll('\\', '/').endsWith(file)),
      file,
    ).toEqual([]);
  }
  for (const file of invalid) {
    const codes = new Set(
      run.diagnostics
        .filter((diagnostic) => diagnostic.filename.replaceAll('\\', '/').endsWith(file))
        .map((diagnostic) => diagnostic.code),
    );
    expect(codes.has('effect-native(no-native-json-stringify)'), file).toBe(true);
    expect(codes.has('anti-slop(no-unknown-parameters)'), file).toBe(true);
    expect(codes.has('anti-slop(no-unknown-returns)'), file).toBe(true);
    expect(codes.has('anti-slop(no-runtime-typeof)'), file).toBe(true);
    if (file.includes('entity-guessing')) {
      expect(codes.has('effect-native(no-structural-document-walking)'), file).toBe(true);
    }
  }
});
