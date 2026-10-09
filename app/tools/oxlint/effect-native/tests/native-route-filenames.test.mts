import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ProductionConfigModule = Schema.Struct({
  default: Schema.Struct({
    overrides: Schema.Array(
      Schema.Struct({
        files: Schema.Array(Schema.String),
        rules: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
      }),
    ),
  }),
});
const { default: config } = Schema.decodeUnknownSync(ProductionConfigModule)(
  await import(pathToFileURL(path.join(appRoot, 'oxlint.config.ts')).href),
);
const applicationRequire = createRequire(path.join(appRoot, 'package.json'));
const namingRule = 'github/filenames-match-regex';

it('admits exact native splat filenames while retaining nearby and cross-owner naming rejections', () => {
  withTemporaryWorkspace((directory) => {
    const nativeOverride = config.overrides.find((override) =>
      override.files.includes('apps/shell-super-app/src/routes/**/*.tsx'),
    );
    expect(nativeOverride).toBeDefined();
    if (nativeOverride === undefined) {
      return;
    }
    expect(
      Schema.decodeUnknownSync(Schema.Tuple([Schema.Literal('error'), Schema.String]))(
        nativeOverride.rules[namingRule],
      )[0],
    ).toBe('error');
    const fixtureConfig = path.join(directory, 'oxlint.json');
    writeFileSync(
      fixtureConfig,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'github', specifier: applicationRequire.resolve('eslint-plugin-github/lib/plugin.js') }],
        overrides: [nativeOverride],
        rules: { [namingRule]: 'error' },
      }),
    );
    const valid = [
      'apps/shell-super-app/src/routes/[lang]/$.tsx',
      'apps/shell-super-app/src/routes/[lang]/$.data.ts',
      'apps/shell-super-app/src/routes/[lang]/$.data.client.ts',
      'apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.data.client.ts',
    ];
    const invalid = [
      'apps/shell-super-app/src/routes/[lang]/$rogue.tsx',
      'apps/shell-super-app/src/routes/[lang]/$.custom.ts',
      'apps/shell-super-app/src/routes/[lang]/page.data.custom.ts',
      'apps/another-owner/src/routes/[lang]/$.tsx',
    ];
    const files = [...valid, ...invalid];
    for (const file of files) {
      const fullPath = path.join(directory, file);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, 'export const value = 1;\n');
    }
    const run = runOxlint(fixtureConfig, files, directory);
    expect(run.numberOfFiles).toBe(files.length);
    expect(run.exitCode).toBe(1);
    expect(
      run.diagnostics
        .map(({ code, filename }) => ({ code, filename }))
        .toSorted((left, right) => left.filename.localeCompare(right.filename)),
    ).toEqual(
      invalid
        .map((filename) => ({ code: 'github(filenames-match-regex)', filename }))
        .toSorted((left, right) => left.filename.localeCompare(right.filename)),
    );
  });
});
