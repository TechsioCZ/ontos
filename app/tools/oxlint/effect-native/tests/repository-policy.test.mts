import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, pluginDirectory, runOxlint } from './oxlint.mts';

it('all repository source, including tools and root configuration, follows the Effect discrimination policy', () => {
  const run = runOxlint(
    nodePath.join(pluginDirectory, 'repository-policy.config.ts'),
    ['.', '--ignore-pattern', 'tools/oxlint/**/tests/fixtures/**'],
    appRoot,
  );
  expect(run.diagnostics.map(({ code, filename, labels }) => `${filename}:${labels[0]?.span.line} ${code}`)).toEqual(
    [],
  );
  expect(run.exitCode).toBe(0);
});
