import { readFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import {
  fixturesDirectory,
  productionOptions,
  testEffectNativeRule,
  virtualFile,
  withOptions,
} from './rule-tester.mts';

const rule = 'no-effect-provide-in-library';
const rootFile = 'valid/verticals/work-tasks/scripts/prune-demo-leftovers.mts';
const libraryFile = 'invalid/verticals/work-tasks/src/services/prune-demo-leftovers.mts';
const fixtureCase = (file: string) => ({
  code: readFileSync(nodePath.join(fixturesDirectory, rule, file), 'utf-8'),
  filename: virtualFile(file, 'temporary'),
  ...withOptions(productionOptions(`effect-native/${rule}`)),
});

it('allows the declared administrative CLI root while rejecting the same SDK shape in an unregistered library', () => {
  expect(readFileSync(nodePath.join(fixturesDirectory, rule, rootFile), 'utf-8')).toBe(
    readFileSync(nodePath.join(fixturesDirectory, rule, libraryFile), 'utf-8'),
  );
});

testEffectNativeRule(
  rule,
  {
    invalid: [{ ...fixtureCase(libraryFile), errors: 1 }],
    valid: [fixtureCase(rootFile)],
  },
  'administrative CLI composition root under production settings',
);
