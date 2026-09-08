import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { it, expect } from 'effect-rstest';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const applicationRequire = createRequire(path.join(appRoot, 'package.json'));
const plugin = applicationRequire.resolve('eslint-plugin-perfectionist');
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

it('native sorting integration does not resolve the ESLint runner', () => {
  expect(() => applicationRequire.resolve('eslint')).toThrow(
    /Cannot find module 'eslint'/u
  );
});

for (const fixture of cases) {
  it(`Oxlint executes ${fixture.rule} positives and negatives without ESLint`, () => {
    withTemporaryWorkspace((directory) => {
      const config = path.join(directory, 'oxlint.json');
      writeFileSync(
        config,
        JSON.stringify({
          // Isolate each actual plugin rule; the application rule configuration is untouched.
          categories: { correctness: 'off' },
          jsPlugins: [{ name: 'perfectionist', specifier: plugin }],
          rules: {
            [`perfectionist/${fixture.rule}`]: ['error', fixture.options ?? {}],
          },
        })
      );
      const source = path.join(directory, 'fixture.tsx');
      writeFileSync(source, fixture.invalid);
      const negative = runOxlint(config, [source], directory);
      expect(negative.exitCode).toBe(1);
      expect(
        negative.diagnostics.some(
          ({ code }) => code === `perfectionist(${fixture.rule})`
        )
      ).toBeTruthy();
      writeFileSync(source, fixture.valid);
      const positive = runOxlint(config, [source], directory);
      expect(positive.exitCode, JSON.stringify(positive.diagnostics)).toBe(0);
      expect(positive.diagnostics).toEqual([]);
    });
  });
}

it('native enum and object sorting preserves explicit comment partitions', () => {
  withTemporaryWorkspace((directory) => {
    const config = path.join(directory, 'oxlint.json');
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'perfectionist', specifier: plugin }],
        rules: {
          'perfectionist/sort-enums': [
            'error',
            { partitionByComment: true, sortByValue: 'always' },
          ],
          'perfectionist/sort-objects': ['error', { partitionByComment: true }],
        },
      })
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
`
    );
    const result = runOxlint(config, [source], directory);
    expect(result.exitCode, JSON.stringify(result.diagnostics)).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });
});
