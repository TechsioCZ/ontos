import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { it, expect } from 'effect-rstest';

import { appRoot, parseOxlintOutput, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const applicationRequire = createRequire(path.join(appRoot, 'package.json'));
const applicationManifest = readFileSync(path.join(appRoot, 'package.json'), 'utf-8');
const plugin = applicationRequire.resolve('eslint-plugin-perfectionist');
const oxlint = path.join(path.dirname(applicationRequire.resolve('oxlint/package.json')), 'bin/oxlint');
const configFilename = 'oxlint.json';
const cases = [
  {
    invalid: 'enum Status { Alpha = 20, Zulu = 1 }',
    options: { partitionByComment: true, sortByValue: 'always' },
    rule: 'sort-enums',
    valid: 'enum Status { Zulu = 1, Alpha = 20 }',
  },
  {
    invalid: 'interface View extends Zebra, Alpha {}',
    rule: 'sort-heritage-clauses',
    valid: 'interface View extends Alpha, Zebra {}',
  },
  {
    invalid: 'interface View { zebra: string; alpha: string }',
    rule: 'sort-interfaces',
    valid: 'interface View { alpha: string; zebra: string }',
  },
  {
    invalid: 'const view = <View zebra="" alpha="" />;',
    rule: 'sort-jsx-props',
    valid: 'const view = <View alpha="" zebra="" />;',
  },
  {
    invalid: 'type View = { zebra: string; alpha: string };',
    rule: 'sort-object-types',
    valid: 'type View = { alpha: string; zebra: string };',
  },
  {
    invalid: 'const view = { zebra: 1, alpha: 2 };',
    options: { partitionByComment: true },
    rule: 'sort-objects',
    valid: 'const view = { alpha: 2, zebra: 1 };',
  },
];

it('native sorting integration does not declare the ESLint runner', () => {
  const hasDirectEslintDependency = /^[ ]{2}"(?:dependencies|devDependencies)"\s*:\s*\{[^{}]*"eslint"\s*:/msu.test(
    applicationManifest,
  );
  expect(hasDirectEslintDependency).toBe(false);
});

it('native sorting integration runs without loading the ESLint runner', () => {
  withTemporaryWorkspace((directory) => {
    const guard = path.join(directory, 'block-eslint.mjs');
    writeFileSync(
      guard,
      `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'eslint' || specifier.startsWith('eslint/')) {
      throw new Error('Native sorting loaded the ESLint runner: ' + specifier);
    }
    return nextResolve(specifier, context);
  },
});
`,
    );
    const config = path.join(directory, configFilename);
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'perfectionist', specifier: plugin }],
        rules: { 'perfectionist/sort-objects': 'error' },
      }),
    );
    const source = path.join(directory, 'fixture.ts');
    writeFileSync(source, 'const view = { zebra: 1, alpha: 2 };');
    const result = spawnSync(
      process.execPath,
      [oxlint, '-c', config, '--format=json', '--disable-nested-config', source],
      {
        cwd: directory,
        encoding: 'utf-8',
        env: { ...process.env, NODE_OPTIONS: `--import=${guard}` },
        timeout: 120_000,
      },
    );
    if (result.error) {
      throw result.error;
    }
    const report = parseOxlintOutput(result.stdout ?? '', result.stderr ?? '', result.status);
    expect(report.exitCode).toBe(1);
    expect(report.diagnostics.some(({ code }) => code === 'perfectionist(sort-objects)')).toBeTruthy();
  });
});

for (const fixture of cases) {
  it(`Oxlint executes ${fixture.rule} positives and negatives without ESLint`, () => {
    withTemporaryWorkspace((directory) => {
      const config = path.join(directory, configFilename);
      writeFileSync(
        config,
        JSON.stringify({
          // Isolate each actual plugin rule; the application rule configuration is untouched.
          categories: { correctness: 'off' },
          jsPlugins: [{ name: 'perfectionist', specifier: plugin }],
          rules: {
            [`perfectionist/${fixture.rule}`]: ['error', fixture.options ?? {}],
          },
        }),
      );
      const source = path.join(directory, 'fixture.tsx');
      writeFileSync(source, fixture.invalid);
      const negative = runOxlint(config, [source], directory);
      expect(negative.exitCode).toBe(1);
      expect(negative.diagnostics.some(({ code }) => code === `perfectionist(${fixture.rule})`)).toBeTruthy();
      writeFileSync(source, fixture.valid);
      const positive = runOxlint(config, [source], directory);
      expect(positive.exitCode, JSON.stringify(positive.diagnostics)).toBe(0);
      expect(positive.diagnostics).toEqual([]);
    });
  });
}

it('native enum and object sorting preserves explicit comment partitions', () => {
  withTemporaryWorkspace((directory) => {
    const config = path.join(directory, configFilename);
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'perfectionist', specifier: plugin }],
        rules: {
          'perfectionist/sort-enums': ['error', { partitionByComment: true, sortByValue: 'always' }],
          'perfectionist/sort-objects': ['error', { partitionByComment: true }],
        },
      }),
    );
    const source = path.join(directory, 'fixture.ts');
    writeFileSync(
      source,
      `enum Status {
  Alpha = 20,
  // separate partition
  Zulu = 1,
}
const value = {
  zebra: 1,
  // separate partition
  alpha: 2,
};
`,
    );
    const result = runOxlint(config, [source], directory);
    expect(result.exitCode, JSON.stringify(result.diagnostics)).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });
});
