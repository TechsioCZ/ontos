import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { fixturesDirectory, runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const rule = 'no-effect-provide-in-library';
const rootFile = 'valid/verticals/work-tasks/scripts/prune-demo-leftovers.mts';
const libraryFile = 'invalid/verticals/work-tasks/src/services/prune-demo-leftovers.mts';
const fixtures = [
  { count: 0, file: rootFile },
  { count: 1, file: libraryFile },
];

it('allows the declared administrative CLI root while rejecting the same SDK shape in an unregistered library', () => {
  expect(readFileSync(nodePath.join(fixturesDirectory, rule, rootFile), 'utf-8')).toBe(
    readFileSync(nodePath.join(fixturesDirectory, rule, libraryFile), 'utf-8'),
  );
  withTemporaryWorkspace((directory) => {
    // Stage outside tools/** so real production rootFiles paths determine the result.
    for (const { file } of fixtures) {
      const target = nodePath.join(directory, file);
      mkdirSync(nodePath.dirname(target), { recursive: true });
      cpSync(nodePath.join(fixturesDirectory, rule, file), target);
    }
    const run = runOxlint(
      nodePath.join(testsDirectory, 'production-fixture.config.ts'),
      fixtures.map(({ file }) => file),
      directory,
      rule,
    );
    expect(run.exitCode).toBe(1);
    expect(run.numberOfFiles).toBe(fixtures.length);
    expect(run.diagnostics).toHaveLength(1);
    for (const { count, file } of fixtures) {
      const findings = run.diagnostics.filter(({ filename }) => filename.replaceAll('\\', '/').endsWith(file));
      expect(findings, file).toHaveLength(count);
      expect(findings.every(({ code }) => code === 'effect-native(no-effect-provide-in-library)')).toBe(true);
    }
  });
});
