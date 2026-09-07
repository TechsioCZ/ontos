import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { appRoot, pluginDirectory, runOxlint } from './oxlint.mts';

test('all repository source, including tools and root configuration, follows the Effect discrimination policy', () => {
  const run = runOxlint(
    join(pluginDirectory, 'repository-policy.config.ts'),
    ['.', '--ignore-pattern', 'tools/oxlint/**/tests/fixtures/**'],
    appRoot,
  );
  assert.deepEqual(
    run.diagnostics.map(
      ({ filename, labels, code }) => `${filename}:${labels[0]?.span.line} ${code}`,
    ),
    [],
  );
  assert.equal(run.exitCode, 0);
});
